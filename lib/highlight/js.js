'use strict';

const core = require('./core.js');
const { QUOTES, IDENT_START, IDENT_CHAR, EXPECT_STYLE } = core;
const { words, emit, wordStyles, appendNode, scanWhile } = core;
const { lineEnd, blockCommentEnd, stringEnd, numberEnd, operatorEnd } = core;
const { pushInterpolation, highlightInterpolated, nameStyle } = core;

const OPTIONS = {
  js: {},
  mjs: {},
  ts: { ts: true },
  jsx: { jsx: true },
  tsx: { ts: true, jsx: true },
};

const OP_CHARS = '=!+-*%>&|^~?:/<';
const PUNCT_CHARS = '{}()[];,.';
const DIGITS = '0123456789';
const JSX_NAME = /[A-Za-z0-9_$.:-]/;
const JSX_TEXT = /[^<{]/;
const REGEX_AFTER_OP = /[=(:,[?!&|{};]$/;
const REGEX_AFTER_WORD = /(?:return|case|throw|=>|typeof|void)$/;

const TEMPLATE = {
  style: 'template',
  quote: '`',
  raw: false,
  multiline: true,
  dollarIdent: false,
};

const STORAGE = words(`
  const let var function class extends static async get set constructor new
  typeof instanceof void delete yield await import export from as default
  type interface implements enum namespace module declare abstract readonly
  private public protected override satisfies
`);

const CONTROL = words(`
  if else for while do switch case break continue return throw try catch
  finally with of in
`);

const LITERALS = words('true false null undefined NaN Infinity this super');

const TYPES = words(`
  string number boolean symbol bigint object any unknown never void keyof
  infer unique asserts is
`);

const BUILTINS = words(`
  console Math JSON Date Array Object String Number Boolean Map Set WeakMap
  WeakSet Promise Error RegExp Symbol Proxy Reflect Intl Buffer process module
  exports require global globalThis window document parseInt parseFloat isNaN
  isFinite encodeURI decodeURI encodeURIComponent decodeURIComponent
  setTimeout setInterval clearTimeout clearInterval fetch URL URLSearchParams
`);

const NEXT_EXPECT = wordStyles({
  function: ['function'],
  class: ['class', 'interface', 'enum'],
  type: ['type'],
});

const wordTable = (types) =>
  wordStyles({
    control: CONTROL,
    literal: LITERALS,
    className: BUILTINS,
    storage: STORAGE,
    type: types,
  });

const WORD_STYLE = wordTable(TYPES.filter((word) => STORAGE.includes(word)));
const TS_WORD_STYLE = wordTable(TYPES);

const tailText = (out, size) => {
  let text = '';
  for (let i = out.length - 1; i >= 0; i--) {
    text = out[i].text + text;
    if (text.trimEnd().length >= size) break;
  }
  return text;
};

const isRegexContext = (out) => {
  const prev = tailText(out, 6).trimEnd();
  return !prev || REGEX_AFTER_OP.test(prev) || REGEX_AFTER_WORD.test(prev);
};

const assignStyle = (source, k) => {
  const rhs = scanWhile(source, k + 1, /\s/);
  if (source.startsWith('async', rhs)) return 'function';
  if (source.startsWith('function', rhs)) return 'function';
  return source[rhs] === '(' ? 'function' : 'variable';
};

const trailStyle = (source, k, out) => {
  if (source[k] === '=') return assignStyle(source, k);
  return tailText(out, 1).endsWith('.') ? 'property' : 'variable';
};

const regexEnd = (source, i) => {
  let j = i + 1;
  const n = source.length;
  while (j < n) {
    if (source[j] === '\\') {
      j += 2;
      continue;
    }
    if (source[j] === '[') {
      j += 1;
      while (j < n && source[j] !== ']') {
        if (source[j] === '\\') j += 1;
        j += 1;
      }
      j += 1;
      continue;
    }
    if (source[j] === '/') return scanWhile(source, j + 1, /[a-z]/i);
    if (source[j] === '\n') break;
    j += 1;
  }
  return j;
};

const isJsxTagStart = (source, i) => {
  if (i > 0 && IDENT_CHAR.test(source[i - 1])) return false;
  const next = source[i + 1];
  if (next === '>' || next === '/') return true;
  if (!IDENT_START.test(next || '')) return false;
  const nameEnd = scanWhile(source, i + 1, JSX_NAME);
  const after = source[scanWhile(source, nameEnd, /\s/)];
  if (after === '>' || after === '/' || after === '{') return true;
  return IDENT_START.test(after || '');
};

const jsxNameStyle = (name) => {
  if (/^[A-Z]/.test(name) || name.includes('.')) return 'className';
  return 'tag';
};

const pushJsxExpr = (out, source, i, inner) => {
  emit(out, 'interpolation', '{');
  return pushInterpolation(out, source, i + 1, inner);
};

const highlightJsxTagTail = (source, start, inner, out) => {
  let i = start;
  const take = (style, end) => {
    emit(out, style, source.slice(i, end));
    i = end;
  };
  while (i < source.length) {
    const ch = source[i];
    if (ch === '>') {
      take('punct', i + 1);
      return { end: i, selfClosing: false };
    }
    if (ch === '/' && source[i + 1] === '>') {
      take('punct', i + 2);
      return { end: i, selfClosing: true };
    }
    if (ch === '{') i = pushJsxExpr(out, source, i, inner);
    else if (QUOTES.includes(ch)) take('string', stringEnd(source, i));
    else if (IDENT_START.test(ch)) take('attr', scanWhile(source, i, JSX_NAME));
    else if (/\s/.test(ch)) take('plain', i + 1);
    else take('punct', i + 1);
  }
  return { end: i, selfClosing: false };
};

const highlightJsxElement = (source, start, inner) => {
  const out = [];
  let i = start + 1;
  emit(out, 'punct', '<');
  const closing = source[i] === '/';
  if (closing) {
    emit(out, 'punct', '/');
    i += 1;
  }
  const nameEnd = scanWhile(source, i, JSX_NAME);
  const name = source.slice(i, nameEnd);
  emit(out, jsxNameStyle(name), name);
  const tail = highlightJsxTagTail(source, nameEnd, inner, out);
  i = tail.end;
  if (closing || tail.selfClosing) return { tokens: out, end: i };
  while (i < source.length) {
    if (source.startsWith('</', i)) {
      const end = appendNode(out, highlightJsxElement(source, i, inner));
      return { tokens: out, end };
    }
    if (source[i] === '{') {
      i = pushJsxExpr(out, source, i, inner);
    } else if (source[i] === '<' && isJsxTagStart(source, i)) {
      i = appendNode(out, highlightJsxElement(source, i, inner));
    } else {
      const end = source[i] === '<' ? i + 1 : scanWhile(source, i, JSX_TEXT);
      emit(out, 'plain', source.slice(i, end));
      i = end;
    }
  }
  return { tokens: out, end: i };
};

const highlightJsFamily = (source, options) => {
  const table = options.ts ? TS_WORD_STYLE : WORD_STYLE;
  const inner = (expr) => highlightJsFamily(expr, options);
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
    if (ch === '/' && next === '/') {
      take('comment', lineEnd(source, i));
    } else if (ch === '/' && next === '*') {
      take('comment', blockCommentEnd(source, i));
    } else if (ch === '/' && isRegexContext(out)) {
      take('regex', regexEnd(source, i));
    } else if (ch === '<' && options.jsx && isJsxTagStart(source, i)) {
      i = appendNode(out, highlightJsxElement(source, i, inner));
      expectName = null;
    } else if (ch === '`') {
      const node = highlightInterpolated(source, i, i + 1, TEMPLATE, inner);
      i = appendNode(out, node);
    } else if (QUOTES.includes(ch)) {
      take('string', stringEnd(source, i));
    } else if (ch === '@') {
      take('decorator', scanWhile(source, i + 1, IDENT_CHAR));
      expectName = null;
    } else if (
      DIGITS.includes(ch) ||
      (ch === '.' && DIGITS.includes(next || ''))
    ) {
      take('number', numberEnd(source, i));
    } else if (IDENT_START.test(ch)) {
      const end = scanWhile(source, i + 1, IDENT_CHAR);
      const word = source.slice(i, end);
      const k = scanWhile(source, end, /\s/);
      const style =
        EXPECT_STYLE[expectName] ||
        table[word] ||
        nameStyle(word, source[k]) ||
        trailStyle(source, k, out);
      const nextExpect = NEXT_EXPECT[word] ?? null;
      take(style, end);
      expectName = EXPECT_STYLE[expectName] ? null : nextExpect;
    } else if (OP_CHARS.includes(ch)) {
      take('operator', operatorEnd(source, i));
      expectName = null;
    } else {
      take(PUNCT_CHARS.includes(ch) ? 'punct' : 'plain', i + 1);
    }
  }
  return out;
};

const highlight = (source, lang) => highlightJsFamily(source, OPTIONS[lang]);

module.exports = {
  langs: ['js', 'mjs', 'ts', 'jsx', 'tsx'],
  aliases: {
    javascript: 'js',
    typescript: 'ts',
    cjs: 'js',
    dts: 'ts',
  },
  highlight,
};
