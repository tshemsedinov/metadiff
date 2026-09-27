'use strict';

const ansi = require('../ansi.js');
const { graphemes } = ansi;

const LCS_CELL_LIMIT = 250000;
const NOISY_TINY_SPANS = 6;
const WORD_REFINE_MIN = 0.6;
const PIECE_RE = /[A-Za-z_$][\w$]*|\d+|\s+|./g;
const CAMEL_RE = /[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+|./g;

const collapseSpans = (parts) => {
  const spans = [];
  for (const part of parts) {
    const last = spans[spans.length - 1];
    if (last && last.changed === part.changed) {
      last.text += part.text;
      continue;
    }
    spans.push({ text: part.text, changed: part.changed });
  }
  return spans;
};

const isNoisy = (spans) => {
  let tiny = 0;
  for (const span of spans) {
    if (span.changed && graphemes(span.text).length <= 2) tiny += 1;
  }
  return tiny > NOISY_TINY_SPANS;
};

const wholeChanged = (a, b) => ({
  oldSpans: a.length ? [{ text: a.join(''), changed: true }] : [],
  newSpans: b.length ? [{ text: b.join(''), changed: true }] : [],
});

const lcsLength = (a, b) => {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return 0;
  if (n * m > LCS_CELL_LIMIT) {
    let lo = 0;
    while (lo < n && lo < m && a[lo] === b[lo]) lo += 1;
    let hiA = n;
    let hiB = m;
    while (hiA > lo && hiB > lo && a[hiA - 1] === b[hiB - 1]) {
      hiA -= 1;
      hiB -= 1;
    }
    return lo + (n - hiA);
  }
  let prev = new Uint32Array(m + 1);
  let cur = new Uint32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    const ai = a[i - 1];
    for (let j = 1; j <= m; j++) {
      if (ai === b[j - 1]) cur[j] = prev[j - 1] + 1;
      else cur[j] = prev[j] > cur[j - 1] ? prev[j] : cur[j - 1];
    }
    const swap = prev;
    prev = cur;
    cur = swap;
    cur.fill(0);
  }
  return prev[m];
};

const tokenSimilarity = (a, b) => {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const lcs = lcsLength(a, b);
  return (2 * lcs) / (a.length + b.length);
};

const fillLcsTable = (a, b) => {
  const n = a.length;
  const m = b.length;
  const dp = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    const ai = a[i - 1];
    const row = dp[i];
    const prev = dp[i - 1];
    for (let j = 1; j <= m; j++) {
      if (ai === b[j - 1]) row[j] = prev[j - 1] + 1;
      else row[j] = prev[j] > row[j - 1] ? prev[j] : row[j - 1];
    }
  }
  return dp;
};

const tracebackLcs = (a, b, dp) => {
  const rev = new Array(a.length + b.length - dp[a.length][b.length]);
  let n = 0;
  let i = a.length;
  let j = b.length;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      rev[n++] = { type: 'eq', text: a[i - 1] };
      i -= 1;
      j -= 1;
      continue;
    }
    if (dp[i - 1][j] >= dp[i][j - 1]) {
      rev[n++] = { type: 'del', text: a[i - 1] };
      i -= 1;
      continue;
    }
    rev[n++] = { type: 'add', text: b[j - 1] };
    j -= 1;
  }
  while (i > 0) {
    rev[n++] = { type: 'del', text: a[i - 1] };
    i -= 1;
  }
  while (j > 0) {
    rev[n++] = { type: 'add', text: b[j - 1] };
    j -= 1;
  }
  rev.reverse();
  return rev;
};

const lcsOps = (a, b) => tracebackLcs(a, b, fillLcsTable(a, b));

const lcsSpans = (a, b) => {
  const oldParts = [];
  const newParts = [];
  for (const op of lcsOps(a, b)) {
    if (op.type === 'eq') {
      oldParts.push({ text: op.text, changed: false });
      newParts.push({ text: op.text, changed: false });
      continue;
    }
    if (op.type === 'del') {
      oldParts.push({ text: op.text, changed: true });
      continue;
    }
    newParts.push({ text: op.text, changed: true });
  }
  return {
    oldSpans: collapseSpans(oldParts),
    newSpans: collapseSpans(newParts),
  };
};

const trimSharedEnds = (a, b) => {
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo += 1;
  let hiA = a.length;
  let hiB = b.length;
  while (hiA > lo && hiB > lo && a[hiA - 1] === b[hiB - 1]) {
    hiA -= 1;
    hiB -= 1;
  }
  return {
    prefix: a.slice(0, lo),
    suffix: a.slice(hiA),
    midA: a.slice(lo, hiA),
    midB: b.slice(lo, hiB),
  };
};

const diffTokenMiddle = (midA, midB) => {
  if (midA.length * midB.length > LCS_CELL_LIMIT) {
    return wholeChanged(midA, midB);
  }
  if (midA.length === 0 && midB.length === 0) {
    return { oldSpans: [], newSpans: [] };
  }
  if (midA.length === 0 || midB.length === 0) return wholeChanged(midA, midB);
  return lcsSpans(midA, midB);
};

const joinAffix = (prefix, mid, suffix) => {
  const hasPrefix = prefix.length > 0;
  const hasSuffix = suffix.length > 0;
  const extra = (hasPrefix ? 1 : 0) + (hasSuffix ? 1 : 0);
  const parts = new Array(mid.length + extra);
  const at = hasPrefix ? 1 : 0;
  if (hasPrefix) {
    parts[0] = { text: prefix.join(''), changed: false };
  }
  for (let i = 0; i < mid.length; i++) parts[at + i] = mid[i];
  if (hasSuffix) {
    parts[at + mid.length] = { text: suffix.join(''), changed: false };
  }
  return collapseSpans(parts);
};

const joinTrimmedSpans = (prefix, mid, suffix) => ({
  oldSpans: joinAffix(prefix, mid.oldSpans, suffix),
  newSpans: joinAffix(prefix, mid.newSpans, suffix),
});

const diffTokens = (a, b) => {
  if (a.length === 0 && b.length === 0) {
    return { oldSpans: [], newSpans: [] };
  }
  if (a.length === 0 || b.length === 0) return wholeChanged(a, b);
  const trimmed = trimSharedEnds(a, b);
  const mid = diffTokenMiddle(trimmed.midA, trimmed.midB);
  const joined = joinTrimmedSpans(trimmed.prefix, mid, trimmed.suffix);
  if (isNoisy(joined.oldSpans) || isNoisy(joined.newSpans)) {
    return wholeChanged(a, b);
  }
  return joined;
};

const splitCamel = (part) => {
  if (!/[a-z]/.test(part) || !/[A-Z]/.test(part)) return [part];
  return part.match(CAMEL_RE) ?? [part];
};

const splitIdentWords = (part) => {
  const words = [];
  for (const chunk of part.split(/(_+)/)) {
    if (chunk === '') continue;
    if (chunk.includes('_')) {
      words.push(chunk);
      continue;
    }
    for (const word of splitCamel(chunk)) words.push(word);
  }
  return words;
};

const splitPieces = (text) => {
  if (text === '') return [];
  PIECE_RE.lastIndex = 0;
  const coarse = text.match(PIECE_RE) ?? [];
  const pieces = [];
  for (const part of coarse) {
    for (const word of splitIdentWords(part)) pieces.push(word);
  }
  return pieces;
};

const spansFromWordOps = (ops) => {
  const oldParts = [];
  const newParts = [];
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (op.type === 'eq') {
      oldParts.push({ text: op.text, changed: false });
      newParts.push({ text: op.text, changed: false });
      i += 1;
      continue;
    }
    const dels = [];
    const adds = [];
    while (i < ops.length && ops[i].type !== 'eq') {
      if (ops[i].type === 'del') dels.push(ops[i].text);
      else adds.push(ops[i].text);
      i += 1;
    }
    const one = dels.length === 1 && adds.length === 1;
    const close =
      one &&
      tokenSimilarity(graphemes(dels[0]), graphemes(adds[0])) >=
        WORD_REFINE_MIN;
    if (close) {
      const inner = diffTokens(graphemes(dels[0]), graphemes(adds[0]));
      for (const span of inner.oldSpans) oldParts.push(span);
      for (const span of inner.newSpans) newParts.push(span);
      continue;
    }
    if (dels.length) {
      oldParts.push({ text: dels.join(''), changed: true });
    }
    if (adds.length) {
      newParts.push({ text: adds.join(''), changed: true });
    }
  }
  return {
    oldSpans: collapseSpans(oldParts),
    newSpans: collapseSpans(newParts),
  };
};

const diffChars = (oldText, newText) => {
  const a = splitPieces(oldText);
  const b = splitPieces(newText);
  if (a.length === 0 && b.length === 0) {
    return { oldSpans: [], newSpans: [] };
  }
  if (a.length === 0 || b.length === 0) return wholeChanged(a, b);
  const { prefix, suffix, midA, midB } = trimSharedEnds(a, b);
  let mid;
  if (midA.length === 0 && midB.length === 0) {
    mid = { oldSpans: [], newSpans: [] };
  } else if (midA.length === 0 || midB.length === 0) {
    mid = wholeChanged(midA, midB);
  } else if (midA.length * midB.length > LCS_CELL_LIMIT) {
    mid = wholeChanged(midA, midB);
  } else {
    mid = spansFromWordOps(lcsOps(midA, midB));
  }
  const oldSpans = joinAffix(prefix, mid.oldSpans, suffix);
  const newSpans = joinAffix(prefix, mid.newSpans, suffix);
  return { oldSpans, newSpans };
};

module.exports = { tokenSimilarity, diffChars };
