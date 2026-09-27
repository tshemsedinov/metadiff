'use strict';

const inline = require('./inline.js');
const { diffChars } = inline;
const align = require('./align.js');
const { isCtxType, pairIndices, attachInline } = align;
const parse = require('./parse.js');
const { parseDiff } = parse;
const patch = require('./patch.js');
const { splitHunk, flattenBlock, countSides, formatPatch } = patch;
const display = require('./display.js');
const { DISPLAY_CONTEXT, displayLines, blockAddText } = display;
const edit = require('./edit.js');
const { addBlockRange, replaceBlockAdds } = edit;
const items = require('./items.js');
const { synthesizeNewFile, itemsFromFiles, refreshIndexPatches } = items;
const unit = require('./unit.js');
const { unitLines, itemsForPath, blockLineRange, blockLineIndex } = unit;
const { hunkLineRange, hunkKey, sameHunk, splitEditor } = unit;
const { fileOffset, fileLines, sameBlock, splitFile } = unit;
const { fileLineIndex, attachEditSpans, mergeEditRows } = unit;

module.exports = {
  DISPLAY_CONTEXT,
  isCtxType,
  diffChars,
  pairIndices,
  attachInline,
  parseDiff,
  splitHunk,
  flattenBlock,
  countSides,
  formatPatch,
  displayLines,
  blockAddText,
  addBlockRange,
  replaceBlockAdds,
  synthesizeNewFile,
  itemsFromFiles,
  refreshIndexPatches,
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
  fileLines,
  fileLineIndex,
  attachEditSpans,
  mergeEditRows,
};
