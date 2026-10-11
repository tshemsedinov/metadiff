'use strict';

const { clamp } = require('../common/utilities.js');
const { isCtxType } = require('./align.js');

const LINE_MARK = { add: '+', del: '-' };

const splitHunk = (hunk) => {
  const { oldStart, oldCount, newStart, newCount, header } = hunk;
  const blocks = [];
  let current = null;
  let blockId = -1;
  const lines = hunk.lines.map((line) => {
    if (isCtxType(line.type)) {
      current = null;
      return { ...line, blockId: null };
    }
    if (!current) {
      blockId += 1;
      current = { id: blockId };
      blocks.push(current);
    }
    return { ...line, blockId };
  });
  const nextHunk = { oldStart, oldCount, newStart, newCount, header, lines };
  return { hunk: nextHunk, blocks };
};

const sideOf = (contextSide, blockId) => {
  if (typeof contextSide === 'string') return contextSide;
  return contextSide[blockId] ?? 'old';
};

const flattenBlock = (hunk, blockId, contextSide) => {
  const out = [];
  for (const line of hunk.lines) {
    if (line.blockId === blockId || isCtxType(line.type)) {
      out.push(line);
      continue;
    }
    const kept = sideOf(contextSide, line.blockId) === 'old' ? 'del' : 'add';
    if (line.type === kept) {
      out.push({
        type: 'ctx',
        text: line.text,
        noNl: line.noNl,
        synthetic: true,
      });
    }
  }
  return out;
};

const countSides = (lines) => {
  let oldCount = 0;
  let newCount = 0;
  for (const line of lines) {
    if (line.type !== 'add') oldCount += 1;
    if (line.type !== 'del') newCount += 1;
  }
  return { oldCount, newCount };
};

const formatHunkHeader = (oldStart, oldCount, newStart, newCount) =>
  `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;

const formatPatch = (file, hunk, blockId, contextSide) => {
  const lines = flattenBlock(hunk, blockId, contextSide);
  const { oldCount, newCount } = countSides(lines);
  const { oldStart, newStart } = hunk;
  const header = formatHunkHeader(oldStart, oldCount, newStart, newCount);
  const parts = [...file.preamble, header];
  for (const line of lines) {
    parts.push(`${LINE_MARK[line.type] ?? ' '}${line.text}`);
    if (line.noNl) parts.push('\\ No newline at end of file');
  }
  return `${parts.join('\n')}\n`;
};

const addBlockRange = (hunk, blockId) => {
  let newLine = hunk.newStart;
  let start = 0;
  let count = 0;
  for (const line of hunk.lines) {
    if (line.type === 'del') {
      if (line.blockId === blockId && start === 0) start = newLine;
      continue;
    }
    if (line.type === 'add' && line.blockId === blockId) {
      if (count === 0) start = newLine;
      count += 1;
    }
    newLine += 1;
  }
  if (start === 0) start = hunk.newStart;
  return { start, count };
};

const replaceBlockAdds = (content, hunk, blockId, text) => {
  const range = addBlockRange(hunk, blockId);
  const ended = content.endsWith('\n');
  const body = ended ? content.slice(0, -1) : content;
  const lines = content === '' ? [] : body.split('\n');
  const from = clamp(range.start - 1, 0, lines.length);
  const added = text === '' ? [] : text.split('\n');
  lines.splice(from, range.count, ...added);
  return lines.join('\n') + (ended ? '\n' : '');
};

module.exports = {
  splitHunk,
  flattenBlock,
  countSides,
  formatHunkHeader,
  formatPatch,
  addBlockRange,
  replaceBlockAdds,
};
