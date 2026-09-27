'use strict';

const core = require('./core.js');
const { emit, readString } = core;

const JSON_LITERAL = {
  true: 'literal',
  false: 'literal',
  null: 'literal',
};

const highlight = (source) => {
  const out = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    if (ch === '"') {
      const { text, end } = readString(source, i);
      let k = end;
      while (k < n && /\s/.test(source[k])) k += 1;
      const kind = source[k] === ':' ? 'property' : 'string';
      emit(out, kind, text);
      i = end;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < n && /[0-9.eE+-]/.test(source[j])) j += 1;
      emit(out, 'number', source.slice(i, j));
      i = j;
      continue;
    }
    if (/[a-z]/.test(ch)) {
      let j = i;
      while (j < n && /[a-z]/.test(source[j])) j += 1;
      const word = source.slice(i, j);
      emit(out, JSON_LITERAL[word] ?? 'plain', word);
      i = j;
      continue;
    }
    if (/[{}[\],:]/.test(ch)) {
      emit(out, 'punct', ch);
      i += 1;
      continue;
    }
    emit(out, 'plain', ch);
    i += 1;
  }
  return out;
};

module.exports = { langs: ['json'], highlight };
