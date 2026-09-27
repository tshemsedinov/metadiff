'use strict';

const ansi = require('../ansi.js');
const files = require('../files.js');
const primitives = require('./primitives.js');
const { measureColumns, padColumns } = primitives;

const { isTodosEntry, shortAge } = files;
const { THEME, paint, visibleWidth, truncateVisible, seq, EL } = ansi;
const { fill, FILE_MARK, paintCursorList } = primitives;

const FILE_STATUS_FG = {
  unstaged: THEME.delLineFg,
  staged: THEME.addLineFg,
  untracked: THEME.mutedFg,
  partial: THEME.warnFg,
};

const FILE_COL_ALIGN = {
  add: 'start',
  del: 'start',
  status: 'start',
  n: 'start',
  m: 'end',
  date: 'start',
};

const FILE_DATE_GAP = '   ';

const signedCount = (sign, n) => `${sign}${n ?? 0}`;

const fileRowFields = (entry) => {
  if (isTodosEntry(entry)) {
    const n = `${entry.staged ?? 0}`;
    const m = `${entry.remaining ?? 0}`;
    return { add: '', del: '', status: '', n, m, date: '' };
  }
  const { added, removed, staged, remaining } = entry;
  const add = signedCount('+', added);
  const del = signedCount('-', removed);
  const status = entry.status ?? '';
  const n = `${staged ?? 0}`;
  const m = `${remaining ?? 0}`;
  const date = shortAge(entry.date ?? '');
  return { add, del, status, n, m, date };
};

const fileRowFg = (status, selected) => {
  const statusFg = FILE_STATUS_FG[status];
  if (statusFg) return statusFg;
  if (selected) return THEME.chromeFg;
  return THEME.mutedFg;
};

const joinFileDate = (parts, cols) => {
  if (!cols?.date) return '';
  return `${FILE_DATE_GAP}${parts.date}`;
};

const joinFileMeta = (parts) => {
  const { add, del, status, n, m } = parts;
  return `  ${add}  ${del}  ${status}  ${n}/${m}`;
};

const paintFileSuffix = (parts, cols, fgRgb, bgRgb, color) => {
  const { add, del, status, n, m } = parts;
  const gap = paint('  ', fgRgb, bgRgb, color);
  const addText = paint(add, THEME.addLineFg, bgRgb, color);
  const delText = paint(del, THEME.delLineFg, bgRgb, color);
  const statusText = paint(status, fgRgb, bgRgb, color);
  const nText = paint(n, fgRgb, bgRgb, color);
  const slash = paint('/', fgRgb, bgRgb, color);
  const mText = paint(m, fgRgb, bgRgb, color);
  const counts = addText + gap + delText;
  const meta = statusText + gap + nText + slash + mText;
  if (!cols?.date) return gap + counts + gap + meta;
  const dateGap = paint(FILE_DATE_GAP, fgRgb, bgRgb, color);
  const age = paint(parts.date, THEME.mutedFg, bgRgb, color);
  return gap + counts + gap + meta + dateGap + age;
};

const paintTodosRow = (entry, width, color, selected, cols) => {
  const inner = Math.max(1, width - 1);
  const mark = selected ? FILE_MARK : ' ';
  const prefix = ` ${mark} `;
  const parts = padColumns(fileRowFields(entry), cols, FILE_COL_ALIGN);
  const meta = joinFileMeta(parts);
  const dated = joinFileDate(parts, cols);
  const suffix = `${meta}${dated}`;
  const pathW = Math.max(1, inner - visibleWidth(prefix + suffix));
  const clipped = truncateVisible(entry.path, pathW);
  const pad = Math.max(0, pathW - visibleWidth(clipped));
  const left = `${prefix}${clipped}${' '.repeat(pad)}`;
  const fgRgb = THEME.buttonHotFg;
  const bgRgb = selected ? THEME.buttonBg : THEME.ctxBg;
  const edge = fill(1, fgRgb, bgRgb, color);
  if (!color) return `${left}${suffix}${edge}`;
  let out = `${seq(fgRgb, bgRgb)}${EL}`;
  out += paint(left, fgRgb, bgRgb, color, true);
  out += paint(meta, fgRgb, bgRgb, color, true);
  if (!dated) return out + edge;
  out += paint(FILE_DATE_GAP, fgRgb, bgRgb, color);
  out += paint(parts.date, THEME.mutedFg, bgRgb, color);
  return out + edge;
};

const paintFileRow = (entry, width, color, selected, cols) => {
  if (isTodosEntry(entry)) {
    return paintTodosRow(entry, width, color, selected, cols);
  }
  const inner = Math.max(1, width - 1);
  const mark = selected ? FILE_MARK : ' ';
  const prefix = ` ${mark} `;
  const parts = padColumns(fileRowFields(entry), cols, FILE_COL_ALIGN);
  const suffix = `${joinFileMeta(parts)}${joinFileDate(parts, cols)}`;
  const pathW = Math.max(1, inner - visibleWidth(prefix + suffix));
  const { path, status } = entry;
  const clipped = truncateVisible(path, pathW);
  const pad = Math.max(0, pathW - visibleWidth(clipped));
  const left = `${prefix}${clipped}${' '.repeat(pad)}`;
  const fgRgb = fileRowFg(status, selected);
  const bgRgb = selected ? THEME.buttonBg : THEME.ctxBg;
  const edge = fill(1, fgRgb, bgRgb, color);
  if (!color) return `${left}${suffix}${edge}`;
  let out = `${seq(fgRgb, bgRgb)}${EL}`;
  out += paint(left, fgRgb, bgRgb, color);
  out += paintFileSuffix(parts, cols, fgRgb, bgRgb, color);
  return out + edge;
};

const paintBodyFiles = (view, width, color, bodyH, headerLines) => {
  const files = view.files ?? [];
  const cols = measureColumns(files, fileRowFields, FILE_COL_ALIGN);
  const cursor = view.fileCursor ?? 0;
  const paintRow = (entry, rowWidth, rowColor, selected) =>
    paintFileRow(entry, rowWidth, rowColor, selected, cols);
  return paintCursorList(
    files,
    cursor,
    width,
    color,
    bodyH,
    headerLines,
    paintRow,
    null,
    view.listScroll,
  );
};

module.exports = { paintBodyFiles };
