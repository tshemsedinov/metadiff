'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const diff = require('../lib/diff/diff.js');
const { unitLines, blockLineIndex, blockLineRange, fileOffset } = diff;
const { itemsForPath, mergeEditRows, splitFile } = diff;

const item = (blockId, lines, newStart = 1) => ({
  origin: 'unstaged',
  file: { newPath: 'a.js', oldPath: 'a.js' },
  blockId,
  hunk: {
    oldStart: 1,
    oldCount: lines.filter((line) => line.type !== 'add').length,
    newStart,
    newCount: lines.filter((line) => line.type !== 'del').length,
    header: '',
    lines,
  },
});

test('unitLines overlays del and add onto the file', () => {
  const hunk = item(0, [
    { type: 'ctx', text: 'keep', noNl: false, blockId: null },
    { type: 'del', text: 'old', noNl: false, blockId: 0 },
    { type: 'add', text: 'new', noNl: false, blockId: 0 },
    { type: 'ctx', text: 'tail', noNl: false, blockId: null },
  ]);
  const lines = unitLines('keep\nnew\ntail\n', [hunk]);
  const types = lines.map((line) => `${line.type}:${line.text}`);
  assert.deepEqual(types, ['ctx:keep', 'del:old', 'add:new', 'ctx:tail']);
  assert.equal(blockLineIndex(lines, hunk), 1);
  assert.deepEqual(blockLineRange(lines, hunk), { start: 1, end: 2 });
  assert.equal(fileOffset(lines, 2), 5);
});

test('itemsForPath keeps one file', () => {
  const a = item(0, [{ type: 'add', text: 'a', noNl: false, blockId: 0 }]);
  const b = {
    ...item(0, [{ type: 'add', text: 'b', noNl: false, blockId: 0 }]),
    file: { newPath: 'b.js', oldPath: 'b.js' },
  };
  assert.deepEqual(itemsForPath([a, b], 'a.js'), [a]);
});

test('unitLines without hunks is the file', () => {
  const lines = unitLines('one\ntwo\n', []);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].type, 'ctx');
  assert.equal(lines[1].text, 'two');
});

test('unitLines uses hunk adds when the file is empty', () => {
  const hunk = item(0, [{ type: 'add', text: 'new', noNl: false, blockId: 0 }]);
  const lines = unitLines('', [hunk]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, 'add');
  assert.equal(lines[0].text, 'new');
});

test('mergeEditRows keeps dels and turns inserts into ctx', () => {
  const hunk = item(0, [
    { type: 'del', text: 'old', noNl: false, blockId: 0 },
    { type: 'add', text: 'new', noNl: false, blockId: 0 },
  ]);
  const base = unitLines('new\ntail\n', [hunk]);
  const inserted = mergeEditRows(base, splitFile('new\nextra\ntail\n'));
  const types = inserted.map((line) => `${line.type}:${line.text}`);
  assert.deepEqual(types, ['del:old', 'add:new', 'ctx:extra', 'ctx:tail']);
  assert.equal(inserted[0].editStart, undefined);
  assert.equal(inserted[1].editStart, 0);
  const edited = mergeEditRows(base, splitFile('NEW\ntail\n'));
  assert.equal(edited[1].type, 'add');
  assert.equal(edited[1].text, 'NEW');
  assert.equal(edited[0].type, 'del');
});

test('mergeEditRows keeps a trailing empty editor line', () => {
  const hunk = item(0, [
    { type: 'del', text: 'old', noNl: false, blockId: 0 },
    { type: 'add', text: 'new', noNl: false, blockId: 0 },
  ]);
  const base = unitLines('new\n', [hunk]);
  const { splitEditor } = diff;
  const merged = mergeEditRows(base, splitEditor('new\n'));
  const types = merged.map((line) => `${line.type}:${line.text}`);
  assert.deepEqual(types, ['del:old', 'add:new', 'ctx:']);
  const last = merged[merged.length - 1];
  assert.equal(last.editLast, true);
  assert.equal(last.editStart, last.editEnd);
});
