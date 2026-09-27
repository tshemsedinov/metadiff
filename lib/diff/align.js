'use strict';

const inline = require('./inline.js');
const { diffChars, tokenSimilarity } = inline;

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
  const headA = a[0];
  const headB = b[0];
  const head = headA && headA === headB ? 1 : 0;
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
  candidates.sort(comparePair);
  return candidates;
};

const pairIndices = (delTexts, addTexts) => {
  const delToAdd = new Array(delTexts.length).fill(-1);
  const addUsed = new Array(addTexts.length).fill(false);
  const candidates = pairCandidates(delTexts, addTexts);
  for (const pair of candidates) {
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

const changeSides = (block) => {
  const dels = [];
  const adds = [];
  for (const line of block) {
    if (line.type === 'del') dels.push(line);
    if (line.type === 'add') adds.push(line);
  }
  return { dels, adds };
};

const applyInlineSpans = (dels, adds, delToAdd) => {
  const addSeen = new Set();
  for (let i = 0; i < dels.length; i++) {
    const j = delToAdd[i];
    if (j < 0) {
      dels[i].spans = [{ text: dels[i].text, changed: true }];
      continue;
    }
    addSeen.add(j);
    const diff = diffChars(dels[i].text, adds[j].text);
    dels[i].spans = diff.oldSpans;
    adds[j].spans = diff.newSpans;
  }
  for (let j = 0; j < adds.length; j++) {
    if (addSeen.has(j)) continue;
    adds[j].spans = [{ text: adds[j].text, changed: true }];
  }
};

const attachInline = (lines) => {
  const painted = lines.map((line) => ({ ...line }));
  const { dels, adds } = changeSides(painted);
  const delToAdd = pairIndices(
    dels.map((line) => line.text),
    adds.map((line) => line.text),
  );
  applyInlineSpans(dels, adds, delToAdd);
  for (const line of painted) {
    if (isCtxType(line.type)) {
      line.spans = [{ text: line.text, changed: false }];
    }
  }
  return painted;
};

const addPartners = (delToAdd, addCount) => {
  const addToDel = new Array(addCount).fill(-1);
  for (let i = 0; i < delToAdd.length; i++) {
    const j = delToAdd[i];
    if (j >= 0) addToDel[j] = i;
  }
  return addToDel;
};

const walkAligned = (dels, adds, delToAdd, emit) => {
  const addToDel = addPartners(delToAdd, adds.length);
  const usedAdd = new Array(adds.length).fill(false);
  let addPos = 0;
  const takeUnpairedAdds = (limit) => {
    while (addPos < limit) {
      const free = addToDel[addPos] < 0 && !usedAdd[addPos];
      if (free) {
        emit.unpairedAdd(adds[addPos]);
        usedAdd[addPos] = true;
      }
      addPos += 1;
    }
  };
  for (let i = 0; i < dels.length; i++) {
    const j = delToAdd[i];
    if (j < 0) {
      emit.unpairedDel(dels[i]);
      continue;
    }
    takeUnpairedAdds(j);
    emit.pair(dels[i], adds[j]);
    usedAdd[j] = true;
    if (addPos <= j) addPos = j + 1;
  }
  takeUnpairedAdds(adds.length);
  for (let j = 0; j < adds.length; j++) {
    if (!usedAdd[j]) emit.unpairedAdd(adds[j]);
  }
};

const alignChangeBlock = (dels, adds, delToAdd) => {
  const out = [];
  walkAligned(dels, adds, delToAdd, {
    unpairedDel: (del) => {
      out.push(del);
    },
    unpairedAdd: (add) => {
      out.push(add);
    },
    pair: (del, add) => {
      out.push(del);
      out.push(add);
    },
  });
  return out;
};

const mapHunkBlocks = (lines, onCtx, onChange) => {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (isCtxType(lines[i].type)) {
      out.push(onCtx(lines[i]));
      i += 1;
      continue;
    }
    const start = i;
    while (i < lines.length && !isCtxType(lines[i].type)) i += 1;
    const block = lines.slice(start, i);
    const { dels, adds } = changeSides(block);
    const delToAdd = pairIndices(
      dels.map((line) => line.text),
      adds.map((line) => line.text),
    );
    for (const row of onChange(dels, adds, delToAdd)) out.push(row);
  }
  return out;
};

const alignSplitBlock = (dels, adds, delToAdd) => {
  const out = [];
  walkAligned(dels, adds, delToAdd, {
    unpairedDel: (del) => {
      out.push({ left: del, right: null });
    },
    unpairedAdd: (add) => {
      out.push({ left: null, right: add });
    },
    pair: (del, add) => {
      out.push({ left: del, right: add });
    },
  });
  return out;
};

const LAYOUT_ALIGN = {
  mixed: (lines) => mapHunkBlocks(lines, (line) => line, alignChangeBlock),
  side: (lines) =>
    mapHunkBlocks(
      lines,
      (line) => ({ left: line, right: line }),
      alignSplitBlock,
    ),
};

module.exports = {
  isCtxType,
  pairIndices,
  attachInline,
  LAYOUT_ALIGN,
};
