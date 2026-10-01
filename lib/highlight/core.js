'use strict';

const QUOTES = `'"`;
const ANY_QUOTE = `'"\``;
const IDENT_START = /[A-Za-z_$]/;
const IDENT_CHAR = /[A-Za-z0-9_$]/;
const CONSTANT_RE = /^[A-Z][A-Z0-9_]+$/;

const words = (text) => text.trim().split(/\s+/);

const OP3 = words('=== !== >>> **= &&= ||= ??=');
const OP2 = words(
  '== != <= >= && || ?? => ++ -- << >> ** += -= *= /= %= &= |= ^=',
);

const EXPECT_STYLE = {
  function: 'function',
  class: 'className',
  type: 'className',
};

const RADIX_DIGIT = { x: /[0-9a-fA-F_]/, b: /[01_]/, o: /[0-7_]/ };

const emit = (out, style, text) => {
  if (text) out.push({ text, style });
};

const highlightLines =
  (highlightLine, separator = '\n') =>
  (source) => {
    const lines = source.split(separator);
    const out = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (i) emit(out, 'plain', '\n');
      for (const token of highlightLine(lines[i])) out.push(token);
    }
    return out;
  };

const tokensText = (out) => {
  let text = '';
  for (const token of out) text += token.text;
  return text;
};

const wordStyles = (groups) => {
  const table = Object.create(null);
  for (const style of Object.keys(groups)) {
    for (const word of groups[style]) table[word] = style;
  }
  return table;
};

const appendNode = (out, node) => {
  for (const token of node.tokens) out.push(token);
  return node.end;
};

const scanWhile = (source, start, re) => {
  let i = start;
  while (i < source.length && re.test(source[i])) i += 1;
  return i;
};

const lineEnd = (source, i) => {
  const end = source.indexOf('\n', i);
  return end < 0 ? source.length : end;
};

const blockCommentEnd = (source, i) => {
  const end = source.indexOf('*/', i + 2);
  return end < 0 ? source.length : end + 2;
};

const quotedEnd = (source, start) => {
  const quote = source[start];
  let j = start + 1;
  while (j < source.length && source[j] !== quote) {
    if (source[j] === '\\') j += 1;
    j += 1;
  }
  return j + 1;
};

const stringEnd = (source, i) => {
  const quote = source[i];
  let j = i + 1;
  while (j < source.length) {
    if (source[j] === '\\') {
      j += 2;
      continue;
    }
    if (source[j] === quote) return j + 1;
    if (source[j] === '\n') break;
    j += 1;
  }
  return j;
};

const numberEnd = (source, i) => {
  const prefix = source[i] === '0' ? source[i + 1] : undefined;
  const radix = prefix ? RADIX_DIGIT[prefix.toLowerCase()] : undefined;
  if (radix) return scanWhile(source, i + 2, radix);
  let j = scanWhile(source, i, /[0-9_n.]/);
  if (source[j] !== 'e' && source[j] !== 'E') return j;
  j += 1;
  if (source[j] === '+' || source[j] === '-') j += 1;
  return scanWhile(source, j, /[0-9_]/);
};

const operatorEnd = (source, i) => {
  if (OP3.includes(source.slice(i, i + 3))) return i + 3;
  if (OP2.includes(source.slice(i, i + 2))) return i + 2;
  return i + 1;
};

const interpEnd = (source, start) => {
  let depth = 1;
  let j = start;
  while (j < source.length) {
    const ch = source[j];
    if (ANY_QUOTE.includes(ch)) {
      j = quotedEnd(source, j);
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
    j += 1;
  }
  return j;
};

const pushInterpolation = (out, source, start, inner) => {
  const end = interpEnd(source, start);
  for (const token of inner(source.slice(start, end))) out.push(token);
  if (source[end] !== '}') return end;
  emit(out, 'interpolation', '}');
  return end + 1;
};

const highlightInterpolated = (source, start, body, kind, inner) => {
  const { style, quote, raw } = kind;
  const n = source.length;
  const out = [];
  emit(out, style, source.slice(start, body));
  let j = body;
  let buf = '';
  const flush = () => {
    emit(out, style, buf);
    buf = '';
  };
  while (j < n) {
    const ch = source[j];
    if (!raw && ch === '\\') {
      flush();
      emit(out, 'escape', source.slice(j, j + 2));
      j += 2;
      continue;
    }
    if (source.startsWith(quote, j)) {
      flush();
      emit(out, style, quote);
      j += quote.length;
      break;
    }
    if (!raw && ch === '$' && source[j + 1] === '{') {
      flush();
      emit(out, 'interpolation', '${');
      j = pushInterpolation(out, source, j + 2, inner);
      continue;
    }
    const isDollar = !raw && ch === '$' && kind.dollarIdent;
    if (isDollar && IDENT_START.test(source[j + 1] || '')) {
      flush();
      const end = scanWhile(source, j + 1, IDENT_CHAR);
      emit(out, 'interpolation', source.slice(j, end));
      j = end;
      continue;
    }
    if (!kind.multiline && ch === '\n') break;
    buf += ch;
    j += 1;
  }
  flush();
  return { tokens: out, end: j };
};

const nameStyle = (word, after) => {
  if (CONSTANT_RE.test(word)) return 'constant';
  if (/^[A-Z]/.test(word)) return 'className';
  if (after === '(') return 'function';
  return null;
};

module.exports = {
  QUOTES,
  IDENT_START,
  IDENT_CHAR,
  EXPECT_STYLE,
  words,
  emit,
  highlightLines,
  tokensText,
  wordStyles,
  appendNode,
  scanWhile,
  lineEnd,
  blockCommentEnd,
  quotedEnd,
  stringEnd,
  numberEnd,
  operatorEnd,
  pushInterpolation,
  highlightInterpolated,
  nameStyle,
};
