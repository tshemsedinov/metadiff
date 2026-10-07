'use strict';

const { emit, highlightLines } = require('./core.js');

const URL_RE = /https?:\/\/[^\s<>"']+|www\.[^\s<>"']+/g;

const highlightTxtLine = (line) => {
  const out = [];
  let last = 0;
  for (const match of line.matchAll(URL_RE)) {
    emit(out, 'plain', line.slice(last, match.index));
    emit(out, 'string', match[0]);
    last = match.index + match[0].length;
  }
  emit(out, 'plain', line.slice(last));
  return out;
};

module.exports = {
  langs: ['txt', 'py', 'md'],
  aliases: { text: 'txt', plain: 'txt', markdown: 'md', python: 'py' },
  highlight: highlightLines(highlightTxtLine),
};
