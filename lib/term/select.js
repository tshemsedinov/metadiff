'use strict';

const ansi = require('./ansi.js');
const { ESC, RESET, THEME, seq, fg, bg, stripAnsi, visibleWidth } = ansi;
const { graphemes, graphemeWidth, firstGrapheme } = ansi;

const CSI_FINAL = /[@-~]/;
const TRUECOLOR = 2;

const isRange = (sel) => {
  if (!sel || !sel.start || !sel.end) return false;
  return sel.start.x !== sel.end.x || sel.start.y !== sel.end.y;
};

const ordered = (sel) => {
  const { start, end } = sel;
  const forward = start.y < end.y || (start.y === end.y && start.x <= end.x);
  return forward ? { first: start, last: end } : { first: end, last: start };
};

const slicePlain = (plain, fromCol, toCol) => {
  let col = 0;
  let out = '';
  for (const ch of graphemes(plain)) {
    const next = col + graphemeWidth(ch, col);
    if (next > fromCol && col < toCol) out += ch;
    col = next;
    if (col >= toCol) break;
  }
  return out;
};

const lineRange = (rowIndex, sel) => {
  const { first, last } = ordered(sel);
  const y = rowIndex + 1;
  if (y < first.y || y > last.y) return null;
  const from = y === first.y ? first.x - 1 : 0;
  const to = y === last.y ? last.x : Infinity;
  if (to <= from) return null;
  return { from, to };
};

const extractText = (rows, sel) => {
  if (!isRange(sel) || !rows || !rows.length) return '';
  const { first, last } = ordered(sel);
  const lines = [];
  for (let row = first.y - 1; row <= last.y - 1; row++) {
    const range = lineRange(row, sel);
    if (!range) continue;
    const plain = stripAnsi(rows[row] ?? '');
    const chunk = slicePlain(plain, range.from, range.to);
    lines.push(chunk.replace(/\s+$/g, ''));
  }
  return lines.join('\n');
};

const csiEnd = (line, i) => {
  let j = i + 2;
  while (j < line.length && !CSI_FINAL.test(line[j])) j += 1;
  return j < line.length ? j + 1 : j;
};

const parseParams = (body) => {
  if (!body) return [0];
  return body.split(';').map((part) => (part ? parseInt(part, 10) : 0));
};

const applyRgb = (state, field, params, i) => {
  const isTruecolor = params[i + 1] === TRUECOLOR;
  if (!isTruecolor || i + 4 >= params.length) return 1;
  state[field] = [params[i + 2], params[i + 3], params[i + 4]];
  return 5;
};

const applySgr = (params, state) => {
  let i = 0;
  while (i < params.length) {
    const code = params[i];
    if (code === 38) {
      i += applyRgb(state, 'fg', params, i);
      continue;
    }
    if (code === 48) {
      i += applyRgb(state, 'bg', params, i);
      continue;
    }
    if (code === 0 || code === 39) state.fg = null;
    if (code === 0 || code === 49) state.bg = null;
    i += 1;
  }
};

const parseCells = (line) => {
  const cells = [];
  const state = { fg: null, bg: null };
  let col = 0;
  let i = 0;
  while (i < line.length) {
    if (line[i] === ESC && line[i + 1] === '[') {
      const end = csiEnd(line, i);
      if (line[end - 1] === 'm') {
        applySgr(parseParams(line.slice(i + 2, end - 1)), state);
      }
      i = end;
      continue;
    }
    if (line[i] === ESC) {
      i += 1;
      continue;
    }
    const ch = firstGrapheme(line.slice(i));
    if (!ch) break;
    const width = graphemeWidth(ch, col);
    cells.push({ ch, fg: state.fg, bg: state.bg, col, width });
    col += width;
    i += ch.length;
  }
  return cells;
};

const rgbKey = (rgb) => (rgb ? `${rgb[0]},${rgb[1]},${rgb[2]}` : '');

const styleSeq = (fgRgb, bgRgb) => {
  if (fgRgb && bgRgb) return RESET + seq(fgRgb, bgRgb);
  if (fgRgb) return RESET + fg(fgRgb);
  if (bgRgb) return RESET + bg(bgRgb);
  return RESET;
};

const overlayRange = (line, fromCol, toCol) => {
  if (toCol <= fromCol) return line;
  const cells = parseCells(line);
  if (!cells.length) return line;
  let out = '';
  let last = null;
  for (const cell of cells) {
    let cellFg = cell.fg;
    let cellBg = cell.bg;
    if (cell.col + cell.width > fromCol && cell.col < toCol) {
      cellFg = cell.bg ?? THEME.ctxBg;
      cellBg = cell.fg ?? THEME.ctxFg;
    }
    const key = `${rgbKey(cellFg)}|${rgbKey(cellBg)}`;
    if (key !== last) {
      out += styleSeq(cellFg, cellBg);
      last = key;
    }
    out += cell.ch;
  }
  return out;
};

const editorSelection = (view) => {
  const source = view?.compose || view?.codeOverlay;
  if (!source || typeof source.anchor !== 'number') return null;
  const cursor = source.cursor ?? 0;
  if (source.anchor === cursor) return null;
  return { anchor: source.anchor, cursor };
};

const spanCols = (hit, lo, hi) => {
  const start = hit.start ?? 0;
  const from = Math.max(lo, start);
  const to = Math.min(hi, hit.limit ?? start);
  if (to <= from) return null;
  const text = hit.text ?? '';
  const c0 = visibleWidth(text.slice(0, Math.max(0, from - start)));
  const c1 = visibleWidth(text.slice(0, Math.max(0, to - start)));
  const scroll = hit.scroll ?? 0;
  const textX = hit.textX ?? 1;
  const room = Math.max(0, (hit.x1 ?? textX) - textX);
  const vis0 = Math.max(c0, scroll);
  const vis1 = Math.min(c1, scroll + room);
  if (vis1 <= vis0) return null;
  const origin = textX - 1;
  return { from: origin + vis0 - scroll, to: origin + vis1 - scroll };
};

const markEditorSelection = (rows, view, hits, color) => {
  if (!color || !hits) return rows;
  const sel = editorSelection(view);
  if (!sel) return rows;
  const lo = Math.min(sel.anchor, sel.cursor);
  const hi = Math.max(sel.anchor, sel.cursor);
  const next = rows.slice();
  for (const hit of hits) {
    if (!hit.live || !hit.y) continue;
    const range = spanCols(hit, lo, hi);
    const i = hit.y - 1;
    if (!range || i < 0 || i >= next.length) continue;
    next[i] = overlayRange(next[i], range.from, range.to);
  }
  return next;
};

const overlayRows = (rows, sel) => {
  if (!isRange(sel)) return rows;
  return rows.map((row, i) => {
    const range = lineRange(i, sel);
    return range ? overlayRange(row, range.from, range.to) : row;
  });
};

module.exports = {
  isRange,
  extractText,
  overlayRange,
  overlayRows,
  markEditorSelection,
};
