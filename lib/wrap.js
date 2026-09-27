'use strict';

const ansi = require('./ansi.js');
const { graphemes, graphemeWidth, visibleWidth } = ansi;

const wrapPlain = (text, width) => {
  if (width <= 0) return [''];
  if (visibleWidth(text) <= width) return [text];
  const parts = graphemes(text);
  const rows = [];
  let start = 0;
  let col = 0;
  let lastBreak = -1;
  let i = 0;
  const slice = (from, to) => {
    let out = '';
    for (let k = from; k < to; k++) out += parts[k];
    return out;
  };
  const flush = (end) => {
    rows.push(slice(start, end));
    start = end;
    col = 0;
    lastBreak = -1;
  };
  while (i < parts.length) {
    const ch = parts[i];
    const w = graphemeWidth(ch, col);
    if (col + w > width && col > 0) {
      if (lastBreak >= start) {
        flush(lastBreak + 1);
        continue;
      }
      flush(i);
      continue;
    }
    col += w;
    if (ch === ' ' || ch === '\t') lastBreak = i;
    i += 1;
  }
  rows.push(slice(start, parts.length));
  return rows;
};

const wrapDoc = (text, width) => {
  const rows = [];
  const parts = text.split('\n');
  let offset = 0;
  for (let p = 0; p < parts.length; p++) {
    const part = parts[p];
    const wrapped = wrapPlain(part, width);
    let used = 0;
    for (const row of wrapped) {
      rows.push({ start: offset + used, text: row });
      used += row.length;
    }
    offset += part.length;
    if (p < parts.length - 1) offset += 1;
  }
  if (!rows.length) rows.push({ start: 0, text: '' });
  return rows;
};

const wrapMultiline = (text, width) =>
  wrapDoc(text, width).map((row) => row.text);

const cursorInWrap = (text, cursor, width) => {
  const rows = wrapDoc(text, width);
  const clamped = Math.max(0, Math.min(cursor, text.length));
  let row = rows.length - 1;
  for (let i = 0; i < rows.length; i++) {
    const next = i + 1 < rows.length ? rows[i + 1].start : text.length + 1;
    if (clamped < next) {
      row = i;
      break;
    }
  }
  const line = rows[row];
  const take = Math.min(Math.max(0, clamped - line.start), line.text.length);
  return { row, col: visibleWidth(line.text.slice(0, take)) };
};

const indexAtWrapCol = (row, col, limit) => {
  let used = 0;
  let idx = 0;
  for (const ch of graphemes(row.text)) {
    const w = graphemeWidth(ch, used);
    if (used + w > col) break;
    used += w;
    idx += ch.length;
  }
  const pos = row.start + idx;
  if (pos < limit) return pos;
  if (pos <= row.start) return row.start;
  const parts = graphemes(row.text);
  return pos - parts[parts.length - 1].length;
};

const wrapMove = (text, cursor, width, delta, wantCol) => {
  const rows = wrapDoc(text, width);
  const pos = cursorInWrap(text, cursor, width);
  let next = pos.row + delta;
  if (next < 0) next = 0;
  if (next >= rows.length) next = rows.length - 1;
  const col = wantCol ?? pos.col;
  if (next === pos.row) return { cursor, col };
  const row = rows[next];
  let limit = text.length + 1;
  if (next + 1 < rows.length) limit = rows[next + 1].start;
  return { cursor: indexAtWrapCol(row, col, limit), col };
};

module.exports = {
  wrapPlain,
  wrapDoc,
  wrapMultiline,
  cursorInWrap,
  wrapMove,
};
