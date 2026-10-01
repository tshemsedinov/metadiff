'use strict';

const patch = require('./patch.js');
const { splitHunk, formatHunkHeader, formatPatch } = patch;

const BINARY_ITEM = {
  hunk: null,
  blockId: null,
  patchAdd: '',
  patchRevert: '',
};

const indexSide = (origin) => (origin === 'staged' ? 'new' : 'old');

const synthesizeNewFile = (relPath, content) => {
  const noNl = content === '' || !content.endsWith('\n');
  const texts = noNl ? content.split('\n') : content.slice(0, -1).split('\n');
  const lines = texts.map((text, index) => ({
    type: 'add',
    text,
    noNl: noNl && index === texts.length - 1,
    blockId: 0,
  }));
  const newCount = lines.length;
  const header = formatHunkHeader(0, 0, 1, newCount);
  const hunk = {
    oldStart: 0,
    oldCount: 0,
    newStart: 1,
    newCount,
    header,
    lines,
  };
  const preamble = [
    `diff --git a/${relPath} b/${relPath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${relPath}`,
  ];
  return {
    oldPath: relPath,
    newPath: relPath,
    isNew: true,
    isDeleted: false,
    isBinary: false,
    preamble,
    hunks: [hunk],
  };
};

const itemsFromFiles = (files, origin) => {
  const items = [];
  const side = indexSide(origin);
  for (const file of files) {
    if (file.isBinary) {
      items.push({ origin, file, ...BINARY_ITEM });
      continue;
    }
    for (const rawHunk of file.hunks) {
      const { hunk, blocks } = splitHunk(rawHunk);
      for (const { id: blockId } of blocks) {
        const patchAdd = formatPatch(file, hunk, blockId, side);
        const patchRevert = formatPatch(file, hunk, blockId, 'new');
        items.push({ origin, file, hunk, blockId, patchAdd, patchRevert });
      }
    }
  }
  return items;
};

const refreshIndexPatches = (items, item) => {
  if (!item.hunk) return items;
  const isPeer = (other) =>
    other.hunk === item.hunk && other.file === item.file;
  const peers = items.filter(isPeer);
  const sides = {};
  for (const peer of peers) sides[peer.blockId] = indexSide(peer.origin);
  return items.map((other) => {
    if (!isPeer(other)) return other;
    const patchAdd = formatPatch(other.file, other.hunk, other.blockId, sides);
    return { ...other, patchAdd };
  });
};

module.exports = {
  synthesizeNewFile,
  itemsFromFiles,
  refreshIndexPatches,
};
