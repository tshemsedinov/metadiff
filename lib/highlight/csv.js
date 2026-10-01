'use strict';

const core = require('./core.js');
const { emit, highlightLines } = core;

const splitCsv = (line) => {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"' && inQuotes && line[i + 1] === '"') {
      cur += '"';
      i += 1;
    } else if (ch === '"') {
      inQuotes = !inQuotes;
      cur += ch;
    } else if (ch === ',' && !inQuotes) {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
};

const cellStyle = (cell, col) => {
  if (/^-?\d+(\.\d+)?$/.test(cell.trim())) return 'number';
  return col % 2 === 0 ? 'string' : 'variable';
};

const highlightCsvLine = (line) => {
  const cells = splitCsv(line);
  const out = [];
  for (let col = 0; col < cells.length; col += 1) {
    if (col) emit(out, 'punct', ',');
    emit(out, cellStyle(cells[col], col), cells[col]);
  }
  return out;
};

module.exports = {
  langs: ['csv'],
  highlight: highlightLines(highlightCsvLine, /\r?\n/),
};
