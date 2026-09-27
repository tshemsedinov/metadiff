'use strict';

const align = require('./align.js');
const { isCtxType } = align;

const LINE_MARK = {
  add: '+',
  del: '-',
  ctx: ' ',
  warn: ' ',
  note: ' ',
  noteSep: ' ',
};

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

const otherContext = (contextSide, blockId) => {
  if (contextSide === 'new') return 'new';
  if (contextSide === 'old') return 'old';
  return contextSide[blockId] ?? 'old';
};

const flattenBlock = (hunk, blockId, contextSide) => {
  const out = [];
  for (const line of hunk.lines) {
    if (line.blockId === blockId || isCtxType(line.type)) {
      out.push(line);
      continue;
    }
    const side = otherContext(contextSide, line.blockId);
    if (side === 'old' && line.type === 'del') {
      out.push({ type: 'ctx', text: line.text, noNl: line.noNl });
      continue;
    }
    if (side === 'new' && line.type === 'add') {
      out.push({ type: 'ctx', text: line.text, noNl: line.noNl });
    }
  }
  return out;
};

const countSides = (lines) => {
  let oldCount = 0;
  let newCount = 0;
  for (const line of lines) {
    if (isCtxType(line.type) || line.type === 'del') oldCount += 1;
    if (isCtxType(line.type) || line.type === 'add') newCount += 1;
  }
  return { oldCount, newCount };
};

const formatHunkHeader = (oldStart, oldCount, newStart, newCount) =>
  `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;

const formatBodyLine = (line) => {
  const rows = [`${LINE_MARK[line.type] ?? ' '}${line.text}`];
  if (line.noNl) rows.push('\\ No newline at end of file');
  return rows;
};

const formatPatch = (file, hunk, blockId, contextSide) => {
  const lines = flattenBlock(hunk, blockId, contextSide);
  const counts = countSides(lines);
  const header = formatHunkHeader(
    hunk.oldStart,
    counts.oldCount,
    hunk.newStart,
    counts.newCount,
  );
  const parts = [...file.preamble, header];
  for (const line of lines) {
    for (const row of formatBodyLine(line)) parts.push(row);
  }
  return `${parts.join('\n')}\n`;
};

module.exports = {
  splitHunk,
  flattenBlock,
  countSides,
  formatHunkHeader,
  formatPatch,
};
