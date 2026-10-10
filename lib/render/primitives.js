'use strict';

const ansi = require('../ansi.js');
const { LIST_PANES } = require('../session/actions.js');

const { THEME, paint, visibleWidth, graphemes, graphemeWidth } = ansi;

const GUTTER_W = 2;
const FILE_MARK = '▶';
const MARK_W = visibleWidth(` ${FILE_MARK} `);
const LIST_PAD = 1;
const NO_EDITS = [];

const fill = (width, fgRgb, bgRgb, color) =>
  paint(' '.repeat(Math.max(0, width)), fgRgb, bgRgb, color);

const markPrefix = (selected) => ` ${selected ? FILE_MARK : ' '} `;

const isListPane = (pane) =>
  LIST_PANES.includes(pane) || pane === 'dashboard' || pane === 'repos';

const isTaskView = (view) => view.item?.origin === 'task';

const branchLabel = (name) => `${name ?? ''}`.trim();

const padVisible = (text, width, align) => {
  const gap = ' '.repeat(Math.max(0, width - visibleWidth(text)));
  return align === 'end' ? `${text}${gap}` : `${gap}${text}`;
};

const splitWidths = (width) => {
  const inner = Math.max(0, width - 1);
  const leftW = Math.floor(inner / 2);
  return { leftW, rightW: inner - leftW };
};

const paintSplitRule = (color) =>
  fill(1, THEME.splitGutterFg, THEME.splitGutterBg, color);

const paintBodyFill = (width, color, kind) => {
  const ctx = (n) => fill(n, THEME.ctxFg, THEME.ctxBg, color);
  if (kind === 'files') return ctx(Math.max(1, width - 1)) + ctx(1);
  if (kind !== 'split') return ctx(width);
  const { leftW, rightW } = splitWidths(width);
  return ctx(leftW) + paintSplitRule(color) + ctx(rightW);
};

const paneResult = (fields = {}) => ({
  body: fields.body ?? [],
  fileHits: fields.fileHits ?? [],
  taskOwners: fields.taskOwners ?? [],
  taskChecks: fields.taskChecks ?? [],
  cursor: fields.cursor ?? null,
  splitBody: fields.splitBody === true,
  listScroll: fields.listScroll ?? 0,
  editHits: fields.editHits ?? [],
  scrollBar: fields.scrollBar ?? null,
});

const editSpan = (x0, textX, x1, start, text) => ({
  x0,
  textX,
  x1,
  start,
  text,
  limit: start + text.length,
  live: true,
});

const listLine = (row, index, cursor = null, edits = NO_EDITS) => ({
  row,
  index,
  hit: index >= 0,
  cursor,
  edits,
});

const listWindowStart = (focus, offset, listH, count) => {
  let start = offset ?? 0;
  if (focus < start) start = focus;
  if (focus >= start + listH) start = focus - listH + 1;
  return Math.max(0, Math.min(start, count - listH));
};

const rowCursor = (cursor, row) => {
  const out = { x: cursor.x, row };
  if (typeof cursor.scroll === 'number') out.scroll = cursor.scroll;
  return out;
};

const paintListWindow = (count, focus, pane, lineAt) => {
  const { width, color, bodyH, headerLines, offset } = pane;
  const padded = bodyH >= LIST_PAD * 2 + 1 ? LIST_PAD : 0;
  const pad = pane.pad === 0 ? 0 : padded;
  const listH = bodyH - pad * 2;
  const start = listWindowStart(focus, offset, listH, count);
  const blank = pane.blank ?? paintBodyFill(width, color, 'files');
  const body = pad ? [blank] : [];
  const fileHits = [];
  const editHits = [];
  let cursor = null;
  for (let i = 0; i < listH; i++) {
    const line = lineAt(start + i);
    if (!line) break;
    const row = body.push(line.row) - 1;
    if (line.cursor) cursor = rowCursor(line.cursor, row);
    for (const edit of line.edits) editHits.push({ ...edit, row });
    if (line.hit) {
      const y = headerLines + pad + i + 1;
      for (const span of line.spans ?? []) {
        fileHits.push({ y, cursor: line.index, ...span });
      }
      fileHits.push({ y, cursor: line.index });
    }
  }
  if (pad) body.push(blank);
  return paneResult({ body, fileHits, editHits, cursor, listScroll: start });
};

const insertedAt = (extra, count) => {
  if (extra.at === 'start') return 0;
  if (extra.at !== 'index') return count;
  const index = extra.index ?? count;
  return Math.max(0, Math.min(index, count));
};

const lineFromPaint = (painted, index) => {
  if (typeof painted === 'string') return listLine(painted, index);
  const line = listLine(painted.row, index);
  if (painted.hit === false) line.hit = false;
  if (painted.spans) line.spans = painted.spans;
  return line;
};

const paintCursorList = (items, cursor, pane, paintRow, extra = null) => {
  const lineAt = (index) => {
    const entry = items[index];
    if (!entry) return null;
    const selected = !extra && index === cursor;
    return lineFromPaint(paintRow(entry, selected, index), index);
  };
  if (!extra) return paintListWindow(items.length, cursor, pane, lineAt);
  const edit = listLine(extra.row, -1, extra.cursor, extra.edits);
  if (extra.at === 'replace') {
    const at = extra.index;
    const replaced = (i) => (i === at ? edit : lineAt(i));
    return paintListWindow(items.length, at, pane, replaced);
  }
  const at = insertedAt(extra, items.length);
  const inserted = (i) => (i === at ? edit : lineAt(i < at ? i : i - 1));
  return paintListWindow(items.length + 1, at, pane, inserted);
};

const sliceVisible = (text, skip, width) => {
  if (width <= 0) return '';
  const parts = graphemes(text);
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
  if (width <= 0) return { text: '', col: 0, scroll: 0 };
  const at = Math.max(0, Math.min(cursor ?? 0, text.length));
  const col = visibleWidth(text.slice(0, at));
  let next = Math.max(0, scroll ?? 0);
  if (col < next) next = col;
  if (col >= next + width) next = col - width + 1;
  const shown = sliceVisible(text, next, width);
  return { text: shown, col: col - next, scroll: next };
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
    const width = widths[key] ?? visibleWidth(fields[key]);
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
  GUTTER_W,
  MARK_W,
  LIST_PAD,
  fill,
  markPrefix,
  isListPane,
  isTaskView,
  branchLabel,
  padVisible,
  splitWidths,
  paintSplitRule,
  paintBodyFill,
  paneResult,
  editSpan,
  listLine,
  listWindowStart,
  paintListWindow,
  paintCursorList,
  sliceVisible,
  fieldWindow,
  measureColumns,
  padColumns,
  joinColumns,
  paintColumns,
};
