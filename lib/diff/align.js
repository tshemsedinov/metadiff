'use strict';

const { diffChars, tokenSimilarity } = require('./inline.js');

const PAIR_MIN_SIM = 0.3;
const PAIR_HEAD_WEIGHT = 0.4;
const PAIR_TOKEN_WEIGHT = 0.6;
const TOKEN_RE = /[A-Za-z_$][\w$]*|\d+|[^\s]/g;
const CTX_TYPES = ['ctx', 'warn', 'note', 'noteSep'];

const isCtxType = (type) => CTX_TYPES.includes(type);

const lineTokens = (text) => {
  TOKEN_RE.lastIndex = 0;
  return text.match(TOKEN_RE) ?? [];
};

const pairScore = (a, b) => {
  const token = tokenSimilarity(a, b);
  const head = a[0] && a[0] === b[0] ? 1 : 0;
  return PAIR_HEAD_WEIGHT * head + PAIR_TOKEN_WEIGHT * token;
};

const comparePair = (left, right) => {
  if (right.score !== left.score) return right.score - left.score;
  if (left.dist !== right.dist) return left.dist - right.dist;
  if (left.i !== right.i) return left.i - right.i;
  return left.j - right.j;
};

const pairCandidates = (delTexts, addTexts) => {
  if (!delTexts.length || !addTexts.length) return [];
  const delTokens = delTexts.map(lineTokens);
  const addTokens = addTexts.map(lineTokens);
  const candidates = [];
  for (let i = 0; i < delTexts.length; i++) {
    for (let j = 0; j < addTexts.length; j++) {
      const score = pairScore(delTokens[i], addTokens[j]);
      if (score < PAIR_MIN_SIM) continue;
      const dist = Math.abs(i - j);
      candidates.push({ i, j, score, dist });
    }
  }
  return candidates.sort(comparePair);
};

const pairIndices = (delTexts, addTexts) => {
  const delToAdd = new Array(delTexts.length).fill(-1);
  const addUsed = new Array(addTexts.length).fill(false);
  for (const pair of pairCandidates(delTexts, addTexts)) {
    if (delToAdd[pair.i] >= 0 || addUsed[pair.j]) continue;
    delToAdd[pair.i] = pair.j;
    addUsed[pair.j] = true;
  }
  if (delTexts.length !== addTexts.length) return delToAdd;
  for (let i = 0; i < delTexts.length; i++) {
    if (delToAdd[i] >= 0 || addUsed[i]) continue;
    delToAdd[i] = i;
    addUsed[i] = true;
  }
  return delToAdd;
};

const pairBlock = (block) => {
  const dels = block.filter((line) => line.type === 'del');
  const adds = block.filter((line) => line.type === 'add');
  const delToAdd = pairIndices(
    dels.map((line) => line.text),
    adds.map((line) => line.text),
  );
  return { dels, adds, delToAdd };
};

const wholeSpans = (text, changed) => [{ text, changed }];

const attachInline = (lines) => {
  const painted = lines.map((line) => ({ ...line }));
  const { dels, adds, delToAdd } = pairBlock(painted);
  for (const add of adds) add.spans = wholeSpans(add.text, true);
  for (let i = 0; i < dels.length; i++) {
    const j = delToAdd[i];
    if (j < 0) {
      dels[i].spans = wholeSpans(dels[i].text, true);
      continue;
    }
    const diff = diffChars(dels[i].text, adds[j].text);
    dels[i].spans = diff.oldSpans;
    adds[j].spans = diff.newSpans;
  }
  for (const line of painted) {
    if (isCtxType(line.type)) line.spans = wholeSpans(line.text, false);
  }
  return painted;
};

const pushAligned = (rows, dels, adds, delToAdd) => {
  const paired = new Array(adds.length).fill(false);
  for (const j of delToAdd) if (j >= 0) paired[j] = true;
  let addPos = 0;
  const takeAdds = (limit) => {
    for (; addPos < limit; addPos++) {
      if (!paired[addPos]) rows.push({ left: null, right: adds[addPos] });
    }
  };
  for (let i = 0; i < dels.length; i++) {
    const j = delToAdd[i];
    if (j < 0) {
      rows.push({ left: dels[i], right: null });
      continue;
    }
    takeAdds(j);
    rows.push({ left: dels[i], right: adds[j] });
    if (addPos <= j) addPos = j + 1;
  }
  takeAdds(adds.length);
};

const sideRows = (lines) => {
  const rows = [];
  let i = 0;
  while (i < lines.length) {
    if (isCtxType(lines[i].type)) {
      rows.push({ left: lines[i], right: lines[i] });
      i += 1;
      continue;
    }
    const start = i;
    while (i < lines.length && !isCtxType(lines[i].type)) i += 1;
    const { dels, adds, delToAdd } = pairBlock(lines.slice(start, i));
    pushAligned(rows, dels, adds, delToAdd);
  }
  return rows;
};

const mixedLines = (lines) => {
  const out = [];
  for (const { left, right } of sideRows(lines)) {
    if (left) out.push(left);
    if (right && right !== left) out.push(right);
  }
  return out;
};

const LAYOUT_ALIGN = { mixed: mixedLines, side: sideRows };

module.exports = {
  isCtxType,
  pairIndices,
  attachInline,
  LAYOUT_ALIGN,
};
