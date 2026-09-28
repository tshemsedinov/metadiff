'use strict';

const SQUOTE = '\x27';
const QUOTES = `${SQUOTE}"`;
const ANY_QUOTE = `${QUOTES}\``;

const OP3 = ['===', '!==', '>>>', '**=', '&&=', '||=', '??='];

const OP2 = [
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '??',
  '=>',
  '++',
  '--',
  '<<',
  '>>',
  '**',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
];

const EXPECT_STYLE = {
  function: 'function',
  class: 'className',
  type: 'className',
};

const emit = (out, style, text) => {
  if (!text) return;
  out.push({ text, style: style || 'plain' });
};

const highlightLines = (highlightLine) => (source) => {
  const lines = source.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (i) emit(out, 'plain', '\n');
    for (const t of highlightLine(lines[i])) out.push(t);
  }
  return out;
};

const tokensText = (out) => {
  let s = '';
  for (const t of out) s += t.text;
  return s;
};

const wordStyle = (words, style) => {
  const table = Object.create(null);
  for (const word of words) table[word] = style;
  return table;
};

const peekIdent = (source, i) => {
  if (!/[A-Za-z_$]/.test(source[i] || '')) return null;
  let j = i + 1;
  while (j < source.length && /[A-Za-z0-9_$]/.test(source[j])) j += 1;
  return source.slice(i, j);
};

const skipWs = (source, i) => {
  while (i < source.length && /\s/.test(source[i])) i += 1;
  return i;
};

const readUntilNl = (source, i) => {
  let j = i;
  const n = source.length;
  while (j < n && source[j] !== '\n') j += 1;
  return { text: source.slice(i, j), end: j };
};

const readBlockComment = (source, i) => {
  let j = i + 2;
  const n = source.length;
  while (j < n && !(source[j] === '*' && source[j + 1] === '/')) {
    j += 1;
  }
  j = Math.min(j + 2, n);
  return { text: source.slice(i, j), end: j };
};

const skipQuoted = (source, j) => {
  const q = source[j];
  j += 1;
  const n = source.length;
  while (j < n && source[j] !== q) {
    if (source[j] === '\\') j += 1;
    j += 1;
  }
  j += 1;
  return j;
};

const readJsNumber = (source, i) => {
  const n = source.length;
  let j = i;
  if (source.startsWith('0x', i) || source.startsWith('0X', i)) {
    j += 2;
    while (j < n && /[0-9a-fA-F_]/.test(source[j])) j += 1;
  } else if (source.startsWith('0b', i) || source.startsWith('0B', i)) {
    j += 2;
    while (j < n && /[01_]/.test(source[j])) j += 1;
  } else if (source.startsWith('0o', i) || source.startsWith('0O', i)) {
    j += 2;
    while (j < n && /[0-7_]/.test(source[j])) j += 1;
  } else {
    while (j < n && /[0-9_n.]/.test(source[j])) j += 1;
    if ('eE'.includes(source[j])) {
      j += 1;
      if ('+-'.includes(source[j])) j += 1;
      while (j < n && /[0-9_]/.test(source[j])) j += 1;
    }
  }
  return { text: source.slice(i, j), end: j };
};

const readJsOperator = (source, i) => {
  const two = source.slice(i, i + 2);
  const three = source.slice(i, i + 3);
  let j = i + 1;
  if (OP3.includes(three)) j = i + 3;
  else if (OP2.includes(two)) j = i + 2;
  return { text: source.slice(i, j), end: j };
};

const readString = (source, i) => {
  const q = source[i];
  let j = i + 1;
  const n = source.length;
  while (j < n) {
    if (source[j] === '\\') {
      j += 2;
      continue;
    }
    if (source[j] === q) {
      j += 1;
      break;
    }
    if (source[j] === '\n') break;
    j += 1;
  }
  return { text: source.slice(i, j), end: j };
};

const readTemplateInterp = (source, j) => {
  let depth = 1;
  const start = j;
  const n = source.length;
  while (j < n && depth > 0) {
    if (ANY_QUOTE.includes(source[j])) {
      j = skipQuoted(source, j);
      continue;
    }
    if (source[j] === '{') depth += 1;
    if (source[j] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
    j += 1;
  }
  return { expr: source.slice(start, j), end: j };
};

const styleConstant = ({ word }) =>
  /^[A-Z][A-Z0-9_]+$/.test(word) ? 'constant' : null;

const stylePascal = ({ word }) => (/^[A-Z]/.test(word) ? 'className' : null);

const styleCall = ({ after }) => (after === '(' ? 'function' : null);

module.exports = {
  SQUOTE,
  QUOTES,
  ANY_QUOTE,
  EXPECT_STYLE,
  emit,
  highlightLines,
  tokensText,
  wordStyle,
  peekIdent,
  skipWs,
  readUntilNl,
  readBlockComment,
  skipQuoted,
  readJsNumber,
  readJsOperator,
  readString,
  readTemplateInterp,
  styleConstant,
  stylePascal,
  styleCall,
};
