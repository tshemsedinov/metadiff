'use strict';

const core = require('./core.js');
const { emit } = core;

const splitCsv = (line) => {
  const cells = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQ = !inQ;
        cur += ch;
      }
      continue;
    }
    if (ch === ',' && !inQ) {
      cells.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  return cells;
};

const highlightCsvCell = (cell, row, col) => {
  if (row === 0) return { text: cell, style: 'function' };
  const num = /^-?\d+(\.\d+)?$/.test(cell.trim());
  if (num) return { text: cell, style: 'number' };
  if (col % 2 === 0) return { text: cell, style: 'string' };
  return { text: cell, style: 'variable' };
};

const highlightCsvLine = (line, row) => {
  if (!line) return [];
  const cells = splitCsv(line);
  const out = [];
  for (let col = 0; col < cells.length; col += 1) {
    if (col) emit(out, 'punct', ',');
    const cell = highlightCsvCell(cells[col], row, col);
    emit(out, cell.style, cell.text);
  }
  return out;
};

const highlight = (source) => {
  const lines = source.split(/\r?\n/);
  const out = [];
  for (let row = 0; row < lines.length; row += 1) {
    if (row) emit(out, 'plain', '\n');
    for (const t of highlightCsvLine(lines[row], row === 0 ? 1 : row)) {
      out.push(t);
    }
  }
  return out;
};

module.exports = { langs: ['csv'], highlight };
