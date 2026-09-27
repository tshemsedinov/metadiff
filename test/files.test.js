'use strict';

const nodeTest = require('node:test');
const { test } = nodeTest;
const assert = require('node:assert/strict');

const files = require('../lib/files.js');
const { fileEntries, fileStatus, itemPath, relativeAge, shortAge } = files;
const { TODO_FILE, REPO_TODOS_LABEL, isTodosEntry, isTodoItem } = files;
const { fileTotals, isTotalEntry, TOTAL_LABEL } = files;

const item = (name, origin, indexHint) => ({
  origin,
  file: { newPath: name, oldPath: name },
  blockId: indexHint,
});

test('fileEntries groups blocks by path', () => {
  const items = [
    item('a.js', 'unstaged', 0),
    item('a.js', 'unstaged', 1),
    item('b.js', 'staged', 0),
    item('c.js', 'untracked', 0),
  ];
  const entries = fileEntries(items);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].path, 'a.js');
  assert.equal(entries[0].remaining, 2);
  assert.equal(entries[0].status, 'unstaged');
  assert.equal(entries[0].unstaged, 2);
  assert.equal(entries[0].staged, 0);
  assert.equal(entries[0].firstIndex, 0);
  assert.equal(entries[0].openIndex, 0);
  assert.equal(entries[1].path, 'b.js');
  assert.equal(entries[1].status, 'staged');
  assert.equal(entries[1].staged, 1);
  assert.equal(entries[2].path, 'c.js');
  assert.equal(entries[2].status, 'untracked');
  assert.equal(itemPath(items[0]), 'a.js');
});

test('fileStatus joins mixed origins', () => {
  assert.equal(fileStatus(['unstaged', 'staged']), 'partial');
  assert.equal(fileStatus(['staged', 'unstaged']), 'partial');
  assert.equal(fileStatus(['todo']), '');
  assert.equal(fileStatus(['todo', 'unstaged']), 'unstaged');
});

test('fileEntries skips todo items', () => {
  const items = [
    { origin: 'todo', file: { newPath: TODO_FILE, oldPath: TODO_FILE } },
    item('a.js', 'unstaged', 0),
  ];
  const entries = fileEntries(items);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, 'a.js');
  assert.equal(isTodoItem(items[0]), true);
  assert.equal(isTodoItem(items[1]), false);
});

test('fileEntries counts lines and mixed staged blocks', () => {
  const hunk = {
    lines: [
      { type: 'del', text: 'x', blockId: 0 },
      { type: 'add', text: 'y', blockId: 0 },
      { type: 'ctx', text: 'z', blockId: null },
      { type: 'add', text: 'w', blockId: 1 },
      { type: 'del', text: 'v', blockId: 1 },
      { type: 'del', text: 'u', blockId: 1 },
    ],
  };
  const unstaged = item('mix.js', 'unstaged', 0);
  unstaged.hunk = hunk;
  const staged = item('mix.js', 'staged', 1);
  staged.hunk = hunk;
  const entries = fileEntries([unstaged, staged]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'partial');
  assert.equal(entries[0].staged, 1);
  assert.equal(entries[0].unstaged, 1);
  assert.equal(entries[0].added, 2);
  assert.equal(entries[0].removed, 3);
  assert.equal(entries[0].stagedAdded, 1);
  assert.equal(entries[0].stagedRemoved, 2);
  assert.equal(entries[0].unstagedAdded, 1);
  assert.equal(entries[0].unstagedRemoved, 1);
  assert.equal(entries[0].remaining, 2);
});

test('fileTotals sums line and origin counts across files', () => {
  const todos = {
    path: REPO_TODOS_LABEL,
    kind: 'todos',
    status: 'todos',
    remaining: 5,
    staged: 2,
    added: 0,
    removed: 0,
    unstaged: 0,
  };
  const entries = [
    todos,
    {
      path: 'a.js',
      status: 'unstaged',
      remaining: 4,
      staged: 0,
      unstaged: 4,
      added: 12,
      removed: 5,
    },
    {
      path: 'b.js',
      status: 'staged',
      remaining: 1,
      staged: 1,
      unstaged: 0,
      added: 3,
      removed: 1,
    },
    {
      path: 'c.js',
      status: 'untracked',
      remaining: 2,
      staged: 0,
      unstaged: 0,
      added: 20,
      removed: 0,
    },
  ];
  const total = fileTotals(entries);
  assert.equal(total.kind, 'total');
  assert.equal(total.path, TOTAL_LABEL);
  assert.equal(total.added, 35);
  assert.equal(total.removed, 6);
  assert.equal(total.stagedAdded, 3);
  assert.equal(total.stagedRemoved, 1);
  assert.equal(total.unstagedAdded, 32);
  assert.equal(total.unstagedRemoved, 5);
  assert.equal(total.staged, 1);
  assert.equal(total.unstaged, 6);
  assert.equal(total.remaining, 7);
  assert.equal(isTodosEntry(total), false);
  assert.equal(isTotalEntry(total), true);
  assert.equal(isTotalEntry(todos), false);
});

test('fileEntries opens a partial file on the first unstaged block', () => {
  const entries = fileEntries([
    item('mix.js', 'staged', 0),
    item('mix.js', 'unstaged', 1),
    item('mix.js', 'unstaged', 2),
  ]);
  assert.equal(entries[0].status, 'partial');
  assert.equal(entries[0].firstIndex, 0);
  assert.equal(entries[0].openIndex, 1);
});

test('relativeAge uses short units', () => {
  const now = 1_000_000_000_000;
  assert.equal(relativeAge(now - 1000, now), '1s ago');
  assert.equal(relativeAge(now - 2000, now), '2s ago');
  assert.equal(relativeAge(now - 2 * 3600 * 1000, now), '2h ago');
  assert.equal(relativeAge(now - 2 * 86400 * 1000, now), '2d ago');
  assert.equal(relativeAge(now - 21 * 86400 * 1000, now), '3w ago');
  assert.equal(relativeAge(now - 400 * 86400 * 1000, now), '1y ago');
});

test('shortAge compresses git relative dates', () => {
  assert.equal(shortAge('2 hours ago'), '2h ago');
  assert.equal(shortAge('1 hour ago'), '1h ago');
  assert.equal(shortAge('yesterday'), '1d ago');
  assert.equal(shortAge('3 days ago'), '3d ago');
  assert.equal(shortAge('3 weeks ago'), '3w ago');
  assert.equal(shortAge('4 months ago'), '4mo ago');
  assert.equal(shortAge('2 years ago'), '2y ago');
  assert.equal(shortAge('45 seconds ago'), '45s ago');
  assert.equal(shortAge('12 minutes ago'), '12m ago');
  assert.equal(shortAge('2h'), '2h ago');
  assert.equal(shortAge('2h ago'), '2h ago');
  assert.equal(shortAge(''), '');
});

test('fileEntries copies the first item date', () => {
  const staged = item('a.js', 'staged', 0);
  staged.date = '2 hours ago';
  const unstaged = item('a.js', 'unstaged', 1);
  unstaged.date = 'yesterday';
  const entries = fileEntries([staged, unstaged]);
  assert.equal(entries[0].date, '2 hours ago');
});

test('fileEntries sorts by path from the repo root', () => {
  const entries = fileEntries([
    item('lib/z.js', 'unstaged', 0),
    item('a.js', 'staged', 1),
    item('lib/a.js', 'untracked', 2),
    item('README.md', 'unstaged', 3),
  ]);
  const paths = entries.map((entry) => entry.path);
  assert.deepEqual(paths, ['a.js', 'lib/a.js', 'lib/z.js', 'README.md']);
});

test('fileEntries lists lockfile changes under package.json', () => {
  const entries = fileEntries([
    item('package-lock.json', 'staged', 0),
    item('package.json', 'unstaged', 1),
    item('packages/app/package-lock.json', 'unstaged', 2),
  ]);
  const paths = entries.map((entry) => entry.path);
  assert.deepEqual(paths, ['package.json', 'packages/app/package.json']);
  assert.equal(entries[0].remaining, 2);
  assert.equal(entries[0].status, 'partial');
  assert.equal(entries[1].path, 'packages/app/package.json');
  assert.equal(entries[1].remaining, 1);
});
