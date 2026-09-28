'use strict';

const core = require('./core.js');
const { emit, highlightLines } = core;

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

module.exports = {
  langs: ['txt', 'py', 'md'],
  aliases: { text: 'txt', plain: 'txt', markdown: 'md', python: 'py' },
  highlight: highlightLines(highlightTxtLine),
};
