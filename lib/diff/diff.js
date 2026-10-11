'use strict';

const inline = require('./inline.js');
const align = require('./align.js');
const parse = require('./parse.js');
const patch = require('./patch.js');
const display = require('./display.js');
const items = require('./items.js');
const unit = require('./unit.js');

module.exports = {
  diffChars: inline.diffChars,
  isCtxType: align.isCtxType,
  pairIndices: align.pairIndices,
  attachInline: align.attachInline,
  parseDiff: parse.parseDiff,
  splitHunk: patch.splitHunk,
  flattenBlock: patch.flattenBlock,
  formatPatch: patch.formatPatch,
  ...display,
  addBlockRange: patch.addBlockRange,
  replaceBlockAdds: patch.replaceBlockAdds,
  ...items,
  ...unit,
};
