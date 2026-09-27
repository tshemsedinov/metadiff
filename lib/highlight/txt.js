'use strict';

const core = require('./core.js');
const { emit } = core;

const highlightTxtLine = (line) => {
  if (!line) return [];
  const out = [];
  const re = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/g;
  let last = 0;
  let m = re.exec(line);
  while (m !== null) {
    if (m.index > last) emit(out, 'plain', line.slice(last, m.index));
    emit(out, 'string', m[0]);
    last = m.index + m[0].length;
    m = re.exec(line);
  }
  if (last < line.length) emit(out, 'plain', line.slice(last));
  if (!out.length) emit(out, 'plain', line);
  return out;
};

const highlight = (source) => {
  const lines = source.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (i) emit(out, 'plain', '\n');
    for (const t of highlightTxtLine(lines[i])) out.push(t);
  }
  return out;
};

module.exports = {
  langs: ['txt', 'py', 'md'],
  aliases: { text: 'txt', plain: 'txt', markdown: 'md', python: 'py' },
  highlight,
};
