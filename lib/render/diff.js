'use strict';

const { clamp } = require('../common/utilities.js');
const ansi = require('../term/ansi.js');
const { displayLines } = require('../diff/diff.js');
const highlight = require('../highlight/highlight.js');
const { tokenize, overlayTokens, detectLang } = highlight;
const { itemPath } = require('../common/files.js');
const { wrapPlain } = require('../term/wrap.js');
const primitives = require('./primitives.js');

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

const numberCols = (digits) => (digits > 0 ? digits + 1 : 0);

const paintNumberFill = (width, color, digits, split) => {
  const half = (lineW) => {
    const cols = clamp(lineW, 0, numberCols(digits));
    const rest = Math.max(0, lineW - cols);
    const gutter = fill(cols, THEME.lineNoFg, THEME.lineNoBg, color);
    const code = fill(rest, THEME.ctxFg, THEME.ctxBg, color);
    return gutter + code;
  };
  if (!split) return half(width);
  const { leftW, rightW } = splitWidths(width);
  const rule = paintSplitRule(color);
  return half(leftW) + rule + half(rightW);
};

const gutterWidth = (width, digits = 0) => {
  const want = GUTTER_W + numberCols(digits);
  return Math.min(want, Math.max(0, width));
};

const textWidth = (width, digits = 0) =>
  Math.max(1, width - gutterWidth(width, digits));

const digitsForMax = (max) => {
  const n = Math.max(1, max || 1);
  return Math.max(2, String(n).length);
};

const hunkDigits = (hunk) => {
  if (!hunk) return digitsForMax(1);
  const end = (start, count) => {
    if (!start || start < 1) return 0;
    return start + Math.max(count || 1, 1) - 1;
  };
  const oldEnd = end(hunk.oldStart, hunk.oldCount);
  const newEnd = end(hunk.newStart, hunk.newCount);
  return digitsForMax(Math.max(oldEnd, newEnd, 1));
};

const overlayDigits = (view, hunk, fromHunk) => {
  const text = view.codeOverlay && view.codeOverlay.text;
  if (typeof text !== 'string') return fromHunk;
  const count = text ? text.split('\n').length : 1;
  const start = hunk && hunk.newStart > 0 ? hunk.newStart : 1;
  return Math.max(fromHunk, digitsForMax(start + count - 1));
};

const viewDigits = (view) => {
  if (!view || view.lineNumbers !== true) return 0;
  if (view.pane === 'unit') {
    let max = 1;
    for (const line of view.unitLines ?? []) {
      max = Math.max(max, line.newNo || 0);
    }
    return digitsForMax(max);
  }
  const hunk = view.item && view.item.hunk;
  return overlayDigits(view, hunk, hunkDigits(hunk));
};

const activeDigits = (ui) => {
  if (!ui || ui.lineNumbers !== true) return 0;
  if (typeof ui.view !== 'function') return 0;
  return viewDigits(ui.view());
};

const lineNumber = (line, side) => {
  if (!line) return 0;
  if (side === 'left') return line.oldNo || 0;
  if (side === 'right') return line.newNo || 0;
  if (line.type === 'del') return line.oldNo || 0;
  return line.newNo || 0;
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

const paintNumber = (line, digits, side, color) => {
  if (!digits) return '';
  const value = lineNumber(line, side);
  const label = value ? String(value) : '';
  const text = `${label.padStart(digits, ' ')} `;
  return paint(text, THEME.lineNoFg, THEME.lineNoBg, color);
};

const paintAuditNote = (line, width, color, digits = 0) => {
  const { baseFg, baseBg, mark } = STYLES.note;
  const gutterW = gutterWidth(width, digits);
  const numbers = paintNumber(line, digits, '', color);
  const markW = Math.max(0, gutterW - numberCols(digits));
  const label = `${mark} `.slice(0, markW);
  const budget = Math.max(0, width - gutterW);
  const text = truncateVisible(line.text ?? '', budget);
  let out = numbers + paint(label, baseFg, baseBg, color);
  out += paint(text, baseFg, baseBg, color);
  return out + fill(budget - visibleWidth(text), baseFg, baseBg, color);
};

const paintAuditRule = (width, color, digits = 0) => {
  const { baseFg, baseBg } = STYLES.noteSep;
  const cols = clamp(width, 0, numberCols(digits));
  const gutter = fill(cols, THEME.lineNoFg, THEME.lineNoBg, color);
  const rule = '─'.repeat(Math.max(0, width - cols));
  return gutter + paint(rule, baseFg, baseBg, color);
};

const paintDiffLine = (
  line,
  width,
  color,
  origin,
  lang,
  scrollCol = 0,
  digits = 0,
  side = '',
) => {
  if (line.type === 'noteSep') return paintAuditRule(width, color, digits);
  if (line.type === 'note') return paintAuditNote(line, width, color, digits);
  const styles = origin === 'staged' ? STAGED_STYLES : STYLES;
  const style = styles[line.type] ?? styles.ctx;
  const diffSpans = line.spans ?? [{ text: line.text, changed: false }];
  const tokens = tokenize(lang, line.text ?? '');
  const pieces = clipPieces(overlayTokens(tokens, diffSpans), scrollCol);
  const gutterW = gutterWidth(width, digits);
  const numbers = paintNumber(line, digits, side, color);
  const markW = Math.max(0, gutterW - numberCols(digits));
  const label = `${line.mark ?? style.mark} `.slice(0, markW);
  const gutter = paint(label, CODE_FG.punct, style.baseBg, color);
  const budget = Math.max(0, width - gutterW);
  return numbers + gutter + paintSpans(pieces, style, budget, color);
};

const emptySide = () => ({
  type: 'ctx',
  text: '',
  spans: [{ text: '', changed: false }],
});

const paintSplitRow = (row, width, color, origin, lang, scrollCol, digits) => {
  const { leftW, rightW } = splitWidths(width);
  const half = (line, halfW, side) => {
    const shown = line || (digits ? emptySide() : null);
    if (!shown) return fill(halfW, THEME.ctxFg, THEME.ctxBg, color);
    return paintDiffLine(
      shown,
      halfW,
      color,
      origin,
      lang,
      scrollCol,
      digits,
      side,
    );
  };
  const left = half(row.left, leftW, 'left');
  const right = half(row.right, rightW, 'right');
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

const wrapSoftLine = (line, width, digits = 0) => {
  const rows = wrapPlain(line.text ?? '', textWidth(width, digits));
  const changed = line.wrap === true;
  let used = 0;
  let spans = line.spans ?? [{ text: line.text ?? '', changed }];
  return rows.map((text, index) => {
    const last = index === rows.length - 1;
    const cut = cutSpans(spans, text.length);
    spans = cut.rest;
    const nextSpans = cut.taken.length ? cut.taken : [{ text, changed }];
    const next = { ...line, text, spans: nextSpans, editLast: last };
    if (index > 0) {
      next.oldNo = 0;
      next.newNo = 0;
    }
    if (line.editStart !== undefined) {
      next.editStart = line.editStart + used;
      next.editEnd = last ? line.editEnd : next.editStart + text.length;
    }
    used += text.length;
    return next;
  });
};

const expandSoftRows = (lines, width, split, wrapView, digits = 0) => {
  const { leftW, rightW } = splitWidths(width);
  const partsOf = (line, lineW) => {
    if (!wrapView || !line || line.type === 'noteSep') return [line];
    const fits = visibleWidth(line.text ?? '') <= textWidth(lineW, digits);
    if (fits) return [line];
    return wrapSoftLine(line, lineW, digits);
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

const codeHits = (rows, split, width, overlay, editing, scrollCol, digits) => {
  const { leftW, rightW } = splitWidths(width);
  const lineW = split ? rightW : width;
  const x0 = split ? leftW + 1 : 0;
  const textX = x0 + gutterWidth(lineW, digits) + 1;
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

const codeInnerWidth = (width, layout = 'unified', digits = 0) => {
  const lineW = layout === 'side' ? splitWidths(width).rightW : width;
  return textWidth(lineW, digits);
};

const paintBodyDiff = (view, width, color) => {
  const { item, codeOverlay: overlay } = view;
  const layout = view.layout ?? 'unified';
  const lang = detectLang(itemPath(item));
  const splitBody = layout === 'side' && !item.file.isBinary;
  const editing = typeof overlay?.cursor === 'number';
  const scrollCol = (editing ? overlay.scrollCol : 0) ?? 0;
  const raw = dropLeadingEmpty(bodyLines(item, layout, overlay), splitBody);
  const digits = viewDigits(view);
  const lines = expandSoftRows(raw, width, splitBody, !editing, digits);
  const paintRow = splitBody ? paintSplitRow : paintDiffLine;
  const body = lines.map((line) =>
    paintRow(line, width, color, item.origin, lang, scrollCol, digits),
  );
  const hits = codeHits(
    lines,
    splitBody,
    width,
    overlay,
    editing,
    scrollCol,
    digits,
  );
  return paneResult({ body, splitBody, ...hits });
};

module.exports = {
  paintDiffLine,
  codeInnerWidth,
  activeDigits,
  viewDigits,
  paintNumberFill,
  paintBodyDiff,
  expandSoftRows,
  codeHits,
};
