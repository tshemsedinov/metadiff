'use strict';

const ansi = require('./ansi.js');

const { ESC, RESET, THEME, seq, stripAnsi, graphemes, graphemeWidth } = ansi;
const { visibleWidth } = ansi;

const CSI_FINAL = /[@-~]/;

const isRange = (sel) => {
  if (!sel || !sel.start || !sel.end) return false;
  return sel.start.x !== sel.end.x || sel.start.y !== sel.end.y;
};

const ordered = (sel) => {
  const start = sel.start;
  const end = sel.end;
  if (start.y < end.y) return { first: start, last: end };
  if (start.y > end.y) return { first: end, last: start };
  if (start.x <= end.x) return { first: start, last: end };
  return { first: end, last: start };
};

const slicePlain = (plain, fromCol, toCol) => {
  const parts = graphemes(plain);
  let col = 0;
  let out = '';
  for (const ch of parts) {
    const w = graphemeWidth(ch, col);
    const next = col + w;
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
  let from = 0;
  let to = Infinity;
  if (y === first.y) from = first.x - 1;
  if (y === last.y) to = last.x;
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

const consumeCsi = (line, i) => {
  let j = i + 2;
  while (j < line.length && !CSI_FINAL.test(line[j])) j += 1;
  if (j < line.length) j += 1;
  return j;
};

const parseParams = (body) => {
  if (!body) return [0];
  return body.split(';').map((part) => (part ? parseInt(part, 10) : 0));
};

const applyRgb = (state, field, params, i) => {
  const TRUECOLOR = 2;
  const isTruecolor = params[i + 1] === TRUECOLOR;
  const hasRgb = isTruecolor && i + 4 < params.length;
  if (!hasRgb) return 1;
  state[field] = [params[i + 2], params[i + 3], params[i + 4]];
  return 5;
};

const SGR = {
  0: (state) => {
    state.fg = null;
    state.bg = null;
    return 1;
  },
  38: (state, params, i) => applyRgb(state, 'fg', params, i),
  48: (state, params, i) => applyRgb(state, 'bg', params, i),
  39: (state) => {
    state.fg = null;
    return 1;
  },
  49: (state) => {
    state.bg = null;
    return 1;
  },
};

const applySgr = (params, state) => {
  let i = 0;
  while (i < params.length) {
    const apply = SGR[params[i]];
    i += apply ? apply(state, params, i) : 1;
  }
};

const nextGrapheme = (line, index) => {
  const parts = graphemes(line.slice(index));
  return parts[0] ?? '';
};

const parseCells = (line) => {
  const cells = [];
  const state = { fg: null, bg: null };
  let col = 0;
  let i = 0;
  while (i < line.length) {
    if (line[i] === ESC && line[i + 1] === '[') {
      const n = consumeCsi(line, i);
      if (line[n - 1] === 'm') {
        const body = line.slice(i + 2, n - 1);
        applySgr(parseParams(body), state);
      }
      i = n;
      continue;
    }
    if (line[i] === ESC) {
      i += 1;
      continue;
    }
    const ch = nextGrapheme(line, i);
    if (!ch) break;
    const width = graphemeWidth(ch, col);
    const fg = state.fg;
    const bg = state.bg;
    cells.push({ ch, fg, bg, col, width });
    col += width;
    i += ch.length;
  }
  return cells;
};

const rgbKey = (rgb) => (rgb ? `${rgb[0]},${rgb[1]},${rgb[2]}` : '');

const styleSeq = (fg, bg) => {
  if (fg && bg) return RESET + seq(fg, bg);
  if (fg) return RESET + ansi.fg(fg);
  if (bg) return RESET + ansi.bg(bg);
  return RESET;
};

const overlayRange = (line, fromCol, toCol) => {
  if (toCol <= fromCol) return line;
  const cells = parseCells(line);
  if (!cells.length) return line;
  let out = '';
  let last = null;
  for (const cell of cells) {
    const next = cell.col + cell.width;
    const hit = next > fromCol && cell.col < toCol;
    let fg = cell.fg;
    let bg = cell.bg;
    if (hit) {
      fg = cell.bg ?? THEME.ctxBg;
      bg = cell.fg ?? THEME.ctxFg;
    }
    const key = `${rgbKey(fg)}|${rgbKey(bg)}`;
    if (key !== last) {
      out += styleSeq(fg, bg);
      last = key;
    }
    out += cell.ch;
  }
  return out;
};

const selectionOf = (source) => {
  if (!source || typeof source.anchor !== 'number') return null;
  const cursor = source.cursor ?? 0;
  if (source.anchor === cursor) return null;
  return { anchor: source.anchor, cursor };
};

const editorSelection = (view) => {
  if (!view) return null;
  if (view.compose) return selectionOf(view.compose);
  return selectionOf(view.codeOverlay);
};

const spanCols = (hit, lo, hi) => {
  const start = hit.start ?? 0;
  const from = Math.max(lo, start);
  const to = Math.min(hi, hit.limit ?? start);
  if (to <= from) return null;
  const text = hit.text ?? '';
  const head = Math.max(0, from - start);
  const tail = Math.max(0, to - start);
  const c0 = visibleWidth(text.slice(0, head));
  const c1 = visibleWidth(text.slice(0, tail));
  const scroll = hit.scroll ?? 0;
  const room = Math.max(0, (hit.x1 ?? hit.textX ?? 1) - (hit.textX ?? 1));
  const vis0 = Math.max(c0, scroll);
  const vis1 = Math.min(c1, scroll + room);
  if (vis1 <= vis0) return null;
  const origin = (hit.textX ?? 1) - 1;
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
    if (!range) continue;
    const i = hit.y - 1;
    if (i < 0 || i >= next.length) continue;
    next[i] = overlayRange(next[i], range.from, range.to);
  }
  return next;
};

const overlayRows = (rows, sel) => {
  if (!isRange(sel)) return rows;
  const { length } = rows;
  const next = new Array(length);
  for (let i = 0; i < length; i++) {
    const range = lineRange(i, sel);
    next[i] = range ? overlayRange(rows[i], range.from, range.to) : rows[i];
  }
  return next;
};

module.exports = {
  isRange,
  extractText,
  overlayRange,
  overlayRows,
  markEditorSelection,
};
