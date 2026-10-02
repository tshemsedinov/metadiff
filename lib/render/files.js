'use strict';

const ansi = require('../ansi.js');
const files = require('../files.js');
const primitives = require('./primitives.js');

const { isTasksEntry, shortAge } = files;
const { THEME, paint, visibleWidth, trimVisible, seq, EL } = ansi;
const { fill, markPrefix, paintCursorList } = primitives;
const { measureColumns, padColumns } = primitives;
const searchPaint = require('./search.js');
const { paintPathText } = searchPaint;
const locate = require('../find.js');
const { activeHit, spansFor } = locate;

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

const fileRowFields = (entry) => {
  const n = `${entry.staged ?? 0}`;
  const m = `${entry.remaining ?? 0}`;
  if (isTasksEntry(entry)) {
    return { add: '', del: '', status: '', n, m, date: '' };
  }
  const add = `+${entry.added ?? 0}`;
  const del = `-${entry.removed ?? 0}`;
  const status = entry.status ?? '';
  return { add, del, status, n, m, date: shortAge(entry.date) };
};

const fileRowFg = (entry, selected) => {
  if (isTasksEntry(entry)) return THEME.buttonHotFg;
  const statusFg = FILE_STATUS_FG[entry.status];
  if (statusFg) return statusFg;
  return selected ? THEME.chromeFg : THEME.mutedFg;
};

const paintFileMeta = (parts, fgRgb, bgRgb, color) => {
  const gap = paint('  ', fgRgb, bgRgb, color);
  let out = gap + paint(parts.add, THEME.addLineFg, bgRgb, color);
  out += gap + paint(parts.del, THEME.delLineFg, bgRgb, color);
  out += gap + paint(parts.status, fgRgb, bgRgb, color);
  out += gap + paint(parts.n, fgRgb, bgRgb, color);
  out += paint('/', fgRgb, bgRgb, color);
  return out + paint(parts.m, fgRgb, bgRgb, color);
};

const rowSpans = (entry, path, marks) => {
  if (!marks || !marks.query) return [];
  const hit = marks.hit && marks.hit.index === marks.index ? marks.hit : null;
  return spansFor(path, entry.path ?? '', marks.query, hit);
};

const paintFileRow = (entry, width, color, selected, cols, marks) => {
  const tasks = isTasksEntry(entry);
  const inner = Math.max(1, width - 1);
  const prefix = markPrefix(selected);
  const parts = padColumns(fileRowFields(entry), cols, FILE_COL_ALIGN);
  const { add, del, status, n, m } = parts;
  const meta = `  ${add}  ${del}  ${status}  ${n}/${m}`;
  const date = cols.date ? `${FILE_DATE_GAP}${parts.date}` : '';
  const pathW = Math.max(1, inner - visibleWidth(prefix + meta + date));
  const path = trimVisible(entry.path, pathW);
  const pad = ' '.repeat(Math.max(0, pathW - visibleWidth(path)));
  const left = `${prefix}${path}${pad}`;
  const fgRgb = fileRowFg(entry, selected);
  const bgRgb = selected ? THEME.buttonBg : THEME.ctxBg;
  const edge = fill(1, fgRgb, bgRgb, color);
  if (!color) return `${left}${meta}${date}${edge}`;
  const spans = rowSpans(entry, path, marks);
  let out = `${seq(fgRgb, bgRgb)}${EL}`;
  out += paint(prefix, fgRgb, bgRgb, color, tasks);
  out += paintPathText(path, fgRgb, bgRgb, color, tasks, spans);
  out += paint(pad, fgRgb, bgRgb, color, tasks);
  if (tasks) out += paint(meta, fgRgb, bgRgb, color, true);
  else out += paintFileMeta(parts, fgRgb, bgRgb, color);
  if (date) {
    out += paint(FILE_DATE_GAP, fgRgb, bgRgb, color);
    out += paint(parts.date, THEME.mutedFg, bgRgb, color);
  }
  return out + edge;
};

const paintBodyFiles = (view, width, color, bodyH, headerLines) => {
  const entries = view.files ?? [];
  const cols = measureColumns(entries, fileRowFields, FILE_COL_ALIGN);
  const cursor = view.fileCursor ?? 0;
  const pane = { width, color, bodyH, headerLines, offset: view.listScroll };
  const hit = activeHit(entries, view.find);
  const query = view.find && view.find.query ? view.find.query : '';
  const paintRow = (entry, selected, index) =>
    paintFileRow(entry, width, color, selected, cols, {
      query,
      hit,
      index,
    });
  return paintCursorList(entries, cursor, pane, paintRow);
};

module.exports = { paintBodyFiles };
