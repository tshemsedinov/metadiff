'use strict';

const { emit, wordStyles, scanWhile, stringEnd } = require('./core.js');

const JSON_LITERAL = wordStyles({ literal: ['true', 'false', 'null'] });

const highlight = (source) => {
  const out = [];
  let i = 0;
  const take = (style, end) => {
    emit(out, style, source.slice(i, end));
    i = end;
  };
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"') {
      const end = stringEnd(source, i);
      const after = source[scanWhile(source, end, /\s/)];
      take(after === ':' ? 'property' : 'string', end);
    } else if (/[0-9-]/.test(ch)) {
      take('number', scanWhile(source, i, /[0-9.eE+-]/));
    } else if (/[a-z]/.test(ch)) {
      const end = scanWhile(source, i, /[a-z]/);
      take(JSON_LITERAL[source.slice(i, end)] ?? 'plain', end);
    } else {
      take(/[{}[\],:]/.test(ch) ? 'punct' : 'plain', i + 1);
    }
  }
  return out;
};

module.exports = { langs: ['json'], highlight };
