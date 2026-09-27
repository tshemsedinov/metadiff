'use strict';

const core = require('./core.js');
const { QUOTES, emit, readBlockComment, readString } = core;

const CSS_NEXT_STYLE = {
  ':': 'property',
  '{': 'tag',
};

const highlight = (source) => {
  const out = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '*') {
      const { text, end } = readBlockComment(source, i);
      emit(out, 'comment', text);
      i = end;
      continue;
    }
    if (QUOTES.includes(ch)) {
      const { text, end } = readString(source, i);
      emit(out, 'string', text);
      i = end;
      continue;
    }
    if (ch === '@') {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9-]/.test(source[j])) j += 1;
      emit(out, 'keyword', source.slice(i, j));
      i = j;
      continue;
    }
    if ('#.'.includes(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_-]/.test(source[j])) j += 1;
      const kind = ch === '#' ? 'constant' : 'className';
      emit(out, kind, source.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < n && /[0-9.%]/.test(source[j])) j += 1;
      emit(out, 'number', source.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_-]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_-]/.test(source[j])) j += 1;
      const word = source.slice(i, j);
      let k = j;
      while (k < n && /\s/.test(source[k])) k += 1;
      emit(out, CSS_NEXT_STYLE[source[k]] ?? 'plain', word);
      i = j;
      continue;
    }
    if (/[{};:,]/.test(ch)) {
      emit(out, 'punct', ch);
      i += 1;
      continue;
    }
    emit(out, 'plain', ch);
    i += 1;
  }
  return out;
};

module.exports = { langs: ['css'], highlight };
