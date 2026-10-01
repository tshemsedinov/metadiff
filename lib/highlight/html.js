'use strict';

const core = require('./core.js');
const { QUOTES, emit, scanWhile, quotedEnd } = core;

const colorHtmlTag = (tag) => {
  const out = [];
  let i = 1;
  const take = (style, end) => {
    emit(out, style, tag.slice(i, end));
    i = end;
  };
  emit(out, 'punct', '<');
  if (tag[i] === '/') take('punct', i + 1);
  take('tag', scanWhile(tag, i, /[A-Za-z0-9:-]/));
  while (i < tag.length) {
    const ch = tag[i];
    if (ch === '>' || (ch === '/' && tag[i + 1] === '>')) {
      take('punct', tag.length);
    } else if (/\s/.test(ch)) {
      take('plain', i + 1);
    } else if (QUOTES.includes(ch)) {
      const close = tag.indexOf(ch, i + 1);
      take('string', close < 0 ? tag.length : close + 1);
    } else if (/[A-Za-z_:]/.test(ch)) {
      take('attr', scanWhile(tag, i + 1, /[A-Za-z0-9_:.-]/));
    } else {
      take('punct', i + 1);
    }
  }
  return out;
};

const tagEnd = (source, i) => {
  const n = source.length;
  let j = i + 1;
  while (j < n && source[j] !== '>') {
    j = QUOTES.includes(source[j]) ? quotedEnd(source, j) : j + 1;
  }
  return j < n ? j + 1 : j;
};

const highlight = (source) => {
  const out = [];
  const n = source.length;
  let i = 0;
  while (i < n) {
    let end;
    if (source.startsWith('<!--', i)) {
      const close = source.indexOf('-->', i + 4);
      end = close < 0 ? n : close + 3;
      emit(out, 'comment', source.slice(i, end));
    } else if (source[i] === '<') {
      end = tagEnd(source, i);
      for (const token of colorHtmlTag(source.slice(i, end))) out.push(token);
    } else {
      const next = source.indexOf('<', i + 1);
      end = next < 0 ? n : next;
      emit(out, 'plain', source.slice(i, end));
    }
    i = end;
  }
  return out;
};

module.exports = { langs: ['html'], aliases: { htm: 'html' }, highlight };
