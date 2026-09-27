'use strict';

const nodeTest = require('node:test');
const { test } = nodeTest;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { spawnSync } = childProcess;

const git = require('../lib/git.js');
const { load, addItem, unstageItem, revertItem } = git;
const { commitChanges, hasStaged, lastMessage, createGitRepo } = git;
const { currentBranch, listBranches, checkoutBranch } = git;
const { createBranch, dropBranch, pullChanges } = git;
const { listCommits, dropCommit, applyFixup } = git;
const { pushChanges, editItem } = git;
const utilities = require('../lib/utilities.js');
const { runProc } = utilities;
const session = require('../lib/session.js');
const { Session } = session;
const diff = require('../lib/diff/diff.js');
const { blockAddText } = diff;
const helpers = require('./helpers.js');
const { makeRepo, sink } = helpers;

const sessionFor = (dir) => {
  const stdout = sink();
  const session = new Session({
    repo: createGitRepo(),
    cwd: dir,
    stdout,
    color: false,
    startPane: 'diff',
  });
  session.load();
  return session;
};

test('AC4 add stages an unstaged block', () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'alpha\nbeta\ngamma\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'alpha\nBETA\ngamma\n');
    const loaded = load(repo.dir);
    assert.equal(loaded.items.length, 1);
    addItem(loaded.top, loaded.items[0]);
    const cached = repo.git(['diff', '--cached', '--', 'f.txt']);
    const work = repo.git(['diff', '--', 'f.txt']);
    assert.match(cached, /BETA/);
    assert.equal(work, '');
  } finally {
    repo.cleanup();
  }
});

test('AC5 revert restores worktree to HEAD', () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'alpha\nbeta\ngamma\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'alpha\nBETA\ngamma\n');
    const loaded = load(repo.dir);
    revertItem(loaded.top, loaded.items[0]);
    assert.equal(repo.read('f.txt'), 'alpha\nbeta\ngamma\n');
    const vsHead = repo.git(['diff', 'HEAD', '--', 'f.txt']);
    assert.equal(vsHead, '');
  } finally {
    repo.cleanup();
  }
});

test('AC7 untracked add and revert', () => {
  const repo = makeRepo();
  try {
    repo.write('keep.txt', 'k\n');
    repo.git(['add', 'keep.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('new.txt', 'hello\n');
    const loaded = load(repo.dir);
    const item = loaded.items.find((entry) => entry.origin === 'untracked');
    assert.ok(item);
    addItem(loaded.top, item);
    const cached = repo.git(['diff', '--cached', '--name-only']);
    assert.match(cached, /new.txt/);
    repo.git(['reset', 'HEAD', '--', 'new.txt']);
    const again = load(repo.dir);
    const untracked = again.items.find((entry) => entry.origin === 'untracked');
    revertItem(again.top, untracked);
    assert.equal(repo.exists('new.txt'), false);
  } finally {
    repo.cleanup();
  }
});

test('AC8 revert staged restores HEAD', () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'one\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'two\n');
    repo.git(['add', 'f.txt']);
    const session = sessionFor(repo.dir);
    assert.equal(session.items[0].origin, 'staged');
    session.dispatch('add');
    assert.equal(session.status, '');
    session.dispatch('revert');
    assert.equal(repo.read('f.txt'), 'one\n');
    const cached = repo.git(['diff', '--cached']);
    assert.equal(cached, '');
  } finally {
    repo.cleanup();
  }
});

test('add then unstage a block in a split hunk', () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'keep\nAAA\nkeep\nBBB\nkeep\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'keep\naaa\nkeep\nbbb\nkeep\n');
    const session = sessionFor(repo.dir);
    assert.equal(session.items.length, 2);
    session.dispatch('add');
    assert.equal(session.status, 'staged');
    session.dispatch('unstage');
    assert.equal(session.status, 'unstaged');
    const cached = repo.git(['diff', '--cached', '--', 'f.txt']);
    assert.equal(cached, '');
    assert.equal(repo.read('f.txt'), 'keep\naaa\nkeep\nbbb\nkeep\n');
  } finally {
    repo.cleanup();
  }
});

test('add both blocks of a split hunk without reload', () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'keep\nAAA\nkeep\nBBB\nkeep\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'keep\naaa\nkeep\nbbb\nkeep\n');
    const session = sessionFor(repo.dir);
    session.dispatch('add');
    assert.equal(session.status, 'staged');
    session.index = 1;
    session.dispatch('add');
    assert.equal(session.status, 'staged');
    assert.equal(session.items[0].origin, 'staged');
    assert.equal(session.items[1].origin, 'staged');
    const work = repo.git(['diff', '--', 'f.txt']);
    assert.equal(work, '');
  } finally {
    repo.cleanup();
  }
});

test('files pane add stages every remaining hunk', () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'keep\nAAA\nkeep\nBBB\nkeep\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'keep\naaa\nkeep\nbbb\nkeep\n');
    const session = sessionFor(repo.dir);
    assert.equal(session.items.length, 2);
    session.showFiles();
    session.dispatch('add');
    assert.equal(session.status, 'staged');
    assert.equal(session.items[0].origin, 'staged');
    assert.equal(session.items[1].origin, 'staged');
    const work = repo.git(['diff', '--', 'f.txt']);
    assert.equal(work, '');
  } finally {
    repo.cleanup();
  }
});

test('files pane unstage restores every staged hunk', () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'keep\nAAA\nkeep\nBBB\nkeep\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'keep\naaa\nkeep\nbbb\nkeep\n');
    repo.git(['add', 'f.txt']);
    const session = sessionFor(repo.dir);
    session.showFiles();
    session.dispatch('unstage');
    assert.equal(session.status, 'unstaged');
    assert.equal(session.items[0].origin, 'unstaged');
    assert.equal(session.items[1].origin, 'unstaged');
    const cached = repo.git(['diff', '--cached', '--', 'f.txt']);
    assert.equal(cached, '');
    assert.equal(repo.read('f.txt'), 'keep\naaa\nkeep\nbbb\nkeep\n');
  } finally {
    repo.cleanup();
  }
});

test('files pane revert restores the whole file', () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'keep\nAAA\nkeep\nBBB\nkeep\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'keep\naaa\nkeep\nbbb\nkeep\n');
    const session = sessionFor(repo.dir);
    session.showFiles();
    session.dispatch('revert');
    assert.equal(repo.read('f.txt'), 'keep\nAAA\nkeep\nBBB\nkeep\n');
    const vsHead = repo.git(['diff', 'HEAD', '--', 'f.txt']);
    assert.equal(vsHead, '');
    assert.equal(session.done, false);
    assert.notEqual(session.status, 'nothing to review');
  } finally {
    repo.cleanup();
  }
});

test('committing the last staged change does not end the review', () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'one\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'two\n');
    repo.git(['add', 'f.txt']);
    const session = sessionFor(repo.dir);
    assert.equal(session.items[0].origin, 'staged');
    session.showFiles();
    session.pushInput('c');
    session.pushInput('c');
    session.pushInput('land the change');
    session.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(session.done, false);
    assert.equal(session.emptyReview, false);
    assert.equal(session.status, 'committed');
    assert.equal(session.items.length, 0);
    assert.equal(session.pane, 'commits');
  } finally {
    repo.cleanup();
  }
});

test('unstage both blocks of a staged split hunk', () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'keep\nAAA\nkeep\nBBB\nkeep\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'keep\naaa\nkeep\nbbb\nkeep\n');
    repo.git(['add', 'f.txt']);
    const session = sessionFor(repo.dir);
    assert.equal(session.items.length, 2);
    session.dispatch('unstage');
    assert.equal(session.status, 'unstaged');
    session.index = 1;
    session.dispatch('unstage');
    assert.equal(session.status, 'unstaged');
    const cached = repo.git(['diff', '--cached', '--', 'f.txt']);
    assert.equal(cached, '');
    assert.equal(repo.read('f.txt'), 'keep\naaa\nkeep\nbbb\nkeep\n');
  } finally {
    repo.cleanup();
  }
});

test('add and unstage keep file order', () => {
  const repo = makeRepo();
  try {
    repo.write('a.txt', 'a\n');
    repo.write('b.txt', 'b\n');
    repo.write('c.txt', 'c\n');
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    repo.write('a.txt', 'A\n');
    repo.write('b.txt', 'B\n');
    repo.write('c.txt', 'C\n');
    const session = sessionFor(repo.dir);
    const paths = () => session.items.map((item) => item.file.newPath);
    assert.deepEqual(paths(), ['a.txt', 'b.txt', 'c.txt']);
    session.index = 1;
    session.dispatch('add');
    assert.equal(session.items[1].origin, 'staged');
    assert.deepEqual(paths(), ['a.txt', 'b.txt', 'c.txt']);
    assert.equal(session.current().file.newPath, 'b.txt');
    session.refreshFromRepo({ keepView: true });
    assert.deepEqual(paths(), ['a.txt', 'b.txt', 'c.txt']);
    assert.equal(session.items[1].origin, 'staged');
    assert.equal(session.current().file.newPath, 'b.txt');
    session.dispatch('unstage');
    assert.equal(session.items[1].origin, 'unstaged');
    assert.deepEqual(paths(), ['a.txt', 'b.txt', 'c.txt']);
  } finally {
    repo.cleanup();
  }
});

test('staging a later hunk keeps hunk order after reload', () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'keep\nAAA\nkeep\nBBB\nkeep\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'keep\naaa\nkeep\nbbb\nkeep\n');
    const session = sessionFor(repo.dir);
    assert.equal(session.items.length, 2);
    session.index = 1;
    const before = blockAddText(
      session.current().hunk,
      session.current().blockId,
    );
    session.dispatch('add');
    assert.equal(session.items[0].origin, 'unstaged');
    assert.equal(session.items[1].origin, 'staged');
    session.refreshFromRepo({ keepView: true });
    assert.equal(session.items.length, 2);
    assert.equal(session.items[0].origin, 'unstaged');
    assert.equal(session.items[1].origin, 'staged');
    assert.equal(session.current().origin, 'staged');
    assert.equal(
      blockAddText(session.current().hunk, session.current().blockId),
      before,
    );
  } finally {
    repo.cleanup();
  }
});

test('staging the current hunk keeps it on screen after reload', () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'keep\nAAA\nkeep\nBBB\nkeep\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'keep\naaa\nkeep\nbbb\nkeep\n');
    const session = sessionFor(repo.dir);
    assert.equal(session.items.length, 2);
    const before = blockAddText(
      session.current().hunk,
      session.current().blockId,
    );
    session.dispatch('add');
    assert.equal(session.current().origin, 'staged');
    session.refreshFromRepo({ keepView: true });
    assert.equal(session.current().origin, 'staged');
    assert.equal(
      blockAddText(session.current().hunk, session.current().blockId),
      before,
    );
    assert.equal(session.items[0].origin, 'staged');
    assert.equal(session.items[1].origin, 'unstaged');
  } finally {
    repo.cleanup();
  }
});

test('AC28 unstage staged keeps worktree', () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'one\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'two\n');
    repo.git(['add', 'f.txt']);
    const loaded = load(repo.dir);
    assert.equal(loaded.items[0].origin, 'staged');
    unstageItem(loaded.top, loaded.items[0]);
    assert.equal(repo.read('f.txt'), 'two\n');
    const cached = repo.git(['diff', '--cached', '--', 'f.txt']);
    assert.equal(cached, '');
    const work = repo.git(['diff', '--', 'f.txt']);
    assert.match(work, /two/);
  } finally {
    repo.cleanup();
  }
});

test('AC15 file argv loads only that file', () => {
  const repo = makeRepo();
  try {
    repo.write('keep.txt', 'k\n');
    repo.write('src/a.txt', 'a\n');
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    repo.write('keep.txt', 'K\n');
    repo.write('src/a.txt', 'A\n');
    const one = load(repo.dir, ['keep.txt']);
    assert.equal(one.items.length, 1);
    assert.equal(one.items[0].file.newPath, 'keep.txt');
    const folder = load(repo.dir, ['src']);
    assert.equal(folder.items.length, 1);
    assert.equal(folder.items[0].file.newPath, 'src/a.txt');
    const session = new Session({
      repo: createGitRepo(),
      cwd: repo.dir,
      paths: ['keep.txt'],
      stdout: sink(),
      color: false,
      startPane: 'diff',
    });
    session.load();
    assert.equal(session.pane, 'diff');
    const files = session.fileList();
    assert.equal(files.length, 2);
    assert.equal(files[0].kind, 'todos');
    assert.equal(files[1].path, 'keep.txt');
    assert.match(files[1].date, / ago$/);
  } finally {
    repo.cleanup();
  }
});

test('AC20 load commit patch ignores dirty worktree', () => {
  const repo = makeRepo();
  try {
    repo.write('keep.txt', 'k\n');
    repo.write('src/a.txt', 'a\n');
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    repo.write('src/a.txt', 'A\n');
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'change a']);
    const sha = repo.git(['rev-parse', 'HEAD']).trim();
    repo.write('src/a.txt', 'DIRTY\n');
    repo.write('new.txt', 'untracked\n');
    const loaded = load(repo.dir, [], { commit: sha });
    assert.ok(loaded.items.length >= 1);
    for (const item of loaded.items) {
      assert.equal(item.origin, 'commit');
      assert.notEqual(item.file.newPath, 'new.txt');
    }
    const paths = loaded.items.map((item) => item.file.newPath);
    assert.ok(paths.includes('src/a.txt'));
    const blob = JSON.stringify(loaded.items);
    assert.match(blob, /"text":"A"/);
    assert.equal(blob.includes('DIRTY'), false);
    const only = load(repo.dir, ['src/a.txt'], { commit: sha });
    assert.ok(only.items.length >= 1);
    for (const item of only.items) {
      assert.equal(item.file.newPath, 'src/a.txt');
    }
    const work = load(repo.dir);
    const origins = new Set(work.items.map((item) => item.origin));
    assert.ok(origins.has('unstaged') || origins.has('untracked'));
  } finally {
    repo.cleanup();
  }
});

test('load root commit via diff-tree', () => {
  const repo = makeRepo();
  try {
    repo.write('first.txt', 'hello\n');
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'root']);
    const sha = repo.git(['rev-parse', 'HEAD']).trim();
    const loaded = load(repo.dir, [], { commit: sha });
    assert.ok(loaded.items.length >= 1);
    assert.equal(loaded.items[0].origin, 'commit');
    assert.equal(loaded.items[0].file.newPath, 'first.txt');
    assert.ok(loaded.revShort);
  } finally {
    repo.cleanup();
  }
});

test('load omits files under .review', () => {
  const repo = makeRepo();
  try {
    repo.write('keep.txt', 'k\n');
    repo.git(['add', 'keep.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('keep.txt', 'K\n');
    repo.write('.review/2026-09-07-00.md', '---\nstatus: editing\n---\n');
    repo.write('.review/templates.json', '[]\n');
    const dirty = load(repo.dir);
    const dirtyPaths = dirty.items.map((item) => item.file.newPath);
    assert.deepEqual(dirtyPaths, ['keep.txt']);
    repo.git(['add', '.review/2026-09-07-00.md']);
    const mixed = load(repo.dir);
    for (const item of mixed.items) {
      const rel = item.file.newPath || item.file.oldPath;
      assert.equal(rel.startsWith('.review'), false);
    }
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'notes']);
    const sha = repo.git(['rev-parse', 'HEAD']).trim();
    const committed = load(repo.dir, [], { commit: sha });
    for (const item of committed.items) {
      const rel = item.file.newPath || item.file.oldPath;
      assert.equal(rel.startsWith('.review'), false);
    }
  } finally {
    repo.cleanup();
  }
});

test('commitChanges writes a commit from the message', () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'a\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'b\n');
    repo.git(['add', 'f.txt']);
    commitChanges(repo.dir, 'commit', 'second');
    const subject = repo.git(['log', '-1', '--format=%s']).trim();
    assert.equal(subject, 'second');
  } finally {
    repo.cleanup();
  }
});

test('commitChanges amend replaces the last message', () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'a\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'b\n');
    repo.git(['add', 'f.txt']);
    commitChanges(repo.dir, 'amend', 'rewritten');
    const log = repo.git(['log', '--format=%s']).trim().split('\n');
    assert.equal(log.length, 1);
    assert.equal(log[0], 'rewritten');
    assert.equal(lastMessage(repo.dir), 'rewritten');
  } finally {
    repo.cleanup();
  }
});

test('hasStaged is false until files are added', () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'a\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    assert.equal(hasStaged(repo.dir), false);
    repo.write('f.txt', 'b\n');
    repo.git(['add', 'f.txt']);
    assert.equal(hasStaged(repo.dir), true);
  } finally {
    repo.cleanup();
  }
});

test('commitChanges fixup writes the given message', () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'a\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'b\n');
    repo.git(['add', 'f.txt']);
    commitChanges(repo.dir, 'fixup', 'fixup! init');
    const subject = repo.git(['log', '-1', '--format=%s']).trim();
    assert.equal(subject, 'fixup! init');
  } finally {
    repo.cleanup();
  }
});

const makeBare = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reslop-bare-'));
  const result = spawnSync('git', ['init', '--bare', '-b', 'main'], {
    cwd: dir,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const msg = result.stderr || result.stdout || 'git init failed';
    throw new Error(msg.trim());
  }
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  return { dir, cleanup };
};

test('load includes the current branch', () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'a\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    const loaded = load(repo.dir);
    assert.equal(loaded.branch, 'main');
    assert.equal(currentBranch(repo.dir), 'main');
  } finally {
    repo.cleanup();
  }
});

test('listBranches createBranch and checkoutBranch', () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'a\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    const before = listBranches(repo.dir);
    assert.equal(before.length, 1);
    assert.equal(before[0].name, 'main');
    assert.equal(before[0].current, true);
    assert.equal(before[0].isDefault, true);
    assert.equal(before[0].subject, 'init');
    assert.equal(before[0].ahead, 0);
    assert.equal(before[0].behind, 0);
    assert.equal(before[0].gone, false);
    assert.match(before[0].sha, /^[0-9a-f]{7,}$/);
    assert.ok(before[0].date);
    createBranch(repo.dir, 'feat');
    assert.equal(currentBranch(repo.dir), 'feat');
    const onFeat = listBranches(repo.dir);
    const featNow = onFeat.find((entry) => entry.name === 'feat');
    const mainNow = onFeat.find((entry) => entry.name === 'main');
    assert.equal(featNow.current, true);
    assert.equal(featNow.isDefault, false);
    assert.equal(mainNow.current, false);
    assert.equal(mainNow.isDefault, true);
    checkoutBranch(repo.dir, 'main');
    assert.equal(currentBranch(repo.dir), 'main');
    const after = listBranches(repo.dir);
    const names = after.map((entry) => entry.name);
    assert.ok(names.includes('main'));
    assert.ok(names.includes('feat'));
    const feat = after.find((entry) => entry.name === 'feat');
    const main = after.find((entry) => entry.name === 'main');
    assert.equal(feat.current, false);
    assert.equal(feat.isDefault, false);
    assert.equal(main.isDefault, true);
    assert.equal(feat.subject, 'init');
    assert.match(feat.sha, /^[0-9a-f]{7,}$/);
  } finally {
    repo.cleanup();
  }
});

for (const method of ['rebaseBranch', 'rebaseBranchAsync']) {
  test(`${method} replays onto the selected branch`, async () => {
    const repo = makeRepo();
    try {
      repo.write('f.txt', 'base\n');
      repo.git(['add', 'f.txt']);
      repo.git(['commit', '-m', 'init']);
      createBranch(repo.dir, 'feat');
      repo.write('f.txt', 'feat\n');
      repo.git(['add', 'f.txt']);
      repo.git(['commit', '-m', 'feat']);
      checkoutBranch(repo.dir, 'main');
      repo.write('g.txt', 'main\n');
      repo.git(['add', 'g.txt']);
      repo.git(['commit', '-m', 'on-main']);
      checkoutBranch(repo.dir, 'feat');
      await git[method](repo.dir, 'main');
      assert.equal(currentBranch(repo.dir), 'feat');
      assert.equal(repo.read('g.txt'), 'main\n');
      assert.equal(repo.read('f.txt'), 'feat\n');
      const log = repo.git(['log', '--oneline']);
      assert.match(log, /on-main/);
      assert.match(log, /feat/);
    } finally {
      repo.cleanup();
    }
  });
}

for (const method of ['rebaseBranch', 'rebaseBranchAsync']) {
  test(`${method} aborts a conflicting rebase`, async () => {
    const repo = makeRepo();
    try {
      repo.write('f.txt', 'base\n');
      repo.git(['add', 'f.txt']);
      repo.git(['commit', '-m', 'init']);
      createBranch(repo.dir, 'feat');
      repo.write('f.txt', 'feat\n');
      repo.git(['add', 'f.txt']);
      repo.git(['commit', '-m', 'feat']);
      checkoutBranch(repo.dir, 'main');
      repo.write('f.txt', 'main\n');
      repo.git(['add', 'f.txt']);
      repo.git(['commit', '-m', 'on-main']);
      checkoutBranch(repo.dir, 'feat');
      await assert.rejects(async () => git[method](repo.dir, 'main'));
      assert.equal(currentBranch(repo.dir), 'feat');
      assert.equal(repo.read('f.txt'), 'feat\n');
    } finally {
      repo.cleanup();
    }
  });
}

test('listCommits is newest first with author date and hash', () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'a\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'b\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'next']);
    const listed = listCommits(repo.dir);
    assert.equal(listed.length, 2);
    assert.equal(listed[0].subject, 'next');
    assert.equal(listed[0].head, true);
    assert.equal(listed[1].subject, 'init');
    assert.equal(listed[1].head, false);
    assert.equal(listed[0].author, 'Test');
    assert.equal(listed[0].email, 'test@example.com');
    assert.ok(listed[0].date);
    assert.match(listed[0].sha, /^[0-9a-f]{40}$/);
    assert.match(listed[0].shortSha, /^[0-9a-f]{7,}$/);
    assert.match(listed[0].when, /^\d{4}-\d{2}-\d{2}/);
    assert.match(listed[0].refs, /HEAD -> main/);
    assert.equal(listed[0].added, 1);
    assert.equal(listed[0].removed, 1);
    assert.equal(listed[1].added, 1);
    assert.equal(listed[1].removed, 0);
  } finally {
    repo.cleanup();
  }
});

test('listCommits shows branch tips and the full message', () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'a\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'b\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'next', '-m', 'body line']);
    repo.git(['branch', 'feature']);
    repo.git(['tag', 'v1']);
    repo.git(['branch', 'old', 'HEAD~1']);
    repo.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    repo.git([
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/main',
    ]);
    repo.write('f.txt', 'c\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'third']);
    const listed = listCommits(repo.dir);
    assert.equal(listed[0].subject, 'third');
    assert.equal(listed[0].refs, 'HEAD -> main');
    assert.equal(listed[1].subject, 'next');
    assert.match(listed[1].refs, /feature/);
    assert.match(listed[1].refs, /origin\/main/);
    assert.equal(listed[1].refs.includes('HEAD ->'), false);
    assert.equal(listed[1].refs.includes('tag:'), false);
    assert.equal(listed[1].refs.includes('origin/HEAD'), false);
    assert.equal(listed[1].refs.includes('old'), false);
    assert.match(listed[1].body, /^next\n\nbody line/);
    assert.equal(listed[2].refs, 'old');
  } finally {
    repo.cleanup();
  }
});

for (const method of ['dropCommit', 'dropCommitAsync']) {
  test(`dropCommit soft-resets HEAD (${method})`, async () => {
    const repo = makeRepo();
    try {
      repo.write('f.txt', 'a\n');
      repo.git(['add', 'f.txt']);
      repo.git(['commit', '-m', 'one']);
      repo.write('f.txt', 'b\n');
      repo.git(['add', 'f.txt']);
      repo.git(['commit', '-m', 'two']);
      const listed = listCommits(repo.dir);
      await git[method](repo.dir, listed[0].sha);
      const subjects = listCommits(repo.dir).map((entry) => entry.subject);
      assert.deepEqual(subjects, ['one']);
      assert.equal(repo.read('f.txt'), 'b\n');
    } finally {
      repo.cleanup();
    }
  });
}

for (const method of ['dropCommit', 'dropCommitAsync']) {
  test(`dropCommit rebases out an older commit (${method})`, async () => {
    const repo = makeRepo();
    try {
      repo.write('a.txt', 'a\n');
      repo.git(['add', 'a.txt']);
      repo.git(['commit', '-m', 'one']);
      repo.write('b.txt', 'b\n');
      repo.git(['add', 'b.txt']);
      repo.git(['commit', '-m', 'two']);
      repo.write('c.txt', 'c\n');
      repo.git(['add', 'c.txt']);
      repo.git(['commit', '-m', 'three']);
      const older = listCommits(repo.dir)[1].sha;
      await git[method](repo.dir, older);
      const subjects = listCommits(repo.dir).map((entry) => entry.subject);
      assert.deepEqual(subjects, ['three', 'one']);
      assert.equal(repo.read('a.txt'), 'a\n');
      assert.equal(repo.read('c.txt'), 'c\n');
      assert.equal(repo.exists('b.txt'), false);
    } finally {
      repo.cleanup();
    }
  });
}

test('dropCommit refuses the root commit', () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'a\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    const root = listCommits(repo.dir)[0].sha;
    assert.throws(() => dropCommit(repo.dir, root));
    assert.equal(listCommits(repo.dir)[0].subject, 'init');
  } finally {
    repo.cleanup();
  }
});

for (const method of ['applyFixup', 'applyFixupAsync']) {
  test(`applyFixup squashes a fixup into its target (${method})`, async () => {
    const repo = makeRepo();
    try {
      repo.write('a.txt', 'one\n');
      repo.git(['add', 'a.txt']);
      repo.git(['commit', '-m', 'one']);
      repo.write('b.txt', 'two\n');
      repo.git(['add', 'b.txt']);
      repo.git(['commit', '-m', 'two']);
      repo.write('b.txt', 'two-fix\n');
      repo.git(['add', 'b.txt']);
      repo.git(['commit', '-m', 'fixup! two']);
      const listed = listCommits(repo.dir);
      assert.deepEqual(
        listed.map((entry) => entry.subject),
        ['fixup! two', 'two', 'one'],
      );
      await git[method](repo.dir, listed[0].sha);
      const after = listCommits(repo.dir).map((entry) => entry.subject);
      assert.deepEqual(after, ['two', 'one']);
      assert.equal(repo.read('b.txt'), 'two-fix\n');
    } finally {
      repo.cleanup();
    }
  });
}

test('applyFixup refuses a non-fixup commit', () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'a\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    const sha = listCommits(repo.dir)[0].sha;
    assert.throws(() => applyFixup(repo.dir, sha), /not a fixup commit/);
  } finally {
    repo.cleanup();
  }
});

for (const method of ['rewordCommit', 'rewordCommitAsync']) {
  test(`${method} changes HEAD message and preserves the index`, async () => {
    const repo = makeRepo();
    try {
      repo.write('a.txt', 'a\n');
      repo.git(['add', 'a.txt']);
      repo.git(['commit', '-m', 'one']);
      repo.write('b.txt', 'b\n');
      repo.git(['add', 'b.txt']);
      repo.git(['commit', '-m', 'two']);
      repo.write('s.txt', 'staged\n');
      repo.git(['add', 's.txt']);
      const head = listCommits(repo.dir)[0].sha;
      await git[method](repo.dir, head, 'TWO');
      const listed = listCommits(repo.dir).map((entry) => entry.subject);
      assert.deepEqual(listed, ['TWO', 'one']);
      assert.equal(hasStaged(repo.dir), true);
      assert.equal(repo.exists('s.txt'), true);
      const cached = repo.git(['diff', '--cached', '--', 's.txt']);
      assert.match(cached, /staged/);
    } finally {
      repo.cleanup();
    }
  });
}

for (const method of ['rewordCommit', 'rewordCommitAsync']) {
  test(`${method} rewrites an older message`, async () => {
    const repo = makeRepo();
    try {
      repo.write('a.txt', 'a\n');
      repo.git(['add', 'a.txt']);
      repo.git(['commit', '-m', 'one']);
      repo.write('b.txt', 'b\n');
      repo.git(['add', 'b.txt']);
      repo.git(['commit', '-m', 'two']);
      repo.write('c.txt', 'c\n');
      repo.git(['add', 'c.txt']);
      repo.git(['commit', '-m', 'three']);
      const older = listCommits(repo.dir)[1].sha;
      await git[method](repo.dir, older, 'TWO');
      const listed = listCommits(repo.dir).map((entry) => entry.subject);
      assert.deepEqual(listed, ['three', 'TWO', 'one']);
      assert.equal(repo.read('a.txt'), 'a\n');
      assert.equal(repo.read('b.txt'), 'b\n');
      assert.equal(repo.read('c.txt'), 'c\n');
    } finally {
      repo.cleanup();
    }
  });
}

test('dropBranch deletes a branch that is not current', () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'a\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    createBranch(repo.dir, 'feat');
    checkoutBranch(repo.dir, 'main');
    dropBranch(repo.dir, 'feat');
    const names = listBranches(repo.dir).map((entry) => entry.name);
    assert.equal(names.includes('feat'), false);
    assert.equal(currentBranch(repo.dir), 'main');
  } finally {
    repo.cleanup();
  }
});

test('listBranches reports ahead and behind vs upstream', () => {
  const repo = makeRepo();
  const bare = makeBare();
  try {
    repo.write('f.txt', 'a\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.git(['remote', 'add', 'origin', bare.dir]);
    repo.git(['push', '-u', 'origin', 'HEAD']);
    const synced = listBranches(repo.dir).find((entry) => entry.current);
    assert.equal(synced.ahead, 0);
    assert.equal(synced.behind, 0);
    assert.equal(synced.gone, false);
    repo.write('f.txt', 'b\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'next']);
    const ahead = listBranches(repo.dir).find((entry) => entry.current);
    assert.equal(ahead.ahead, 1);
    assert.equal(ahead.behind, 0);
    assert.equal(ahead.subject, 'next');
  } finally {
    repo.cleanup();
    bare.cleanup();
  }
});

test('listBranches prefers origin HEAD then master', () => {
  const repo = makeRepo();
  const bare = makeBare();
  try {
    repo.write('f.txt', 'a\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.git(['branch', '-m', 'master']);
    const renamed = listBranches(repo.dir);
    assert.equal(renamed[0].name, 'master');
    assert.equal(renamed[0].isDefault, true);
    repo.git(['branch', 'main']);
    repo.git(['remote', 'add', 'origin', bare.dir]);
    repo.git(['push', 'origin', 'main', 'master']);
    repo.git(['remote', 'set-head', 'origin', 'master']);
    const listed = listBranches(repo.dir);
    const main = listed.find((entry) => entry.name === 'main');
    const master = listed.find((entry) => entry.name === 'master');
    assert.equal(master.isDefault, true);
    assert.equal(main.isDefault, false);
  } finally {
    repo.cleanup();
    bare.cleanup();
  }
});

test('createBranch rejects an empty name', () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'a\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    assert.throws(() => createBranch(repo.dir, '  '), /empty branch name/);
  } finally {
    repo.cleanup();
  }
});

test('pushChanges sets origin upstream for the current branch', () => {
  const repo = makeRepo();
  const bare = makeBare();
  try {
    repo.write('f.txt', 'a\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.git(['checkout', '-b', 'autoreload']);
    repo.git(['remote', 'add', 'origin', bare.dir]);
    pushChanges(repo.dir);
    const tracking = repo.git([
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{upstream}',
    ]);
    assert.equal(tracking.trim(), 'origin/autoreload');
    const remoteLog = spawnSync(
      'git',
      ['log', 'autoreload', '-1', '--format=%s'],
      { cwd: bare.dir, encoding: 'utf8' },
    );
    assert.equal(remoteLog.stdout.trim(), 'init');
  } finally {
    repo.cleanup();
    bare.cleanup();
  }
});

test('pushChanges sets upstream then push and pull update', () => {
  const repo = makeRepo();
  const bare = makeBare();
  let cloneDir = '';
  try {
    repo.write('f.txt', 'a\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.git(['remote', 'add', 'origin', bare.dir]);
    pushChanges(repo.dir);
    const remoteLog = spawnSync('git', ['log', '-1', '--format=%s'], {
      cwd: bare.dir,
      encoding: 'utf8',
    });
    assert.equal(remoteLog.stdout.trim(), 'init');
    cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reslop-cl-'));
    const cloned = spawnSync('git', ['clone', bare.dir, cloneDir], {
      encoding: 'utf8',
    });
    assert.equal(cloned.status, 0, cloned.stderr);
    const cloneGit = (args) => {
      const result = spawnSync('git', args, {
        cwd: cloneDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@example.com',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 'test@example.com',
        },
      });
      if (result.status !== 0) {
        const msg = result.stderr || result.stdout || 'git failed';
        throw new Error(msg.trim());
      }
      return result.stdout;
    };
    cloneGit(['config', 'user.email', 'test@example.com']);
    cloneGit(['config', 'user.name', 'Test']);
    cloneGit(['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(cloneDir, 'f.txt'), 'b\n');
    cloneGit(['add', 'f.txt']);
    cloneGit(['commit', '-m', 'from clone']);
    cloneGit(['push']);
    pullChanges(repo.dir);
    assert.equal(repo.read('f.txt'), 'b\n');
  } finally {
    repo.cleanup();
    bare.cleanup();
    if (cloneDir) fs.rmSync(cloneDir, { recursive: true, force: true });
  }
});

test('pushChanges force-with-lease after a rewritten commit', () => {
  const repo = makeRepo();
  const bare = makeBare();
  try {
    repo.write('f.txt', 'a\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.git(['remote', 'add', 'origin', bare.dir]);
    pushChanges(repo.dir);
    repo.write('f.txt', 'b\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '--amend', '-m', 'amended']);
    assert.throws(
      () => pushChanges(repo.dir),
      (error) => {
        assert.equal(error.rejected, true);
        assert.match(error.message, /push rejected/);
        return true;
      },
    );
    pushChanges(repo.dir, true);
    const remoteLog = spawnSync('git', ['log', '-1', '--format=%s'], {
      cwd: bare.dir,
      encoding: 'utf8',
    });
    assert.equal(remoteLog.stdout.trim(), 'amended');
  } finally {
    repo.cleanup();
    bare.cleanup();
  }
});

const mockSignal = () => {
  const listeners = new Set();
  return {
    aborted: false,
    listeners,
    addEventListener(type, fn) {
      if (type === 'abort') listeners.add(fn);
    },
    removeEventListener(type, fn) {
      listeners.delete(fn);
    },
    abort() {
      this.aborted = true;
      for (const fn of [...listeners]) fn();
    },
  };
};

test('runProc finish removes abort listener on success', async () => {
  const signal = mockSignal();
  const result = await runProc(process.execPath, ['-e', 'process.exit(0)'], {
    signal,
  });
  assert.equal(result.status, 0);
  assert.equal(signal.listeners.size, 0);
});

test('runProc finish removes abort listener on abort', async () => {
  const signal = mockSignal();
  const pending = runProc(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { signal, timeout: 30000 },
  );
  signal.abort();
  const result = await pending;
  assert.equal(result.error.code, 'ABORT');
  assert.equal(signal.listeners.size, 0);
});

test('runProc finish removes abort listener on timeout', async () => {
  const signal = mockSignal();
  const result = await runProc(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { signal, timeout: 30 },
  );
  assert.equal(result.error.code, 'ETIMEDOUT');
  assert.equal(signal.listeners.size, 0);
});

test('loadAsync matches load for a dirty worktree', async () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'a\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'b\n');
    const sync = load(repo.dir);
    const asyncLoaded = await git.loadAsync(repo.dir);
    assert.equal(asyncLoaded.items.length, sync.items.length);
    assert.equal(asyncLoaded.items[0].origin, 'unstaged');
    assert.equal(asyncLoaded.branch, sync.branch);
  } finally {
    repo.cleanup();
  }
});

test('editItem writes added lines into the reviewed file', () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'alpha\nbeta\ngamma\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'alpha\nBETA\ngamma\n');
    const loaded = load(repo.dir);
    assert.equal(loaded.items.length, 1);
    editItem(loaded.top, loaded.items[0], 'BETA-edited');
    assert.equal(repo.read('f.txt'), 'alpha\nBETA-edited\ngamma\n');
    const again = load(repo.dir);
    const lines = again.items[0].hunk.lines;
    const adds = lines.filter((line) => line.type === 'add');
    assert.equal(adds.length, 1);
    assert.equal(adds[0].text, 'BETA-edited');
  } finally {
    repo.cleanup();
  }
});

test('e saves added lines to the reviewed file and reloads', () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'alpha\nbeta\ngamma\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'alpha\nBETA\ngamma\n');
    const session = sessionFor(repo.dir);
    session.dispatch('code');
    assert.equal(session.composeKind, 'code');
    session.editor.replace('BETA-edited');
    session.handleEvent({ type: 'key', key: 'escape' });
    assert.equal(session.mode, 'review');
    assert.equal(repo.read('f.txt'), 'alpha\nBETA-edited\ngamma\n');
    assert.equal(session.notes.code.size, 0);
    const cached = repo.git(['diff', '--cached', '--', 'f.txt']);
    const work = repo.git(['diff', '--', 'f.txt']);
    assert.match(cached, /\+BETA-edited/);
    assert.equal(work, '');
    assert.equal(session.current().origin, 'staged');
    assert.equal(session.status, 'staged');
    const adds = session
      .current()
      .hunk.lines.filter((line) => line.type === 'add');
    assert.equal(adds[0].text, 'BETA-edited');
  } finally {
    repo.cleanup();
  }
});

test('editItem updates staged added lines in the index', () => {
  const repo = makeRepo();
  try {
    repo.write('f.txt', 'alpha\nbeta\ngamma\n');
    repo.git(['add', 'f.txt']);
    repo.git(['commit', '-m', 'init']);
    repo.write('f.txt', 'alpha\nBETA\ngamma\n');
    repo.git(['add', 'f.txt']);
    const loaded = load(repo.dir);
    const item = loaded.items.find((entry) => entry.origin === 'staged');
    assert.ok(item);
    editItem(loaded.top, item, 'STAGED');
    assert.equal(repo.read('f.txt'), 'alpha\nSTAGED\ngamma\n');
    const cached = repo.git(['diff', '--cached', '--', 'f.txt']);
    assert.match(cached, /\+STAGED/);
    const work = repo.git(['diff', '--', 'f.txt']);
    assert.equal(work, '');
  } finally {
    repo.cleanup();
  }
});

test('listFiles includes tracked and untracked paths', () => {
  const repo = makeRepo();
  try {
    repo.write('b.js', 'b\n');
    repo.write('a.js', 'a\n');
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    repo.write('z.js', 'z\n');
    const names = createGitRepo().listFiles(repo.dir);
    assert.deepEqual(names, ['a.js', 'b.js', 'z.js']);
    assert.equal(createGitRepo().fileText(repo.dir, 'a.js'), 'a\n');
    createGitRepo().writeFile(repo.dir, 'nested/x.js', 'x\n');
    assert.equal(repo.read('nested/x.js'), 'x\n');
  } finally {
    repo.cleanup();
  }
});

test('file edit save stages the whole file', () => {
  const repo = makeRepo();
  try {
    repo.write(
      'a.js',
      'alpha\nbeta\nkeep1\nkeep2\nkeep3\nkeep4\nkeep5\ngamma\n',
    );
    repo.git(['add', 'a.js']);
    repo.git(['commit', '-m', 'init']);
    repo.write(
      'a.js',
      'alpha\nBETA\nkeep1\nkeep2\nkeep3\nkeep4\nkeep5\ngamma\n',
    );
    const stdout = sink();
    const session = new Session({
      repo: createGitRepo(),
      cwd: repo.dir,
      stdout,
      color: false,
      startPane: 'files',
    });
    session.load();
    session.dispatch('file');
    session.dispatch('next');
    session.dispatch('open');
    session.dispatch('code');
    session.editor.replace(
      'alpha\nBETA\nkeep1\nkeep2\nkeep3\nkeep4\nkeep5\nGAMMA\n',
    );
    session.composer.saveCompose();
    const cached = repo.git(['diff', '--cached', '--', 'a.js']);
    const work = repo.git(['diff', '--', 'a.js']);
    assert.match(cached, /BETA/);
    assert.match(cached, /GAMMA/);
    assert.equal(work, '');
    assert.ok(session.items.every((entry) => entry.origin === 'staged'));
    assert.equal(session.status, 'staged');
  } finally {
    repo.cleanup();
  }
});

for (const first of ['git', 'git-branches', 'git-deps']) {
  test(`Git repository works when ${first} is imported first`, () => {
    const script = `
      const assert = require('node:assert/strict');
      require('./lib/' + process.argv[1] + '.js');
      const repo = require('./lib/git.js').createGitRepo();
      for (const name of ['load', 'add', 'revertFile', 'commit', 'rebase']) {
        assert.equal(typeof repo[name], 'function', name);
      }
    `;
    const result = spawnSync(process.execPath, ['-e', script, first], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  });
}
