'use strict';

const { graphemes } = require('../term/ansi.js');

const LCS_CELL_LIMIT = 250000;
const NOISY_TINY_SPANS = 6;
const WORD_REFINE_MIN = 0.6;
const WHOLE_MIN_SHARED = 0.25;
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

const sharedEnds = (a, b) => {
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo += 1;
  let hiA = a.length;
  let hiB = b.length;
  while (hiA > lo && hiB > lo && a[hiA - 1] === b[hiB - 1]) {
    hiA -= 1;
    hiB -= 1;
  }
  return { lo, hiA, hiB };
};

const lcsLength = (a, b) => {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return 0;
  if (n * m > LCS_CELL_LIMIT) {
    const { lo, hiA } = sharedEnds(a, b);
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

const lcsTable = (a, b) => {
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

const lcsOps = (a, b) => {
  const dp = lcsTable(a, b);
  const rev = new Array(a.length + b.length - dp[a.length][b.length]);
  let n = 0;
  let i = a.length;
  let j = b.length;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      rev[n++] = { type: 'eq', text: a[i - 1] };
      i -= 1;
      j -= 1;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      rev[n++] = { type: 'del', text: a[i - 1] };
      i -= 1;
    } else {
      rev[n++] = { type: 'add', text: b[j - 1] };
      j -= 1;
    }
  }
  for (; i > 0; i--) rev[n++] = { type: 'del', text: a[i - 1] };
  for (; j > 0; j--) rev[n++] = { type: 'add', text: b[j - 1] };
  return rev.reverse();
};

const opsSpans = (ops) => {
  const oldParts = [];
  const newParts = [];
  for (const op of ops) {
    if (op.type !== 'add') {
      oldParts.push({ text: op.text, changed: op.type === 'del' });
    }
    if (op.type !== 'del') {
      newParts.push({ text: op.text, changed: op.type === 'add' });
    }
  }
  return {
    oldSpans: collapseSpans(oldParts),
    newSpans: collapseSpans(newParts),
  };
};

const joinAffix = (prefix, mid, suffix) => {
  const parts = [];
  if (prefix.length) parts.push({ text: prefix.join(''), changed: false });
  for (const span of mid) parts.push(span);
  if (suffix.length) parts.push({ text: suffix.join(''), changed: false });
  return collapseSpans(parts);
};

const diffTrimmed = (a, b, spansOfOps) => {
  const { lo, hiA, hiB } = sharedEnds(a, b);
  const midA = a.slice(lo, hiA);
  const midB = b.slice(lo, hiB);
  const tooBig = midA.length * midB.length > LCS_CELL_LIMIT;
  const whole = !midA.length || !midB.length || tooBig;
  const mid = whole ? wholeChanged(midA, midB) : spansOfOps(lcsOps(midA, midB));
  const prefix = a.slice(0, lo);
  const suffix = a.slice(hiA);
  return {
    oldSpans: joinAffix(prefix, mid.oldSpans, suffix),
    newSpans: joinAffix(prefix, mid.newSpans, suffix),
  };
};

const diffTokens = (a, b) => {
  const spans = diffTrimmed(a, b, opsSpans);
  if (isNoisy(spans.oldSpans) || isNoisy(spans.newSpans)) {
    return wholeChanged(a, b);
  }
  return spans;
};

const splitCamel = (part) => {
  if (!/[a-z]/.test(part) || !/[A-Z]/.test(part)) return [part];
  return part.match(CAMEL_RE) ?? [part];
};

const splitPieces = (text) => {
  PIECE_RE.lastIndex = 0;
  const pieces = [];
  for (const part of text.match(PIECE_RE) ?? []) {
    for (const chunk of part.split(/(_+)/)) {
      if (chunk === '') continue;
      if (chunk.includes('_')) {
        pieces.push(chunk);
        continue;
      }
      for (const word of splitCamel(chunk)) pieces.push(word);
    }
  }
  return pieces;
};

const refineWordOps = (ops) => {
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
    if (dels.length === 1 && adds.length === 1) {
      const delChars = graphemes(dels[0]);
      const addChars = graphemes(adds[0]);
      if (tokenSimilarity(delChars, addChars) >= WORD_REFINE_MIN) {
        const inner = diffTokens(delChars, addChars);
        for (const span of inner.oldSpans) oldParts.push(span);
        for (const span of inner.newSpans) newParts.push(span);
        continue;
      }
    }
    if (dels.length) oldParts.push({ text: dels.join(''), changed: true });
    if (adds.length) newParts.push({ text: adds.join(''), changed: true });
  }
  return {
    oldSpans: collapseSpans(oldParts),
    newSpans: collapseSpans(newParts),
  };
};

const opRuns = (ops) => {
  const runs = [];
  for (const op of ops) {
    const eq = op.type === 'eq';
    let run = runs[runs.length - 1];
    if (!run || run.eq !== eq) {
      run = { eq, del: [], add: [] };
      runs.push(run);
    }
    if (op.type !== 'add') run.del.push(op.text);
    if (op.type !== 'del') run.add.push(op.text);
  }
  return runs;
};

const textSize = (parts) => parts.join('').length;

const editSize = (run) => Math.max(textSize(run.del), textSize(run.add));

const absorbTinyEquals = (runs) => {
  for (let k = 1; k < runs.length - 1; k++) {
    const before = runs[k - 1];
    const eq = runs[k];
    const after = runs[k + 1];
    if (!eq.eq) continue;
    const size = textSize(eq.del);
    if (size > editSize(before) || size > editSize(after)) continue;
    const del = [...before.del, ...eq.del, ...after.del];
    const add = [...before.add, ...eq.add, ...after.add];
    runs.splice(k - 1, 3, { eq: false, del, add });
    k = 0;
  }
  return runs;
};

const runOps = (runs) => {
  const ops = [];
  for (const run of runs) {
    if (run.eq) {
      for (const text of run.del) ops.push({ type: 'eq', text });
      continue;
    }
    for (const text of run.del) ops.push({ type: 'del', text });
    for (const text of run.add) ops.push({ type: 'add', text });
  }
  return ops;
};

const wordSpans = (ops) => refineWordOps(runOps(absorbTinyEquals(opRuns(ops))));

const sharedShare = (spans) => {
  let shared = 0;
  let total = 0;
  for (const span of spans) {
    const size = span.text.replace(/\s/g, '').length;
    total += size;
    if (!span.changed) shared += size;
  }
  return total === 0 ? 1 : shared / total;
};

const diffChars = (oldText, newText) => {
  const a = splitPieces(oldText);
  const b = splitPieces(newText);
  const { oldSpans, newSpans } = diffTrimmed(a, b, wordSpans);
  const oldShare = sharedShare(oldSpans);
  const newShare = sharedShare(newSpans);
  if (oldShare < WHOLE_MIN_SHARED && newShare < WHOLE_MIN_SHARED) {
    return wholeChanged(a, b);
  }
  return { oldSpans, newSpans };
};

module.exports = { tokenSimilarity, diffChars };
