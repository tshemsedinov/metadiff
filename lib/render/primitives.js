'use strict';

const ansi = require('../ansi.js');
const actions = require('../session/actions.js');
const { LIST_PANES } = actions;

const { THEME, paint, visibleWidth, truncateVisible, seq, EL, RESET } = ansi;
const { graphemes, graphemeWidth } = ansi;

const GUTTER_W = 2;
const FILE_MARK = '▶';
const LIST_PAD = 1;
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

const paintCheckBar = (text, width, fgRgb, bgRgb, color, plain = false) => {
  const clipped = truncateVisible(text, width);
  const parts = color ? splitCheck(clipped) : null;
  if (!parts) return paintBar(text, width, fgRgb, bgRgb, color);
  const pad = Math.max(0, width - visibleWidth(clipped));
  const done = CHECK_DONE.includes(parts.mark);
  let chipFg = THEME.checkFg;
  let chipBg = THEME.checkBg;
  if (plain) {
    chipFg = fgRgb;
    chipBg = bgRgb;
  } else if (done) {
    chipFg = THEME.checkDoneFg;
    chipBg = THEME.checkDoneBg;
  }
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
  editHits: fields.editHits ?? [],
});

const NO_EDITS = [];

const listLine = (row, index, cursor = null, edits = NO_EDITS) => {
  const hit = index >= 0;
  return { row, index, hit, cursor, edits };
};

const rowCursor = (cursor, row) => {
  const out = { x: cursor.x, row };
  if (typeof cursor.scroll === 'number') out.scroll = cursor.scroll;
  return out;
};

const paintListWindow = (count, focus, pane, lineAt) => {
  const { width, color, bodyH, headerLines, offset } = pane;
  const pad = bodyH >= LIST_PAD * 2 + 1 ? LIST_PAD : 0;
  const listH = bodyH - pad * 2;
  const start = listWindowStart(focus, offset, listH, count);
  const blank = paintBodyFill(width, color, 'files');
  const body = [];
  const fileHits = [];
  const editHits = [];
  let cursor = null;
  if (pad) body.push(blank);
  for (let i = 0; i < listH; i++) {
    const line = lineAt(start + i);
    if (!line) break;
    const row = body.push(line.row) - 1;
    if (line.cursor) cursor = rowCursor(line.cursor, row);
    for (const edit of line.edits) editHits.push({ ...edit, row });
    if (line.hit) {
      fileHits.push({ y: headerLines + pad + i + 1, cursor: line.index });
    }
  }
  if (pad) body.push(blank);
  return paneResult({ body, fileHits, editHits, cursor, listScroll: start });
};

const editLine = (extraRow) => {
  const { row, cursor, edit, edits = [] } = extraRow;
  return listLine(row, -1, cursor, edit ? [...edits, edit] : edits);
};

const paintCursorList = (items, cursor, pane, paintRow, extraRow = null) => {
  const edit = extraRow ? editLine(extraRow) : null;
  const inserting = edit !== null && extraRow.at === 'start';
  const extra = edit && extraRow.at !== 'replace' ? 1 : 0;
  const extraAt = extraIdx(extraRow, cursor, items.length);
  const lineAt = (idx) => {
    if (edit && idx === extraAt) return edit;
    const index = inserting ? idx - 1 : idx;
    const entry = items[index];
    if (!entry) return null;
    return listLine(paintRow(entry, !edit && index === cursor), index);
  };
  const focus = edit ? extraAt : cursor;
  return paintListWindow(items.length + extra, focus, pane, lineAt);
};

const sliceVisible = (text, skip, width) => {
  if (width <= 0) return '';
  const parts = graphemes(`${text ?? ''}`);
  let used = 0;
  let i = 0;
  const drop = Math.max(0, skip);
  while (i < parts.length) {
    const w = graphemeWidth(parts[i], used);
    if (used + w > drop) break;
    used += w;
    i += 1;
  }
  let out = '';
  let taken = 0;
  for (; i < parts.length; i++) {
    const w = graphemeWidth(parts[i], drop + taken);
    if (taken + w > width) break;
    out += parts[i];
    taken += w;
  }
  return out;
};

const fieldWindow = (text, cursor, scroll, width) => {
  const raw = `${text ?? ''}`;
  if (width <= 0) return { text: '', col: 0, scroll: 0 };
  const at = Math.max(0, Math.min(cursor ?? 0, raw.length));
  const col = visibleWidth(raw.slice(0, at));
  let next = scroll ?? 0;
  if (next < 0) next = 0;
  if (col < next) next = col;
  if (col >= next + width) next = col - width + 1;
  const shown = sliceVisible(raw, next, width);
  return { text: shown, col: col - next, scroll: next };
};

const branchLabel = (name) => `${name ?? ''}`.trim();

const paintListEdit = (compose, width, color, edgeW = 0) => {
  const inner = Math.max(1, width - edgeW);
  const prefix = ` ${FILE_MARK} `;
  const prefixW = visibleWidth(prefix);
  const rest = Math.max(1, inner - prefixW);
  const text = `${compose.text ?? ''}`.replaceAll('\n', ' ');
  const win = fieldWindow(text, compose.cursor, compose.scrollCol, rest);
  const clipped = win.text;
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
  const flat = text;
  return {
    row,
    cursor: { x: prefixW + win.col + 1, scroll: win.scroll },
    edit: {
      x0: 1,
      textX: prefixW + 1,
      x1: prefixW + 1 + rest,
      start: 0,
      text: flat,
      limit: flat.length,
      scroll: win.scroll,
      live: true,
    },
  };
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
  listLine,
  paintListWindow,
  paintCursorList,
  paintListEdit,
  fieldWindow,
  branchLabel,
  paneResult,
};
