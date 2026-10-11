'use strict';

const { clamp } = require('../common/utilities.js');
const { graphemes, graphemeWidth, visibleWidth } = require('./ansi.js');

const wrapPlain = (text, width) => {
  if (width <= 0) return [''];
  if (visibleWidth(text) <= width) return [text];
  const parts = graphemes(text);
  const rows = [];
  let start = 0;
  let col = 0;
  let lastBreak = -1;
  let i = 0;
  while (i < parts.length) {
    const ch = parts[i];
    const w = graphemeWidth(ch, col);
    if (col + w > width && col > 0) {
      const end = lastBreak >= start ? lastBreak + 1 : i;
      rows.push(parts.slice(start, end).join(''));
      start = end;
      i = end;
      col = 0;
      lastBreak = -1;
      continue;
    }
    col += w;
    if (ch === ' ' || ch === '\t') lastBreak = i;
    i += 1;
  }
  rows.push(parts.slice(start).join(''));
  return rows;
};

const wrapDoc = (text, width) => {
  const rows = [];
  let offset = 0;
  for (const part of text.split('\n')) {
    let start = offset;
    for (const row of wrapPlain(part, width)) {
      rows.push({ start, text: row });
      start += row.length;
    }
    offset += part.length + 1;
  }
  return rows;
};

const wrapMultiline = (text, width) =>
  wrapDoc(text, width).map((row) => row.text);

const cursorInWrap = (text, cursor, width) => {
  const rows = wrapDoc(text, width);
  const clamped = clamp(cursor, 0, text.length);
  let row = rows.length - 1;
  for (let i = 0; i < rows.length - 1; i++) {
    if (clamped < rows[i + 1].start) {
      row = i;
      break;
    }
  }
  const line = rows[row];
  const take = clamp(clamped - line.start, 0, line.text.length);
  return { row, col: visibleWidth(line.text.slice(0, take)) };
};

const colIndex = (text, col) => {
  let used = 0;
  let index = 0;
  for (const ch of graphemes(text)) {
    const w = graphemeWidth(ch, used);
    if (used + w > col) break;
    used += w;
    index += ch.length;
  }
  return index;
};

const indexAtRow = (start, text, col) => {
  if (col <= 0) return start;
  return start + colIndex(`${text ?? ''}`, col);
};

const indexAtWrapCol = (row, col, limit) => {
  const pos = row.start + colIndex(row.text, col);
  if (pos < limit) return pos;
  if (pos <= row.start) return row.start;
  const parts = graphemes(row.text);
  return pos - parts[parts.length - 1].length;
};

const wrapMove = (text, cursor, width, delta, wantCol) => {
  const rows = wrapDoc(text, width);
  const pos = cursorInWrap(text, cursor, width);
  const next = Math.min(Math.max(pos.row + delta, 0), rows.length - 1);
  const col = wantCol ?? pos.col;
  if (next === pos.row) return { cursor, col };
  const limit = next + 1 < rows.length ? rows[next + 1].start : text.length + 1;
  return { cursor: indexAtWrapCol(rows[next], col, limit), col };
};

module.exports = {
  wrapPlain,
  wrapDoc,
  wrapMultiline,
  cursorInWrap,
  indexAtRow,
  wrapMove,
};
