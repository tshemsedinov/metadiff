'use strict';

const { attachInline } = require('./align.js');
const { listPath } = require('../common/files.js');

const LCS_CELLS = 4000000;

const splitEditor = (text) => text.split('\n');

const splitFile = (text) => {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};

const hunkKey = (item) => {
  if (!item) return '';
  const rel = listPath(item);
  const hunk = item.hunk;
  if (!hunk) return `${rel}\0${item.blockId ?? ''}`;
  return `${rel}\0${hunk.oldStart}\0${hunk.newStart}\0${hunk.header}`;
};

const sameHunk = (left, right) => {
  if (!left || !right) return false;
  if (left.hunk && left.hunk === right.hunk) {
    return listPath(left) === listPath(right);
  }
  return hunkKey(left) === hunkKey(right);
};

const tagged = (type, text, extra) => ({
  type,
  text,
  noNl: false,
  blockId: extra.blockId ?? null,
  origin: extra.origin ?? '',
  item: extra.item ?? null,
});

const NO_EXTRA = {};

const clipAt = (n, last) => Math.min(Math.max(1, n), last);

const markHunk = (marks, item) => {
  if (!item.hunk) return;
  const last = marks.dels.length - 1;
  let newLine = item.hunk.newStart > 0 ? item.hunk.newStart : 1;
  for (const line of item.hunk.lines) {
    const { type, text, blockId } = line;
    const mark = { text, item, blockId, origin: item.origin };
    if (type === 'del') {
      marks.dels[clipAt(newLine, last)].push(mark);
      continue;
    }
    if (type === 'add') marks.adds[clipAt(newLine, last)] = mark;
    newLine += 1;
  }
};

const itemsForPath = (items, rel) =>
  items.filter((item) => listPath(item) === rel);

const rowsFromAdds = (items) => {
  const rows = [];
  for (const item of items) {
    if (!item.hunk) continue;
    for (const line of item.hunk.lines) {
      if (line.type === 'add') rows.push(line.text);
    }
  }
  return rows;
};

const stampFileNumbers = (lines) => {
  let newNo = 1;
  for (const line of lines) {
    if (line.type === 'del') continue;
    line.newNo = newNo;
    newNo += 1;
  }
  return lines;
};

const unitLines = (text, items) => {
  let rows = splitFile(text);
  if (!rows.length) rows = rowsFromAdds(items);
  const size = rows.length + 2;
  const marks = {
    dels: Array.from({ length: size }, () => []),
    adds: new Array(size).fill(null),
  };
  for (const item of items) markHunk(marks, item);
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    for (const del of marks.dels[i + 1]) out.push(tagged('del', del.text, del));
    const add = marks.adds[i + 1];
    if (add) out.push(tagged('add', rows[i], add));
    else out.push(tagged('ctx', rows[i], NO_EXTRA));
  }
  for (const del of marks.dels[rows.length + 1]) {
    out.push(tagged('del', del.text, del));
  }
  if (!out.length) out.push(tagged('ctx', '', NO_EXTRA));
  return stampFileNumbers(attachInline(out));
};

const sameBlock = (line, item) =>
  line.item === item && line.blockId === item.blockId;

const changedLineRange = (lines, item, belongs) => {
  let start = -1;
  let end = 0;
  if (!item) return { start: 0, end };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.type === 'ctx' || !belongs(line, item)) continue;
    if (start < 0) start = i;
    end = i;
  }
  return { start: Math.max(start, 0), end };
};

const blockLineRange = (lines, item) =>
  changedLineRange(lines, item, sameBlock);

const blockLineIndex = (lines, item) => blockLineRange(lines, item).start;

const hunkLineRange = (lines, item) =>
  changedLineRange(lines, item, (line) => sameHunk(line.item, item));

const fileOffset = (lines, at) => {
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.type === 'del') continue;
    if (i >= at) return offset;
    offset += line.text.length + 1;
  }
  return offset;
};

const fileLineIndex = (lines, fileLine) => {
  let n = 0;
  let last = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].type === 'del') continue;
    last = i;
    if (n === fileLine) return i;
    n += 1;
  }
  return last;
};

const attachEditSpans = (lines) => {
  let lastAt = lines.length - 1;
  while (lastAt >= 0 && lines[lastAt].type === 'del') lastAt -= 1;
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.type === 'del') continue;
    line.wrap = true;
    line.editStart = offset;
    line.editEnd = offset + line.text.length;
    line.editLast = i === lastAt;
    offset = line.editEnd + 1;
  }
  return lines;
};

const lcsTable = (prev, next) => {
  const n = prev.length;
  const m = next.length;
  const dp = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (prev[i] === next[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
};

const zipOps = (prev, next) => {
  const n = Math.min(prev.length, next.length);
  const ops = [];
  for (let i = 0; i < n; i++) ops.push({ kind: 'rep', text: next[i] });
  for (let i = n; i < prev.length; i++) ops.push({ kind: 'del' });
  for (let i = n; i < next.length; i++) {
    ops.push({ kind: 'ins', text: next[i] });
  }
  return ops;
};

const lcsOps = (prev, next) => {
  const ops = [];
  const limit = Math.min(prev.length, next.length);
  let head = 0;
  while (head < limit && prev[head] === next[head]) {
    ops.push({ kind: 'eq', text: next[head] });
    head += 1;
  }
  const left = head ? prev.slice(head) : prev;
  const right = head ? next.slice(head) : next;
  const dp = lcsTable(left, right);
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      ops.push({ kind: 'eq', text: right[j] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: 'del' });
      i += 1;
    } else {
      ops.push({ kind: 'ins', text: right[j] });
      j += 1;
    }
  }
  for (; i < left.length; i++) ops.push({ kind: 'del' });
  for (; j < right.length; j++) ops.push({ kind: 'ins', text: right[j] });
  return ops;
};

const collapseRep = (ops) => {
  const out = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const next = ops[i + 1];
    const delIns = op.kind === 'del' && next?.kind === 'ins';
    const insDel = op.kind === 'ins' && next?.kind === 'del';
    if (delIns || insDel) {
      out.push({ kind: 'rep', text: delIns ? next.text : op.text });
      i += 1;
      continue;
    }
    out.push(op);
  }
  return out;
};

const lineOps = (prev, next) => {
  if (prev.length === next.length) return zipOps(prev, next);
  if (prev.length * next.length > LCS_CELLS) return zipOps(prev, next);
  return collapseRep(lcsOps(prev, next));
};

const pushDels = (out, base, at) => {
  let i = at;
  while (i < base.length && base[i].type === 'del') {
    out.push(tagged('del', base[i].text, base[i]));
    i += 1;
  }
  return i;
};

const mergeRows = (base, nextTexts) => {
  const texts = nextTexts.length ? nextTexts : [''];
  const prev = [];
  for (const row of base) if (row.type !== 'del') prev.push(row.text);
  const out = [];
  let at = 0;
  for (const op of lineOps(prev, texts)) {
    at = pushDels(out, base, at);
    if (op.kind === 'ins') {
      out.push(tagged('ctx', op.text, NO_EXTRA));
      continue;
    }
    if (at >= base.length) continue;
    if (op.kind !== 'del') out.push(tagged(base[at].type, op.text, base[at]));
    at += 1;
  }
  pushDels(out, base, at);
  if (!out.length) out.push(tagged('ctx', '', NO_EXTRA));
  return stampFileNumbers(attachEditSpans(attachInline(out)));
};

let merged = { base: null, text: '', rows: [] };

const mergeEditRows = (base, nextTexts) => {
  const text = nextTexts.join('\n');
  if (merged.base === base && merged.text === text) return merged.rows;
  const rows = mergeRows(base, nextTexts);
  merged = { base, text, rows };
  return rows;
};

module.exports = {
  splitFile,
  splitEditor,
  itemsForPath,
  unitLines,
  sameHunk,
  hunkKey,
  blockLineRange,
  hunkLineRange,
  blockLineIndex,
  fileOffset,
  fileLineIndex,
  mergeEditRows,
};
