'use strict';

const core = require('./core.js');
const { SQUOTE, emit, skipQuoted } = core;

const colorHtmlTag = (tag) => {
  const out = [];
  let i = 1;
  const n = tag.length;
  emit(out, 'punct', '<');
  if (tag[i] === '/') {
    emit(out, 'punct', '/');
    i += 1;
  }
  let j = i;
  while (j < n && /[A-Za-z0-9:-]/.test(tag[j])) j += 1;
  emit(out, 'tag', tag.slice(i, j));
  i = j;
  while (i < n) {
    if (tag[i] === '>' || (tag[i] === '/' && tag[i + 1] === '>')) {
      emit(out, 'punct', tag.slice(i));
      break;
    }
    if (/\s/.test(tag[i])) {
      emit(out, 'plain', tag[i]);
      i += 1;
      continue;
    }
    if (tag[i] === '"' || tag[i] === SQUOTE) {
      const q = tag[i];
      let k = i + 1;
      while (k < n && tag[k] !== q) k += 1;
      k = Math.min(k + 1, n);
      emit(out, 'string', tag.slice(i, k));
      i = k;
      continue;
    }
    if (/[A-Za-z_:]/.test(tag[i])) {
      let k = i + 1;
      while (k < n && /[A-Za-z0-9_:.-]/.test(tag[k])) k += 1;
      emit(out, 'attr', tag.slice(i, k));
      i = k;
      continue;
    }
    emit(out, 'punct', tag[i]);
    i += 1;
  }
  return out;
};

const highlight = (source) => {
  const out = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    if (source.startsWith('<!--', i)) {
      let j = source.indexOf('-->', i + 4);
      j = j === -1 ? n : j + 3;
      emit(out, 'comment', source.slice(i, j));
      i = j;
      continue;
    }
    if (source[i] === '<') {
      let j = i + 1;
      while (j < n && source[j] !== '>') {
        if (source[j] === '"' || source[j] === SQUOTE) {
          j = skipQuoted(source, j);
          continue;
        }
        j += 1;
      }
      if (j < n) j += 1;
      for (const t of colorHtmlTag(source.slice(i, j))) out.push(t);
      i = j;
      continue;
    }
    let j = i + 1;
    while (j < n && source[j] !== '<' && !source.startsWith('<!--', j)) {
      j += 1;
    }
    emit(out, 'plain', source.slice(i, j));
    i = j;
  }
  return out;
};

module.exports = { langs: ['html'], aliases: { htm: 'html' }, highlight };
