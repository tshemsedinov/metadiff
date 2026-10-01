'use strict';

const core = require('./core.js');
const { QUOTES, emit, scanWhile, blockCommentEnd, stringEnd } = core;

const CSS_NEXT_STYLE = { ':': 'property', '{': 'tag' };
const CSS_NAME = /[A-Za-z0-9_-]/;

const highlight = (source) => {
  const out = [];
  let i = 0;
  const take = (style, end) => {
    emit(out, style, source.slice(i, end));
    i = end;
  };
  while (i < source.length) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '*') {
      take('comment', blockCommentEnd(source, i));
    } else if (QUOTES.includes(ch)) {
      take('string', stringEnd(source, i));
    } else if (ch === '@') {
      take('keyword', scanWhile(source, i + 1, /[A-Za-z0-9-]/));
    } else if (ch === '#' || ch === '.') {
      const style = ch === '#' ? 'constant' : 'className';
      take(style, scanWhile(source, i + 1, CSS_NAME));
    } else if (/[0-9]/.test(ch)) {
      take('number', scanWhile(source, i, /[0-9.%]/));
    } else if (/[A-Za-z_-]/.test(ch)) {
      const end = scanWhile(source, i + 1, CSS_NAME);
      const after = source[scanWhile(source, end, /\s/)];
      take(CSS_NEXT_STYLE[after] ?? 'plain', end);
    } else {
      take(/[{};:,]/.test(ch) ? 'punct' : 'plain', i + 1);
    }
  }
  return out;
};

module.exports = { langs: ['css'], highlight };
