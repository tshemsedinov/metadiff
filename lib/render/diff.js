'use strict';

const ansi = require('../ansi.js');
const diff = require('../diff/diff.js');
const { displayLines } = diff;
const highlight = require('../highlight.js');
const detect = require('../detect.js');
const { detectLang } = detect;
const files = require('../files.js');
const wrap = require('../wrap.js');
const primitives = require('./primitives.js');

const { itemPath } = files;
const { tokenize, overlayTokens } = highlight;
const { wrapPlain } = wrap;
const { THEME, CODE_FG, codeFg, paint, visibleWidth } = ansi;
const { truncateVisible, graphemes, graphemeWidth } = ansi;
const { GUTTER_W, fill, splitWidths, paintSplitRule, paneResult } = primitives;

const STYLES = {
  del: {
    baseFg: THEME.delLineFg,
    baseBg: THEME.delLineBg,
    chBg: THEME.delCharBg,
    mark: '-',
  },
  add: {
    baseFg: THEME.addLineFg,
    baseBg: THEME.addLineBg,
    chBg: THEME.addCharBg,
    mark: '+',
  },
  warn: {
    baseFg: THEME.delLineFg,
    baseBg: THEME.delLineBg,
    chBg: THEME.delCharBg,
    mark: ' ',
  },
  note: {
    baseFg: THEME.chromeFg,
    baseBg: THEME.noteBg,
    chBg: THEME.noteBg,
    mark: ' ',
  },
  noteSep: {
    baseFg: THEME.mutedFg,
    baseBg: THEME.chromeBg,
    chBg: THEME.chromeBg,
    mark: ' ',
  },
  ctx: {
    baseFg: THEME.ctxFg,
    baseBg: THEME.ctxBg,
    chBg: THEME.ctxBg,
    mark: ' ',
  },
};

const STAGED_STYLES = {
  del: {
    baseFg: THEME.stagedDelLineFg,
    baseBg: THEME.stagedDelLineBg,
    chBg: THEME.stagedDelCharBg,
    mark: '-',
  },
  add: {
    baseFg: THEME.stagedAddLineFg,
    baseBg: THEME.stagedAddLineBg,
    chBg: THEME.stagedAddCharBg,
    mark: '+',
  },
  warn: {
    baseFg: THEME.stagedDelLineFg,
    baseBg: THEME.stagedDelLineBg,
    chBg: THEME.stagedDelCharBg,
    mark: ' ',
  },
  note: STYLES.note,
  noteSep: STYLES.noteSep,
  ctx: STYLES.ctx,
};

const delCharBg = () => ansi.bg(THEME.delCharBg);
const addCharBg = () => ansi.bg(THEME.addCharBg);

const skipText = (text, skip) => {
  if (skip <= 0) return text ?? '';
  const parts = graphemes(text ?? '');
  let used = 0;
  let i = 0;
  while (i < parts.length) {
    const w = graphemeWidth(parts[i], used);
    if (used + w > skip) break;
    used += w;
    i += 1;
  }
  let out = '';
  for (; i < parts.length; i++) out += parts[i];
  return out;
};

const clipPieces = (pieces, skip) => {
  if (skip <= 0) return pieces;
  const out = [];
  let drop = skip;
  for (const piece of pieces) {
    const text = piece.text ?? '';
    const width = visibleWidth(text);
    if (drop >= width) {
      drop -= width;
      continue;
    }
    const shown = drop > 0 ? skipText(text, drop) : text;
    drop = 0;
    if (shown) out.push({ ...piece, text: shown });
  }
  return out;
};

const paintSpans = (pieces, lineStyle, budget, color) => {
  let out = '';
  let used = 0;
  for (const piece of pieces) {
    if (used >= budget) break;
    const room = budget - used;
    const text = truncateVisible(piece.text, room);
    const w = visibleWidth(text);
    if (w <= 0) continue;
    const fgRgb = codeFg(piece.style);
    const bgRgb = piece.changed ? lineStyle.chBg : lineStyle.baseBg;
    out += paint(text, fgRgb, bgRgb, color);
    used += w;
  }
  if (used < budget) {
    out += fill(budget - used, CODE_FG.plain, lineStyle.baseBg, color);
  }
  return out;
};

const paintAuditNote = (line, width, color) => {
  const style = STYLES.note;
  const gutterW = Math.min(GUTTER_W, Math.max(0, width));
  const label = `${style.mark} `.slice(0, gutterW);
  const gutter = paint(label, style.baseFg, style.baseBg, color);
  const budget = Math.max(0, width - gutterW);
  const text = truncateVisible(line.text ?? '', budget);
  const used = visibleWidth(text);
  let out = gutter;
  if (text) out += paint(text, style.baseFg, style.baseBg, color);
  if (used < budget) {
    out += fill(budget - used, style.baseFg, style.baseBg, color);
  }
  return out;
};

const paintAuditRule = (width, color) => {
  const style = STYLES.noteSep;
  const n = Math.max(0, width);
  const bar = '─'.repeat(n);
  return paint(bar, style.baseFg, style.baseBg, color);
};

const paintDiffLine = (line, width, color, origin, lang, scrollCol = 0) => {
  if (line.type === 'noteSep') return paintAuditRule(width, color);
  if (line.type === 'note') return paintAuditNote(line, width, color);
  const styles = origin === 'staged' ? STAGED_STYLES : STYLES;
  const style = styles[line.type] ?? styles.ctx;
  const diffSpans = line.spans ?? [{ text: line.text, changed: false }];
  const tokens = tokenize(lang, line.text ?? '');
  const pieces = clipPieces(overlayTokens(tokens, diffSpans), scrollCol);
  const gutterW = Math.min(GUTTER_W, Math.max(0, width));
  const label = `${line.mark ?? style.mark} `.slice(0, gutterW);
  const gutter = paint(label, CODE_FG.punct, style.baseBg, color);
  const budget = Math.max(0, width - gutterW);
  const rest = paintSpans(pieces, style, budget, color);
  return gutter + rest;
};

const paintSplitHalf = (line, width, color, origin, lang, scrollCol) => {
  if (!line || width <= 0) {
    return fill(width, THEME.ctxFg, THEME.ctxBg, color);
  }
  return paintDiffLine(line, width, color, origin, lang, scrollCol);
};

const paintSplitRow = (row, width, color, origin, lang, scrollCol) => {
  const { leftW, rightW } = splitWidths(width);
  const left = paintSplitHalf(row.left, leftW, color, origin, lang, scrollCol);
  const right = paintSplitHalf(
    row.right,
    rightW,
    color,
    origin,
    lang,
    scrollCol,
  );
  return `${left}${paintSplitRule(color)}${right}`;
};

const bodyLines = (item, layout, overlay) => {
  if (item.file.isBinary) {
    const text = '(binary)';
    return [{ type: 'ctx', text, spans: [{ text, changed: false }] }];
  }
  if (!item.hunk) return [];
  const radius = item.dep ? Number.MAX_SAFE_INTEGER : undefined;
  return displayLines(item.hunk, item.blockId, layout, radius, overlay);
};

const sourceEmpty = (line) => {
  if (!line) return true;
  if (line.editStart !== undefined) return false;
  return !(line.text ?? '').trim();
};

const displayRowEmpty = (row, split) => {
  if (!split) return sourceEmpty(row);
  return sourceEmpty(row.left) && sourceEmpty(row.right);
};

const dropLeadingEmpty = (lines, split) => {
  let i = 0;
  while (i < lines.length && displayRowEmpty(lines[i], split)) {
    i += 1;
  }
  return i ? lines.slice(i) : lines;
};

const cutSpans = (spans, count) => {
  const taken = [];
  const rest = [];
  let left = count;
  let i = 0;
  while (i < spans.length) {
    const span = spans[i];
    const text = span.text ?? '';
    if (left <= 0) {
      rest.push(span);
      i += 1;
      continue;
    }
    if (text.length <= left) {
      taken.push(span);
      left -= text.length;
      i += 1;
      continue;
    }
    const changed = span.changed === true;
    taken.push({ text: text.slice(0, left), changed });
    rest.push({ text: text.slice(left), changed });
    left = 0;
    i += 1;
  }
  return { taken, rest };
};

const wrapSoftLine = (line, width) => {
  const gutterW = Math.min(GUTTER_W, Math.max(0, width));
  const budget = Math.max(1, width - gutterW);
  const rows = wrapPlain(line.text ?? '', budget);
  const changed = line.wrap === true;
  const { length } = rows;
  const pieces = new Array(length);
  let used = 0;
  let spans = line.spans ?? [{ text: line.text ?? '', changed }];
  for (let i = 0; i < length; i++) {
    const text = rows[i];
    const last = i === length - 1;
    const cut = cutSpans(spans, text.length);
    spans = cut.rest;
    const nextSpans = cut.taken.length ? cut.taken : [{ text, changed }];
    const next = { ...line, text, spans: nextSpans, editLast: last };
    if (line.editStart !== undefined) {
      next.editStart = line.editStart + used;
      if (last) next.editEnd = line.editEnd;
      else next.editEnd = next.editStart + text.length;
    }
    used += text.length;
    pieces[i] = next;
  }
  return pieces;
};

const expandSoftRows = (lines, width, split, wrapView) => {
  const { leftW, rightW } = splitWidths(width);
  const out = [];
  const partsOf = (line, lineW) => {
    if (!wrapView || !line || line.type === 'noteSep') return [line];
    const gutterW = Math.min(GUTTER_W, Math.max(0, lineW));
    const budget = Math.max(1, lineW - gutterW);
    if (visibleWidth(line.text ?? '') <= budget) return [line];
    return wrapSoftLine(line, lineW);
  };
  for (const row of lines) {
    if (!split) {
      for (const part of partsOf(row, width)) out.push(part);
      continue;
    }
    const leftParts = partsOf(row.left, leftW);
    const rightParts = partsOf(row.right, rightW);
    const n = Math.max(leftParts.length, rightParts.length);
    for (let i = 0; i < n; i++) {
      out.push({
        left: leftParts[i] ?? null,
        right: rightParts[i] ?? null,
      });
    }
  }
  return out;
};

const onCodePiece = (line, cursor) => {
  if (!line || line.editStart === undefined) return false;
  if (cursor < line.editStart) return false;
  return cursor <= line.editEnd;
};

const codeCursorInRows = (rows, split, width, cursor, scrollCol = 0) => {
  if (cursor === undefined || cursor === null) return null;
  const { leftW, rightW } = splitWidths(width);
  for (let i = 0; i < rows.length; i++) {
    const line = split ? rows[i].right : rows[i];
    if (!onCodePiece(line, cursor)) continue;
    const lineW = split ? rightW : width;
    const gutterW = Math.min(GUTTER_W, Math.max(0, lineW));
    const take = Math.min(cursor - line.editStart, line.text.length);
    const col = visibleWidth(line.text.slice(0, take));
    const shown = Math.max(0, col - scrollCol);
    const x0 = split ? leftW + 1 : 0;
    return { x: x0 + gutterW + shown + 1, row: i };
  }
  return null;
};

const codeInnerWidth = (width, layout = 'unified') => {
  const lineW = layout === 'side' ? splitWidths(width).rightW : width;
  const gutterW = Math.min(GUTTER_W, Math.max(0, lineW));
  return Math.max(1, lineW - gutterW);
};

const paintBodyDiff = (view, width, color) => {
  const item = view.item;
  const layout = view.layout ?? 'unified';
  const overlay = view.codeOverlay;
  const lang = detectLang(itemPath(item));
  const splitBody = layout === 'side' && !item.file.isBinary;
  const editing = Boolean(overlay && typeof overlay.cursor === 'number');
  const picked = editing ? overlay.scrollCol : 0;
  const scrollCol = picked ?? 0;
  const raw = dropLeadingEmpty(bodyLines(item, layout, overlay), splitBody);
  const lines = expandSoftRows(raw, width, splitBody, !editing);
  const { length } = lines;
  const body = new Array(length);
  if (splitBody) {
    for (let i = 0; i < length; i++) {
      body[i] = paintSplitRow(
        lines[i],
        width,
        color,
        item.origin,
        lang,
        scrollCol,
      );
    }
  } else {
    for (let i = 0; i < length; i++) {
      body[i] = paintDiffLine(
        lines[i],
        width,
        color,
        item.origin,
        lang,
        scrollCol,
      );
    }
  }
  const edit = overlay ? overlay.cursor : null;
  const cursor = codeCursorInRows(lines, splitBody, width, edit, scrollCol);
  return paneResult({ body, cursor, splitBody });
};

module.exports = {
  delCharBg,
  addCharBg,
  paintDiffLine,
  codeInnerWidth,
  paintBodyDiff,
  codeCursorInRows,
  expandSoftRows,
};
