'use strict';

const align = require('./align.js');
const { attachInline } = align;
const files = require('../files.js');
const { listPath } = files;

const splitEditor = (text) => {
  const lines = `${text}`.split('\n');
  if (!lines.length) return [''];
  return lines;
};

const splitFile = (text) => {
  if (!text) return [];
  const lines = `${text}`.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
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
  if (left.hunk && right.hunk && left.hunk === right.hunk) {
    return listPath(left) === listPath(right);
  }
  const key = hunkKey(left);
  if (!key) return false;
  return key === hunkKey(right);
};

const emptyMarks = (last) => {
  const size = last + 1;
  const dels = new Array(size);
  const adds = new Array(size);
  for (let i = 0; i < size; i++) {
    dels[i] = [];
    adds[i] = null;
  }
  return { dels, adds };
};

const clipAt = (n, last) => Math.min(Math.max(1, n), last);

const applyHunk = (marks, item) => {
  const hunk = item.hunk;
  if (!hunk || !hunk.lines) return;
  const last = marks.dels.length - 1;
  let newLine = hunk.newStart > 0 ? hunk.newStart : 1;
  for (const line of hunk.lines) {
    const extra = {
      text: line.text ?? '',
      item,
      blockId: line.blockId,
      origin: item.origin,
    };
    if (line.type === 'del') {
      marks.dels[clipAt(newLine, last)].push(extra);
      continue;
    }
    if (line.type === 'add') {
      marks.adds[clipAt(newLine, last)] = extra;
      newLine += 1;
      continue;
    }
    newLine += 1;
  }
};

const tagged = (type, text, extra = {}) => ({
  type,
  text,
  noNl: false,
  blockId: extra.blockId ?? null,
  origin: extra.origin ?? '',
  item: extra.item ?? null,
});

const itemsForPath = (items, rel) => {
  const out = [];
  for (const item of items) {
    if (listPath(item) === rel) out.push(item);
  }
  return out;
};

const rowsFromAdds = (items) => {
  const rows = [];
  for (const item of items) {
    const lines = item.hunk && item.hunk.lines ? item.hunk.lines : [];
    for (const line of lines) {
      if (line.type === 'add') rows.push(line.text ?? '');
    }
  }
  return rows;
};

const unitLines = (text, items) => {
  let rows = splitFile(text);
  if (!rows.length) rows = rowsFromAdds(items);
  const marks = emptyMarks(rows.length + 1);
  for (const item of items) applyHunk(marks, item);
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const n = i + 1;
    for (const del of marks.dels[n]) out.push(tagged('del', del.text, del));
    const add = marks.adds[n];
    if (add) out.push(tagged('add', rows[i], add));
    else out.push(tagged('ctx', rows[i], {}));
  }
  for (const del of marks.dels[rows.length + 1]) {
    out.push(tagged('del', del.text, del));
  }
  if (!out.length) out.push(tagged('ctx', '', {}));
  return attachInline(out);
};

const sameBlock = (line, item) => {
  if (!line || !item) return false;
  if (line.item !== item) return false;
  return line.blockId === item.blockId;
};

const blockLineRange = (lines, item) => {
  let start = 0;
  let end = 0;
  let found = false;
  if (!item) return { start, end };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!sameBlock(line, item)) continue;
    if (line.type === 'ctx') continue;
    if (!found) {
      start = i;
      found = true;
    }
    end = i;
  }
  return { start, end };
};

const blockLineIndex = (lines, item) => blockLineRange(lines, item).start;

const hunkLineRange = (lines, item) => {
  let start = 0;
  let end = 0;
  let found = false;
  if (!item) return { start, end };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!sameHunk(line.item, item)) continue;
    if (line.type === 'ctx') continue;
    if (!found) {
      start = i;
      found = true;
    }
    end = i;
  }
  return { start, end };
};

const fileOffset = (lines, at) => {
  let offset = 0;
  const target = Math.max(0, at);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.type === 'del') continue;
    if (i >= target) return offset;
    offset += (line.text ?? '').length + 1;
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

const lastEditableIndex = (lines) => {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].type !== 'del') return i;
  }
  return -1;
};

const attachEditSpans = (lines) => {
  let offset = 0;
  const lastAt = lastEditableIndex(lines);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.type === 'del') continue;
    const text = line.text ?? '';
    const last = i === lastAt;
    line.wrap = true;
    line.editStart = offset;
    line.editEnd = offset + text.length;
    line.editLast = last;
    offset = last ? offset + text.length : offset + text.length + 1;
  }
  return lines;
};

const LCS_CELLS = 4000000;

const lcsTable = (prev, next) => {
  const n = prev.length;
  const m = next.length;
  const dp = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Array(m + 1).fill(0);
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
  const ops = new Array(Math.max(prev.length, next.length));
  let at = 0;
  for (let i = 0; i < n; i++) ops[at++] = { kind: 'rep', text: next[i] };
  for (let i = n; i < prev.length; i++) ops[at++] = { kind: 'del' };
  for (let i = n; i < next.length; i++) {
    ops[at++] = { kind: 'ins', text: next[i] };
  }
  return ops;
};

const walkLcs = (prev, next, dp) => {
  const ops = new Array(prev.length + next.length - dp[0][0]);
  let n = 0;
  let i = 0;
  let j = 0;
  while (i < prev.length && j < next.length) {
    if (prev[i] === next[j]) {
      ops[n++] = { kind: 'eq', text: next[j] };
      i += 1;
      j += 1;
      continue;
    }
    if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops[n++] = { kind: 'del' };
      i += 1;
      continue;
    }
    ops[n++] = { kind: 'ins', text: next[j] };
    j += 1;
  }
  while (i < prev.length) {
    ops[n++] = { kind: 'del' };
    i += 1;
  }
  while (j < next.length) {
    ops[n++] = { kind: 'ins', text: next[j] };
    j += 1;
  }
  return ops;
};

const collapseRep = (ops) => {
  const out = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const next = ops[i + 1];
    if (op.kind === 'del' && next && next.kind === 'ins') {
      out.push({ kind: 'rep', text: next.text });
      i += 1;
      continue;
    }
    if (op.kind === 'ins' && next && next.kind === 'del') {
      out.push({ kind: 'rep', text: op.text });
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
  return collapseRep(walkLcs(prev, next, lcsTable(prev, next)));
};

const copyRow = (row, text) => ({
  type: row.type,
  text,
  noNl: row.noNl === true,
  blockId: row.blockId ?? null,
  origin: row.origin ?? '',
  item: row.item ?? null,
});

const pushDels = (out, base, at) => {
  let i = at;
  while (i < base.length && base[i].type === 'del') {
    out.push(copyRow(base[i], base[i].text ?? ''));
    i += 1;
  }
  return i;
};

const mergeEditRows = (baseRows, nextTexts) => {
  const base = baseRows ?? [];
  const texts = nextTexts && nextTexts.length ? nextTexts : [''];
  const prev = [];
  for (const row of base) {
    if (row.type === 'del') continue;
    prev.push(row.text ?? '');
  }
  const ops = lineOps(prev, texts);
  const out = [];
  let at = 0;
  for (const op of ops) {
    at = pushDels(out, base, at);
    if (op.kind === 'ins') {
      out.push(tagged('ctx', op.text, {}));
      continue;
    }
    if (at >= base.length) continue;
    if (op.kind === 'del') {
      at += 1;
      continue;
    }
    out.push(copyRow(base[at], op.text));
    at += 1;
  }
  pushDels(out, base, at);
  if (!out.length) out.push(tagged('ctx', '', {}));
  return attachEditSpans(attachInline(out));
};

const fileLines = (text) => {
  const rows = splitFile(text);
  if (!rows.length) rows.push('');
  const { length } = rows;
  const out = new Array(length);
  let offset = 0;
  for (let i = 0; i < length; i++) {
    const row = rows[i];
    const start = offset;
    const end = start + row.length;
    const last = i === length - 1;
    out[i] = {
      type: 'ctx',
      text: row,
      noNl: false,
      wrap: true,
      editStart: start,
      editEnd: end,
      editLast: last,
      blockId: null,
      origin: '',
      item: null,
    };
    offset = last ? end : end + 1;
  }
  return out;
};

module.exports = {
  splitFile,
  splitEditor,
  itemsForPath,
  unitLines,
  sameBlock,
  sameHunk,
  hunkKey,
  blockLineRange,
  hunkLineRange,
  blockLineIndex,
  fileOffset,
  fileLineIndex,
  attachEditSpans,
  mergeEditRows,
  fileLines,
};
