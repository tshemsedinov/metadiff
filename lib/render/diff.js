'use strict';

const ansi = require('../ansi.js');
const diff = require('../diff/diff.js');
const highlight = require('../highlight.js');
const detect = require('../detect.js');
const files = require('../files.js');
const wrap = require('../wrap.js');
const primitives = require('./primitives.js');

const { displayLines } = diff;
const { detectLang } = detect;
const { itemPath } = files;
const { tokenize, overlayTokens } = highlight;
const { wrapPlain } = wrap;
const { THEME, CODE_FG, codeFg, paint, visibleWidth, truncateVisible } = ansi;
const { GUTTER_W, fill, splitWidths, paintSplitRule } = primitives;
const { paneResult, sliceVisible } = primitives;

const lineStyle = (baseFg, baseBg, chBg = baseBg, mark = ' ') => ({
  baseFg,
  baseBg,
  chBg,
  mark,
});

const STYLES = {
  del: lineStyle(THEME.delLineFg, THEME.delLineBg, THEME.delCharBg, '-'),
  add: lineStyle(THEME.addLineFg, THEME.addLineBg, THEME.addCharBg, '+'),
  warn: lineStyle(THEME.delLineFg, THEME.delLineBg, THEME.delCharBg),
  note: lineStyle(THEME.chromeFg, THEME.noteBg),
  noteSep: lineStyle(THEME.mutedFg, THEME.chromeBg),
  ctx: lineStyle(THEME.ctxFg, THEME.ctxBg),
};

const STAGED_STYLES = {
  ...STYLES,
  del: lineStyle(
    THEME.stagedDelLineFg,
    THEME.stagedDelLineBg,
    THEME.stagedDelCharBg,
    '-',
  ),
  add: lineStyle(
    THEME.stagedAddLineFg,
    THEME.stagedAddLineBg,
    THEME.stagedAddCharBg,
    '+',
  ),
  warn: lineStyle(
    THEME.stagedDelLineFg,
    THEME.stagedDelLineBg,
    THEME.stagedDelCharBg,
  ),
};

const gutterWidth = (width) => Math.min(GUTTER_W, Math.max(0, width));

const textWidth = (width) => Math.max(1, width - gutterWidth(width));

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
    const shown = drop > 0 ? sliceVisible(text, drop, Infinity) : text;
    drop = 0;
    if (shown) out.push({ ...piece, text: shown });
  }
  return out;
};

const paintSpans = (pieces, style, budget, color) => {
  let out = '';
  let used = 0;
  for (const piece of pieces) {
    if (used >= budget) break;
    const text = truncateVisible(piece.text, budget - used);
    const w = visibleWidth(text);
    if (w <= 0) continue;
    const bgRgb = piece.changed ? style.chBg : style.baseBg;
    out += paint(text, codeFg(piece.style), bgRgb, color);
    used += w;
  }
  return out + fill(budget - used, CODE_FG.plain, style.baseBg, color);
};

const paintAuditNote = (line, width, color) => {
  const { baseFg, baseBg, mark } = STYLES.note;
  const gutterW = gutterWidth(width);
  const label = `${mark} `.slice(0, gutterW);
  const budget = Math.max(0, width - gutterW);
  const text = truncateVisible(line.text ?? '', budget);
  let out = paint(label, baseFg, baseBg, color);
  out += paint(text, baseFg, baseBg, color);
  return out + fill(budget - visibleWidth(text), baseFg, baseBg, color);
};

const paintAuditRule = (width, color) => {
  const { baseFg, baseBg } = STYLES.noteSep;
  return paint('─'.repeat(Math.max(0, width)), baseFg, baseBg, color);
};

const paintDiffLine = (line, width, color, origin, lang, scrollCol = 0) => {
  if (line.type === 'noteSep') return paintAuditRule(width, color);
  if (line.type === 'note') return paintAuditNote(line, width, color);
  const styles = origin === 'staged' ? STAGED_STYLES : STYLES;
  const style = styles[line.type] ?? styles.ctx;
  const diffSpans = line.spans ?? [{ text: line.text, changed: false }];
  const tokens = tokenize(lang, line.text ?? '');
  const pieces = clipPieces(overlayTokens(tokens, diffSpans), scrollCol);
  const gutterW = gutterWidth(width);
  const label = `${line.mark ?? style.mark} `.slice(0, gutterW);
  const gutter = paint(label, CODE_FG.punct, style.baseBg, color);
  const budget = Math.max(0, width - gutterW);
  return gutter + paintSpans(pieces, style, budget, color);
};

const paintSplitRow = (row, width, color, origin, lang, scrollCol) => {
  const { leftW, rightW } = splitWidths(width);
  const half = (line, halfW) => {
    if (!line) return fill(halfW, THEME.ctxFg, THEME.ctxBg, color);
    return paintDiffLine(line, halfW, color, origin, lang, scrollCol);
  };
  const left = half(row.left, leftW);
  const right = half(row.right, rightW);
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

const rowEmpty = (row, split) => {
  if (!split) return sourceEmpty(row);
  return sourceEmpty(row.left) && sourceEmpty(row.right);
};

const dropLeadingEmpty = (lines, split) => {
  const at = lines.findIndex((row) => !rowEmpty(row, split));
  if (at < 0) return [];
  return at ? lines.slice(at) : lines;
};

const cutSpans = (spans, count) => {
  const taken = [];
  const rest = [];
  let left = count;
  for (const span of spans) {
    const text = span.text ?? '';
    if (left <= 0) {
      rest.push(span);
    } else if (text.length <= left) {
      taken.push(span);
      left -= text.length;
    } else {
      const changed = span.changed === true;
      taken.push({ text: text.slice(0, left), changed });
      rest.push({ text: text.slice(left), changed });
      left = 0;
    }
  }
  return { taken, rest };
};

const wrapSoftLine = (line, width) => {
  const rows = wrapPlain(line.text ?? '', textWidth(width));
  const changed = line.wrap === true;
  let used = 0;
  let spans = line.spans ?? [{ text: line.text ?? '', changed }];
  return rows.map((text, index) => {
    const last = index === rows.length - 1;
    const cut = cutSpans(spans, text.length);
    spans = cut.rest;
    const nextSpans = cut.taken.length ? cut.taken : [{ text, changed }];
    const next = { ...line, text, spans: nextSpans, editLast: last };
    if (line.editStart !== undefined) {
      next.editStart = line.editStart + used;
      next.editEnd = last ? line.editEnd : next.editStart + text.length;
    }
    used += text.length;
    return next;
  });
};

const expandSoftRows = (lines, width, split, wrapView) => {
  const { leftW, rightW } = splitWidths(width);
  const partsOf = (line, lineW) => {
    if (!wrapView || !line || line.type === 'noteSep') return [line];
    if (visibleWidth(line.text ?? '') <= textWidth(lineW)) return [line];
    return wrapSoftLine(line, lineW);
  };
  if (!split) return lines.flatMap((line) => partsOf(line, width));
  const out = [];
  for (const row of lines) {
    const leftParts = partsOf(row.left, leftW);
    const rightParts = partsOf(row.right, rightW);
    const n = Math.max(leftParts.length, rightParts.length);
    for (let i = 0; i < n; i++) {
      out.push({ left: leftParts[i] ?? null, right: rightParts[i] ?? null });
    }
  }
  return out;
};

const codeHits = (rows, split, width, overlay, editing, scrollCol) => {
  const { leftW, rightW } = splitWidths(width);
  const lineW = split ? rightW : width;
  const x0 = split ? leftW + 1 : 0;
  const textX = x0 + gutterWidth(lineW) + 1;
  const at = overlay ? overlay.cursor : null;
  const hasCursor = at !== null && at !== undefined;
  const editHits = [];
  let cursor = null;
  for (let row = 0; row < rows.length; row++) {
    const line = split ? rows[row].right : rows[row];
    if (!line || line.editStart === undefined) continue;
    if (editing) {
      editHits.push({
        row,
        x0: x0 + 1,
        textX,
        x1: x0 + lineW + 1,
        scroll: scrollCol,
        start: line.editStart,
        text: line.text ?? '',
        limit: line.editEnd,
        live: true,
      });
    }
    if (cursor || !hasCursor) continue;
    const onPiece = at >= line.editStart && at <= line.editEnd;
    if (!onPiece) continue;
    const take = Math.min(at - line.editStart, line.text.length);
    const col = visibleWidth(line.text.slice(0, take));
    cursor = { x: textX + Math.max(0, col - scrollCol), row };
  }
  return { cursor, editHits };
};

const codeInnerWidth = (width, layout = 'unified') =>
  textWidth(layout === 'side' ? splitWidths(width).rightW : width);

const paintBodyDiff = (view, width, color) => {
  const { item, codeOverlay: overlay } = view;
  const layout = view.layout ?? 'unified';
  const lang = detectLang(itemPath(item));
  const splitBody = layout === 'side' && !item.file.isBinary;
  const editing = typeof overlay?.cursor === 'number';
  const scrollCol = (editing ? overlay.scrollCol : 0) ?? 0;
  const raw = dropLeadingEmpty(bodyLines(item, layout, overlay), splitBody);
  const lines = expandSoftRows(raw, width, splitBody, !editing);
  const paintRow = splitBody ? paintSplitRow : paintDiffLine;
  const body = lines.map((line) =>
    paintRow(line, width, color, item.origin, lang, scrollCol),
  );
  const hits = codeHits(lines, splitBody, width, overlay, editing, scrollCol);
  return paneResult({ body, splitBody, ...hits });
};

module.exports = {
  paintDiffLine,
  codeInnerWidth,
  paintBodyDiff,
  expandSoftRows,
  codeHits,
};
