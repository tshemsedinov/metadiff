'use strict';

const { sampleHunk } = require('./helpers.js');

const { test } = require('node:test');
const assert = require('node:assert/strict');

const diff = require('../lib/diff/diff.js');
const { parseDiff, splitHunk, formatPatch, flattenBlock } = diff;
const { displayLines, itemsFromFiles, DISPLAY_CONTEXT } = diff;
const { replaceBlockAdds, addBlockRange } = diff;

const SAMPLE = `diff --git a/n.js b/n.js
index 1111111..2222222 100644
--- a/n.js
+++ b/n.js
@@ -1,7 +1,7 @@
 keep
-AAA
+aaa
 keep
-BBB
+bbb
 keep
`;

test('parseDiff reads hunks and paths', () => {
  const files = parseDiff(SAMPLE);
  assert.equal(files.length, 1);
  assert.equal(files[0].oldPath, 'n.js');
  assert.equal(files[0].newPath, 'n.js');
  assert.equal(files[0].hunks.length, 1);
  assert.equal(files[0].hunks[0].lines.length, 7);
});

test('splitHunk makes two blocks around context', () => {
  const hunk = parseDiff(SAMPLE)[0].hunks[0];
  const split = splitHunk(hunk);
  assert.equal(split.blocks.length, 2);
  const ids = split.hunk.lines.map((line) => line.blockId);
  assert.deepEqual(ids, [null, 0, 0, null, 1, 1, null]);
});

test('formatPatch keeps only the focused block as a change', () => {
  const file = parseDiff(SAMPLE)[0];
  const split = splitHunk(file.hunks[0]);
  const patch = formatPatch(file, split.hunk, 0, 'old');
  assert.match(patch, /^-AAA/m);
  assert.match(patch, /^\+aaa/m);
  assert.match(patch, /^ BBB/m);
  assert.doesNotMatch(patch, /^-BBB/m);
  assert.doesNotMatch(patch, /^\+bbb/m);
});

test('flattenBlock new-side context keeps added other blocks', () => {
  const file = parseDiff(SAMPLE)[0];
  const split = splitHunk(file.hunks[0]);
  const lines = flattenBlock(split.hunk, 0, 'new');
  const types = lines.map((line) => `${line.type}:${line.text}`);
  assert.ok(types.includes('ctx:bbb'));
  assert.ok(!types.includes('del:BBB'));
});

test('displayLines keeps a short window of surrounding lines', () => {
  const before = ['b1', 'b2', 'b3', 'b4', 'b5'];
  const after = ['a1', 'a2', 'a3', 'a4', 'a5'];
  const ctx = (text) => ({ type: 'ctx', text, noNl: false, blockId: null });
  const hunk = {
    oldStart: 1,
    oldCount: 11,
    newStart: 1,
    newCount: 11,
    header: '@@ -1,11 +1,11 @@',
    lines: [
      ...before.map(ctx),
      { type: 'del', text: 'OLD', noNl: false, blockId: 0 },
      { type: 'add', text: 'NEW', noNl: false, blockId: 0 },
      ...after.map(ctx),
    ],
  };
  const lines = displayLines(hunk, 0);
  const types = lines.map((line) => `${line.type}:${line.text}`);
  const head = before.slice(-DISPLAY_CONTEXT).map((text) => `ctx:${text}`);
  const tail = after.slice(0, DISPLAY_CONTEXT).map((text) => `ctx:${text}`);
  assert.deepEqual(types, [...head, 'del:OLD', 'add:NEW', ...tail]);
});

test('displayLines shows latest sibling lines as context', () => {
  const file = parseDiff(SAMPLE)[0];
  const split = splitHunk(file.hunks[0]);
  const lines = displayLines(split.hunk, 1);
  const types = lines.map((line) => `${line.type}:${line.text}`);
  assert.deepEqual(types, [
    'ctx:keep',
    'ctx:aaa',
    'ctx:keep',
    'del:BBB',
    'add:bbb',
    'ctx:keep',
  ]);
  const side = displayLines(split.hunk, 1, 'side');
  const firstChange = side[3];
  assert.equal(side[1].left.type, 'ctx');
  assert.equal(side[1].left.text, 'aaa');
  assert.equal(side[1].right.text, 'aaa');
  assert.equal(firstChange.left.type, 'del');
  assert.equal(firstChange.left.text, 'BBB');
  assert.equal(firstChange.right.type, 'add');
  assert.equal(firstChange.right.text, 'bbb');
});

test('formatPatch mixed sides uses staged new context', () => {
  const file = parseDiff(SAMPLE)[0];
  const split = splitHunk(file.hunks[0]);
  const sides = { 0: 'new', 1: 'old' };
  const patch = formatPatch(file, split.hunk, 1, sides);
  assert.match(patch, /^-BBB/m);
  assert.match(patch, /^\+bbb/m);
  assert.match(patch, /^ aaa/m);
  assert.doesNotMatch(patch, /^-AAA/m);
});

test('itemsFromFiles staged index patch uses new-side context', () => {
  const files = parseDiff(SAMPLE);
  const staged = itemsFromFiles(files, 'staged');
  const unstaged = itemsFromFiles(files, 'unstaged');
  assert.match(staged[0].patchAdd, /^ bbb/m);
  assert.doesNotMatch(staged[0].patchAdd, /^-BBB/m);
  assert.match(unstaged[0].patchAdd, /^ BBB/m);
  assert.doesNotMatch(unstaged[0].patchAdd, /^\+bbb/m);
});

test('displayLines overlay replaces added lines', () => {
  const hunk = sampleHunk([
    { type: 'del', text: 'OLD', noNl: false, blockId: 0 },
    { type: 'add', text: 'NEW', noNl: false, blockId: 0 },
  ]);
  const lines = displayLines(hunk, 0, 'unified', undefined, {
    text: 'NEXT\nMORE',
  });
  const types = lines.map((line) => `${line.type}:${line.text}`);
  assert.deepEqual(types, ['del:OLD', 'add:NEXT', 'add:MORE']);
  const empty = displayLines(hunk, 0, 'unified', undefined, { text: '' });
  const emptyTypes = empty.map((line) => `${line.type}:${line.text}`);
  assert.deepEqual(emptyTypes, ['del:OLD']);
});

test('replaceBlockAdds rewrites added lines in file text', () => {
  const hunk = {
    oldStart: 1,
    oldCount: 3,
    newStart: 1,
    newCount: 3,
    header: '@@ -1,3 +1,3 @@',
    lines: [
      { type: 'ctx', text: 'alpha', noNl: false, blockId: null },
      { type: 'del', text: 'beta', noNl: false, blockId: 0 },
      { type: 'add', text: 'BETA', noNl: false, blockId: 0 },
      { type: 'ctx', text: 'gamma', noNl: false, blockId: null },
    ],
  };
  const range = addBlockRange(hunk, 0);
  assert.deepEqual(range, { start: 2, count: 1 });
  const next = replaceBlockAdds('alpha\nBETA\ngamma\n', hunk, 0, 'BETA-edited');
  assert.equal(next, 'alpha\nBETA-edited\ngamma\n');
  const extra = replaceBlockAdds('alpha\nBETA\ngamma\n', hunk, 0, 'one\ntwo');
  assert.equal(extra, 'alpha\none\ntwo\ngamma\n');
});
