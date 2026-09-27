'use strict';

const ansi = require('../ansi.js');
const actions = require('../session/actions.js');
const { LIST_PANES } = actions;

const { THEME, paint, visibleWidth, truncateVisible, seq, EL, RESET } = ansi;

const GUTTER_W = 2;
const FILE_MARK = '▶';
const FILE_LIST_PAD = 1;
const CHECK_DONE = 'xX';
const CHECK_TOKEN = /\[([ xX])\]/;
const CHECK_LEAD = /^\[[ xX]\] /;

const fill = (width, fgRgb, bgRgb, color) =>
  paint(' '.repeat(Math.max(0, width)), fgRgb, bgRgb, color);

const paintBar = (text, width, fgRgb, bgRgb, color) => {
  const clipped = truncateVisible(text, width);
  const pad = Math.max(0, width - visibleWidth(clipped));
  const filled = clipped + ' '.repeat(pad);
  if (!color) return filled;
  return `${seq(fgRgb, bgRgb)}${EL}${filled}${RESET}`;
};

const splitCheck = (text) => {
  const match = CHECK_TOKEN.exec(text);
  if (!match) return null;
  const start = match.index;
  const token = match[0];
  const before = text.slice(0, start);
  const mark = match[1];
  const after = text.slice(start + token.length);
  return { before, mark, token, after };
};

const paintCheckBar = (text, width, fgRgb, bgRgb, color) => {
  const clipped = truncateVisible(text, width);
  const parts = color ? splitCheck(clipped) : null;
  if (!parts) return paintBar(text, width, fgRgb, bgRgb, color);
  const pad = Math.max(0, width - visibleWidth(clipped));
  const done = CHECK_DONE.includes(parts.mark);
  const chipFg = done ? THEME.checkDoneFg : THEME.checkFg;
  const chipBg = done ? THEME.checkDoneBg : THEME.checkBg;
  const after = `${parts.after}${' '.repeat(pad)}`;
  let out = `${seq(fgRgb, bgRgb)}${EL}`;
  if (parts.before) out += paint(parts.before, fgRgb, bgRgb, color);
  out += paint(parts.token, chipFg, chipBg, color);
  if (after) out += paint(after, fgRgb, bgRgb, color);
  return out;
};

const padVisible = (text, width, align) => {
  const n = Math.max(0, width - visibleWidth(text));
  const gap = ' '.repeat(n);
  if (align === 'end') return `${text}${gap}`;
  return `${gap}${text}`;
};

const splitWidths = (width) => {
  const inner = Math.max(0, width - 1);
  const leftW = Math.floor(inner / 2);
  return { leftW, rightW: inner - leftW };
};

const paintSplitRule = (color) =>
  fill(1, THEME.splitGutterFg, THEME.splitGutterBg, color);

const paintSplitBlank = (width, color) => {
  const { leftW, rightW } = splitWidths(width);
  return (
    fill(leftW, THEME.ctxFg, THEME.ctxBg, color) +
    paintSplitRule(color) +
    fill(rightW, THEME.ctxFg, THEME.ctxBg, color)
  );
};

const paintBodyFill = (width, color, kind) => {
  if (kind === 'files') {
    const inner = Math.max(1, width - 1);
    const main = fill(inner, THEME.ctxFg, THEME.ctxBg, color);
    const edge = fill(1, THEME.ctxFg, THEME.ctxBg, color);
    return main + edge;
  }
  if (kind === 'split') return paintSplitBlank(width, color);
  return fill(width, THEME.ctxFg, THEME.ctxBg, color);
};

const windowRows = (rows, focus, cap) => {
  if (rows.length <= cap) return { rows, offset: 0 };
  let start = focus - cap + 1;
  if (start < 0) start = 0;
  if (start + cap > rows.length) start = rows.length - cap;
  return { rows: rows.slice(start, start + cap), offset: start };
};

const listWindowStart = (focus, offset, listH, count) => {
  let start = offset ?? 0;
  if (focus < start) start = focus;
  if (focus >= start + listH) start = focus - listH + 1;
  const maxStart = Math.max(0, count - listH);
  if (start > maxStart) start = maxStart;
  if (start < 0) start = 0;
  return start;
};

const extraIdx = (extraRow, cursor, count) => {
  if (!extraRow) return -1;
  if (extraRow.at === 'start') return 0;
  if (extraRow.at === 'replace') return extraRow.index ?? cursor;
  return count;
};

const paneResult = (fields = {}) => ({
  body: fields.body ?? [],
  fileHits: fields.fileHits ?? [],
  todoOwners: fields.todoOwners ?? [],
  todoChecks: fields.todoChecks ?? [],
  cursor: fields.cursor ?? null,
  splitBody: fields.splitBody === true,
  listScroll: fields.listScroll ?? 0,
});

const paintCursorList = (
  items,
  cursor,
  width,
  color,
  bodyH,
  headerLines,
  paintRow,
  extraRow,
  offset = 0,
) => {
  const pad = bodyH >= FILE_LIST_PAD * 2 + 1 ? FILE_LIST_PAD : 0;
  const listH = bodyH - pad * 2;
  const inserting = extraRow && extraRow.at === 'start';
  const extra = extraRow && extraRow.at !== 'replace' ? 1 : 0;
  const count = items.length + extra;
  const extraAt = extraIdx(extraRow, cursor, items.length);
  const focus = extraRow ? extraAt : cursor;
  const start = listWindowStart(focus, offset, listH, count);
  const blank = paintBodyFill(width, color, 'files');
  const body = [];
  const fileHits = [];
  let textCursor = null;
  if (pad) body.push(blank);
  for (let i = 0; i < listH; i++) {
    const idx = start + i;
    if (extraRow && idx === extraAt) {
      body.push(extraRow.row);
      if (extraRow.cursor) {
        textCursor = { x: extraRow.cursor.x, row: body.length - 1 };
      }
      continue;
    }
    const itemIdx = inserting ? idx - 1 : idx;
    const entry = items[itemIdx];
    if (!entry) break;
    const selected = extraRow ? false : itemIdx === cursor;
    body.push(paintRow(entry, width, color, selected));
    const y = headerLines + pad + i + 1;
    fileHits.push({ y, cursor: itemIdx });
  }
  if (pad) body.push(blank);
  return paneResult({
    body,
    fileHits,
    cursor: textCursor,
    listScroll: start,
  });
};

const branchLabel = (name) => `${name ?? ''}`.trim();

const paintListEdit = (compose, width, color, edgeW = 0) => {
  const inner = Math.max(1, width - edgeW);
  const prefix = ` ${FILE_MARK} `;
  const prefixW = visibleWidth(prefix);
  const rest = Math.max(1, inner - prefixW);
  const text = `${compose.text ?? ''}`.replaceAll('\n', ' ');
  const clipped = truncateVisible(text, rest);
  const pad = Math.max(0, rest - visibleWidth(clipped));
  const left = `${prefix}${clipped}${' '.repeat(pad)}`;
  const fgRgb = THEME.chromeFg;
  const bgRgb = THEME.buttonBg;
  const edge = fill(edgeW, fgRgb, THEME.ctxBg, color);
  let row = `${left}${edge}`;
  if (color) {
    const gap = ' '.repeat(pad);
    row = `${seq(fgRgb, bgRgb)}${EL}`;
    row += paint(prefix, fgRgb, bgRgb, color);
    row += paint(clipped, THEME.buttonHotFg, bgRgb, color);
    row += paint(gap, fgRgb, bgRgb, color);
    row += edge;
  }
  const col = Math.min(compose.cursor ?? 0, visibleWidth(clipped));
  return { row, cursor: { x: prefixW + col + 1 } };
};

const measureColumns = (entries, rowFields, align) => {
  const keys = Object.keys(align);
  const widths = Object.fromEntries(keys.map((key) => [key, 0]));
  for (const entry of entries) {
    const fields = rowFields(entry);
    for (const key of keys) {
      widths[key] = Math.max(widths[key], visibleWidth(fields[key]));
    }
  }
  return widths;
};

const padColumns = (fields, widths, align) => {
  const parts = {};
  for (const key of Object.keys(align)) {
    const width = widths?.[key] ?? visibleWidth(fields[key]);
    parts[key] = padVisible(fields[key], width, align[key]);
  }
  return parts;
};

const columnGap = (key) => (key === 'date' ? '   ' : '  ');

const joinColumns = (parts, widths) => {
  let text = '';
  for (const key of Object.keys(parts)) {
    if (widths[key]) text += columnGap(key) + parts[key];
  }
  return text;
};

const paintColumns = (parts, widths, fgRgb, bgRgb, color, tones) => {
  let text = '';
  for (const key of Object.keys(parts)) {
    if (!widths[key]) continue;
    text += paint(columnGap(key), fgRgb, bgRgb, color);
    text += paint(parts[key], tones[key] ?? fgRgb, bgRgb, color);
  }
  return text;
};

module.exports = {
  measureColumns,
  padColumns,
  joinColumns,
  paintColumns,
  GUTTER_W,
  FILE_MARK,
  LIST_PANES,
  CHECK_LEAD,
  fill,
  paintBar,
  paintCheckBar,
  padVisible,
  splitWidths,
  paintSplitRule,
  paintBodyFill,
  windowRows,
  listWindowStart,
  paintCursorList,
  paintListEdit,
  branchLabel,
  paneResult,
};
