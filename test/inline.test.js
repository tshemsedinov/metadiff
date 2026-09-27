'use strict';

const nodeTest = require('node:test');
const { test } = nodeTest;
const assert = require('node:assert/strict');

const diff = require('../lib/diff/diff.js');
const { diffChars, pairIndices, attachInline } = diff;
const { displayLines, formatPatch, splitHunk } = diff;

const changedText = (spans) =>
  spans
    .filter((span) => span.changed)
    .map((span) => span.text)
    .join('');

const unchangedText = (spans) =>
  spans
    .filter((span) => !span.changed)
    .map((span) => span.text)
    .join('');

test('AC1 only w/W graphemes are marked changed', () => {
  const diff = diffChars('hello world', 'hello World');
  assert.equal(changedText(diff.oldSpans), 'w');
  assert.equal(changedText(diff.newSpans), 'W');
  assert.equal(unchangedText(diff.oldSpans), 'hello orld');
  assert.equal(unchangedText(diff.newSpans), 'hello orld');
});

test('AC3 one-character edit is not the whole line', () => {
  const left = `${'x'.repeat(80)}a${'y'.repeat(80)}`;
  const right = `${'x'.repeat(80)}b${'y'.repeat(80)}`;
  const diff = diffChars(left, right);
  assert.equal(changedText(diff.oldSpans), 'a');
  assert.equal(changedText(diff.newSpans), 'b');
  const oldAll = diff.oldSpans.map((span) => span.text).join('');
  assert.equal(oldAll, left);
  assert.notEqual(changedText(diff.oldSpans), left);
});

test('identical strings have no changed spans', () => {
  const diff = diffChars('same', 'same');
  assert.equal(changedText(diff.oldSpans), '');
  assert.equal(changedText(diff.newSpans), '');
});

test('AC19 identifier replace marks whole words', () => {
  const diff = diffChars('let par = 1;', 'let placeholder = 1;');
  assert.equal(changedText(diff.oldSpans), 'par');
  assert.equal(changedText(diff.newSpans), 'placeholder');
  assert.equal(unchangedText(diff.oldSpans), 'let  = 1;');
  assert.equal(unchangedText(diff.newSpans), 'let  = 1;');
  const oldWords = diff.oldSpans.filter((span) => span.changed);
  const newWords = diff.newSpans.filter((span) => span.changed);
  assert.deepEqual(
    oldWords.map((span) => span.text),
    ['par'],
  );
  assert.deepEqual(
    newWords.map((span) => span.text),
    ['placeholder'],
  );
});

test('camelCase identifier replace marks whole words', () => {
  const diff = diffChars('sampleItem', 'tallItem');
  const oldWords = diff.oldSpans.filter((span) => span.changed);
  const newWords = diff.newSpans.filter((span) => span.changed);
  assert.deepEqual(
    oldWords.map((span) => span.text),
    ['sample'],
  );
  assert.deepEqual(
    newWords.map((span) => span.text),
    ['tall'],
  );
  assert.equal(unchangedText(diff.oldSpans), 'Item');
  assert.equal(unchangedText(diff.newSpans), 'Item');
});

test('sampleItem to tallItem keeps Item and marks whole words', () => {
  const oldText = `const { session } = openSession([sampleItem('a.js')]);`;
  const newText = `const { session } = openSession([tallItem('a.js', 80)]);`;
  const diff = diffChars(oldText, newText);
  const oldWords = diff.oldSpans.filter((span) => span.changed);
  const newWords = diff.newSpans.filter((span) => span.changed);
  assert.deepEqual(
    oldWords.map((span) => span.text),
    ['sample'],
  );
  assert.deepEqual(
    newWords.map((span) => span.text),
    ['tall', ', 80'],
  );
  assert.ok(unchangedText(diff.oldSpans).includes('Item'));
  assert.ok(unchangedText(diff.newSpans).includes('Item'));
});

test('snake_case segment replace marks the whole segment', () => {
  const oldText = 'const destDir = process.env.METADIFF_BIN_DIR';
  const newText = 'const destDir = process.env.RESLOP_BIN_DIR';
  const diff = diffChars(oldText, newText);
  assert.equal(changedText(diff.oldSpans), 'METADIFF');
  assert.equal(changedText(diff.newSpans), 'RESLOP');
  assert.equal(
    unchangedText(diff.oldSpans),
    'const destDir = process.env._BIN_DIR',
  );
  assert.equal(
    unchangedText(diff.newSpans),
    'const destDir = process.env._BIN_DIR',
  );
});

const KEYS_FOR = [
  '  const keys = Object.keys(delta);',
  '  for (const key of keys) {',
  '    const value = delta[key];',
];
const ENTRIES_FOR = '  for (const [key, value] of Object.entries(delta)) {';

test('pairIndices matches for-loops, not Object.keys to for', () => {
  const paired = pairIndices(KEYS_FOR, [ENTRIES_FOR]);
  assert.deepEqual(paired, [-1, 0, -1]);
});

test('pairIndices pairs reordered const and for by head token', () => {
  const adds = [ENTRIES_FOR, '  const unused = 1;'];
  const paired = pairIndices(KEYS_FOR.slice(0, 2), adds);
  assert.deepEqual(paired, [1, 0]);
});

test('equal-count rewrites still pair in order', () => {
  assert.deepEqual(pairIndices(['apple'], ['orange']), [0]);
  assert.deepEqual(pairIndices(['aaa', 'bbb'], ['xxx', 'yyy']), [0, 1]);
});

test('attachInline diffs the paired for-loop, not Object.keys', () => {
  const lines = attachInline([
    { type: 'del', text: KEYS_FOR[0] },
    { type: 'del', text: KEYS_FOR[1] },
    { type: 'del', text: KEYS_FOR[2] },
    { type: 'add', text: ENTRIES_FOR },
  ]);
  const whollyChanged = (spans) =>
    spans.length === 1 && spans[0].changed === true;
  assert.equal(whollyChanged(lines[0].spans), true);
  assert.equal(whollyChanged(lines[2].spans), true);
  assert.equal(whollyChanged(lines[1].spans), false);
  assert.equal(whollyChanged(lines[3].spans), false);
  assert.ok(unchangedText(lines[1].spans).includes('for (const '));
  assert.ok(unchangedText(lines[3].spans).includes('for (const '));
});

const WHERE_KEYS = '    const keys = Object.keys(where);';
const WHERE_FOR = '    for (const key of keys) {';
const WHERE_BODY = '      const [operator, value] = whereValue(where[key]);';
const ENTRIES_WHERE = '    for (const [key, raw] of Object.entries(where)) {';
const ENTRIES_BODY = '      const [operator, value] = whereValue(raw);';

const whereHunk = () => ({
  oldStart: 1,
  oldCount: 5,
  newStart: 1,
  newCount: 4,
  header: '@@ -1,5 +1,4 @@',
  lines: [
    { type: 'ctx', text: '  applyWhere() {', noNl: false, blockId: null },
    { type: 'del', text: WHERE_KEYS, noNl: false, blockId: 0 },
    { type: 'del', text: WHERE_FOR, noNl: false, blockId: 0 },
    { type: 'del', text: WHERE_BODY, noNl: false, blockId: 0 },
    { type: 'add', text: ENTRIES_WHERE, noNl: false, blockId: 0 },
    { type: 'add', text: ENTRIES_BODY, noNl: false, blockId: 0 },
    { type: 'ctx', text: '  }', noNl: false, blockId: null },
  ],
});

const rowKey = (line) => `${line.type}:${line.text}`;

const sideKey = (row) => {
  const left = row.left ? `${row.left.type}:${row.left.text}` : '';
  const right = row.right ? `${row.right.type}:${row.right.text}` : '';
  return `${left}|${right}`;
};

const whollyChanged = (spans) =>
  spans.length === 1 && spans[0].changed === true;

test('AC16 unified layout keeps minus-then-plus order', () => {
  const lines = displayLines(whereHunk(), 0);
  assert.deepEqual(lines.map(rowKey), [
    'ctx:  applyWhere() {',
    `del:${WHERE_KEYS}`,
    `del:${WHERE_FOR}`,
    `del:${WHERE_BODY}`,
    `add:${ENTRIES_WHERE}`,
    `add:${ENTRIES_BODY}`,
    'ctx:  }',
  ]);
  assert.equal(whollyChanged(lines[1].spans), true);
  assert.equal(whollyChanged(lines[2].spans), false);
  assert.equal(whollyChanged(lines[3].spans), false);
  assert.equal(whollyChanged(lines[4].spans), false);
  assert.equal(whollyChanged(lines[5].spans), false);
  assert.ok(unchangedText(lines[2].spans).includes('for (const '));
  assert.ok(unchangedText(lines[4].spans).includes('for (const '));
  assert.ok(unchangedText(lines[3].spans).includes('whereValue('));
  assert.ok(unchangedText(lines[5].spans).includes('whereValue('));
});

test('AC17 mixed layout puts for-to-for adjacent', () => {
  const lines = displayLines(whereHunk(), 0, 'mixed');
  assert.deepEqual(lines.map(rowKey), [
    'ctx:  applyWhere() {',
    `del:${WHERE_KEYS}`,
    `del:${WHERE_FOR}`,
    `add:${ENTRIES_WHERE}`,
    `del:${WHERE_BODY}`,
    `add:${ENTRIES_BODY}`,
    'ctx:  }',
  ]);
  assert.equal(whollyChanged(lines[1].spans), true);
  assert.equal(whollyChanged(lines[2].spans), false);
  assert.equal(whollyChanged(lines[3].spans), false);
  assert.ok(unchangedText(lines[2].spans).includes('for (const '));
  assert.ok(unchangedText(lines[3].spans).includes('for (const '));
});

test('AC27 side layout puts pairs on one row', () => {
  const rows = displayLines(whereHunk(), 0, 'side');
  assert.deepEqual(rows.map(sideKey), [
    'ctx:  applyWhere() {|ctx:  applyWhere() {',
    `del:${WHERE_KEYS}|`,
    `del:${WHERE_FOR}|add:${ENTRIES_WHERE}`,
    `del:${WHERE_BODY}|add:${ENTRIES_BODY}`,
    'ctx:  }|ctx:  }',
  ]);
  assert.equal(whollyChanged(rows[1].left.spans), true);
  assert.equal(rows[1].right, null);
  assert.equal(whollyChanged(rows[2].left.spans), false);
  assert.equal(whollyChanged(rows[2].right.spans), false);
});

test('display align leaves git patch order unchanged', () => {
  const hunk = whereHunk();
  const file = {
    oldPath: 'q.js',
    newPath: 'q.js',
    isNew: false,
    isDeleted: false,
    isBinary: false,
    preamble: ['diff --git a/q.js b/q.js', '--- a/q.js', '+++ b/q.js'],
    hunks: [hunk],
  };
  const split = splitHunk(hunk);
  const patch = formatPatch(file, split.hunk, 0, 'old');
  const idxKeys = patch.indexOf(`-${WHERE_KEYS}`);
  const idxFor = patch.indexOf(`-${WHERE_FOR}`);
  const idxBody = patch.indexOf(`-${WHERE_BODY}`);
  const idxEntries = patch.indexOf(`+${ENTRIES_WHERE}`);
  const idxNewBody = patch.indexOf(`+${ENTRIES_BODY}`);
  assert.ok(idxKeys < idxFor);
  assert.ok(idxFor < idxBody);
  assert.ok(idxBody < idxEntries);
  assert.ok(idxEntries < idxNewBody);
});

test('unpaired insert sits just before the next pair in mixed', () => {
  const hunk = {
    oldStart: 1,
    oldCount: 4,
    newStart: 1,
    newCount: 5,
    header: '@@ -1,4 +1,5 @@',
    lines: [
      { type: 'ctx', text: 'start', noNl: false, blockId: null },
      { type: 'del', text: 'const a = 1;', noNl: false, blockId: 0 },
      { type: 'del', text: 'const c = 3;', noNl: false, blockId: 0 },
      { type: 'add', text: 'const a = 10;', noNl: false, blockId: 0 },
      { type: 'add', text: 'const b = 2;', noNl: false, blockId: 0 },
      { type: 'add', text: 'const c = 30;', noNl: false, blockId: 0 },
      { type: 'ctx', text: 'end', noNl: false, blockId: null },
    ],
  };
  const lines = displayLines(hunk, 0, 'mixed');
  assert.deepEqual(lines.map(rowKey), [
    'ctx:start',
    'del:const a = 1;',
    'add:const a = 10;',
    'add:const b = 2;',
    'del:const c = 3;',
    'add:const c = 30;',
    'ctx:end',
  ]);
  assert.equal(whollyChanged(lines[3].spans), true);
  const split = displayLines(hunk, 0, 'side');
  assert.deepEqual(split.map(sideKey), [
    'ctx:start|ctx:start',
    'del:const a = 1;|add:const a = 10;',
    '|add:const b = 2;',
    'del:const c = 3;|add:const c = 30;',
    'ctx:end|ctx:end',
  ]);
});
