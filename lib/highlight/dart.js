'use strict';

const core = require('./core.js');
const { QUOTES, IDENT_START, IDENT_CHAR, EXPECT_STYLE } = core;
const { words, emit, wordStyles, appendNode, scanWhile } = core;
const { lineEnd, blockCommentEnd, numberEnd, operatorEnd } = core;
const { highlightInterpolated, nameStyle } = core;

const STORAGE = words(`
  abstract as base class const covariant deferred enum export extends
  extension external factory final get hide implements import interface late
  library mixin on operator part required sealed set show static typedef var
  with
`);

const CONTROL = words(`
  assert async await break case catch continue default do else for if in is
  new rethrow return switch sync throw try when while yield
`);

const LITERALS = words('true false null this super');

const TYPES = words('void dynamic Never int double num bool');

const NEXT_EXPECT = wordStyles({
  class: ['class', 'mixin', 'enum', 'extension'],
  type: ['typedef'],
});

const WORD_STYLE = wordStyles({
  control: CONTROL,
  literal: LITERALS,
  storage: STORAGE,
  type: TYPES,
});

const stringOpen = (source, i) => {
  const raw = source[i] === 'r';
  const at = raw ? i + 1 : i;
  let quote = '';
  if (source.startsWith(`'''`, at) || source.startsWith('"""', at)) {
    quote = source.slice(at, at + 3);
  } else if (QUOTES.includes(source[at] || '')) {
    quote = source[at];
  }
  if (!quote) return null;
  const multiline = quote.length === 3;
  const kind = { style: 'string', quote, raw, multiline, dollarIdent: true };
  return { body: at + quote.length, kind };
};

const highlight = (source) => {
  const out = [];
  let i = 0;
  let expectName = null;
  const take = (style, end) => {
    emit(out, style, source.slice(i, end));
    i = end;
  };
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    const open = stringOpen(source, i);
    if (ch === '/' && next === '/') {
      take('comment', lineEnd(source, i));
    } else if (ch === '/' && next === '*') {
      take('comment', blockCommentEnd(source, i));
    } else if (open) {
      const node = highlightInterpolated(
        source,
        i,
        open.body,
        open.kind,
        highlight,
      );
      i = appendNode(out, node);
      expectName = null;
    } else if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(next || ''))) {
      take('number', numberEnd(source, i));
    } else if (ch === '@' || ch === '#') {
      const style = ch === '@' ? 'decorator' : 'constant';
      take(style, scanWhile(source, i + 1, IDENT_CHAR));
      expectName = null;
    } else if (IDENT_START.test(ch)) {
      const end = scanWhile(source, i + 1, IDENT_CHAR);
      const word = source.slice(i, end);
      const after = source[scanWhile(source, end, /\s/)];
      const style =
        WORD_STYLE[word] ||
        EXPECT_STYLE[expectName] ||
        nameStyle(word, after) ||
        'variable';
      const nextExpect = NEXT_EXPECT[word] ?? null;
      take(style, end);
      expectName = EXPECT_STYLE[expectName] ? null : nextExpect;
    } else if (/[=<>!+\-*/%&|^~?:]/.test(ch)) {
      take('operator', operatorEnd(source, i));
      expectName = null;
    } else {
      take(/[{}()[\];,.]/.test(ch) ? 'punct' : 'plain', i + 1);
    }
  }
  return out;
};

module.exports = { langs: ['dart'], highlight };
