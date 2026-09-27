'use strict';

const nodeTest = require('node:test');
const { test } = nodeTest;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const session = require('../lib/session.js');
const { Session } = session;
const review = require('../lib/review.js');
const { addTodo } = review;
const items = require('../lib/session/items.js');
const { restoredIndex, alignLoadedItems } = items;
const watch = require('../lib/session/watch.js');
const { ignoredRel, isOwnDirEvent, createDiskWatcher, DEBOUNCE_MS } = watch;
const helpers = require('./helpers.js');
const { uiSink, tempDir } = helpers;

const wait = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const waitUntil = async (check, ms = 500) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (check()) return true;
    await wait(20);
  }
  return false;
};

const sampleItem = (name, extra = {}) => ({
  origin: extra.origin ?? 'unstaged',
  file: {
    oldPath: name,
    newPath: name,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    preamble: [`diff --git a/${name} b/${name}`],
    hunks: [],
  },
  hunk: {
    oldStart: extra.oldStart ?? 1,
    oldCount: 1,
    newStart: extra.newStart ?? 1,
    newCount: 1,
    header: '@@ -1,1 +1,1 @@',
    lines: [{ type: 'add', text: extra.text ?? 'x', noNl: false, blockId: 0 }],
  },
  blockId: 0,
});

const mockRepo = (initial, top) => {
  let current = [...initial];
  return {
    load: () => ({ top, items: [...current], branch: 'main' }),
    setItems: (next) => {
      current = [...next];
    },
  };
};

const openWatched = (list, extra = {}) => {
  const cwd = extra.cwd ?? tempDir('reslop-watch-');
  const repo = extra.repo ?? mockRepo(list, cwd);
  const session = new Session({
    color: false,
    startPane: extra.startPane ?? 'diff',
    ...extra,
    cwd,
    stdout: extra.stdout ?? uiSink(),
    repo,
  });
  session.load();
  return { session, repo, cwd };
};

test('linux recursive watch is available from Node 19.1', () => {
  const { canWatchRecursive } = watch;
  assert.equal(canWatchRecursive('linux', '18.20.0'), false);
  assert.equal(canWatchRecursive('linux', '19.0.0'), false);
  assert.equal(canWatchRecursive('linux', '19.1.0'), true);
  assert.equal(canWatchRecursive('linux', '22.11.0'), true);
  assert.equal(canWatchRecursive('win32', '18.20.0'), true);
});

test('disk watcher watches nested files when recursive is off', async () => {
  const cwd = tempDir('reslop-watch-');
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.mkdirSync(path.join(cwd, '.git'));
  const nested = path.join(cwd, 'src', 'nested.js');
  fs.writeFileSync(nested, 'x\n');
  let n = 0;
  const watcher = createDiskWatcher({
    root: cwd,
    recursive: false,
    debounceMs: 20,
    onChange: () => {
      n += 1;
    },
  });
  try {
    await wait(60);
    fs.writeFileSync(nested, 'y\n');
    assert.equal(await waitUntil(() => n >= 1, 1000), true);
  } finally {
    watcher.close();
  }
});

test('ignoredRel skips review, modules, and git internals', () => {
  assert.equal(ignoredRel('.review/x.md'), true);
  assert.equal(ignoredRel('node_modules/x'), true);
  assert.equal(ignoredRel('.git/objects/aa'), true);
  assert.equal(ignoredRel('.git/index.lock'), true);
  assert.equal(ignoredRel('.git/COMMIT_EDITMSG'), true);
  assert.equal(ignoredRel('.git/index'), false);
  assert.equal(ignoredRel('.git/HEAD'), false);
  assert.equal(ignoredRel('.git/refs/heads/main'), false);
  assert.equal(ignoredRel('src/a.js'), false);
  assert.equal(ignoredRel('src\\a.js'), false);
  assert.equal(ignoredRel('.git\\index.lock'), true);
  assert.equal(ignoredRel('a.js.swp'), true);
});

test('own directory event is not a file change', () => {
  const cwd = tempDir('reslop-watch-');
  const base = path.basename(cwd);
  assert.equal(isOwnDirEvent(cwd, base), true);
  assert.equal(isOwnDirEvent(cwd, `./${base}`), true);
  fs.writeFileSync(path.join(cwd, 'a.js'), 'x\n');
  assert.equal(isOwnDirEvent(cwd, 'a.js'), false);
  assert.equal(isOwnDirEvent(cwd, ''), false);
});

test('review markdown notifies onReview and not onChange', async () => {
  const cwd = tempDir('reslop-watch-');
  fs.mkdirSync(path.join(cwd, '.git'));
  fs.mkdirSync(path.join(cwd, '.review'));
  const file = path.join(cwd, '.review', '2026-09-23-00.md');
  fs.writeFileSync(file, '---\nstatus: editing\n---\n');
  let changes = 0;
  let reviews = 0;
  const watcher = createDiskWatcher({
    root: cwd,
    recursive: false,
    debounceMs: 20,
    onChange: () => {
      changes += 1;
    },
    onReview: () => {
      reviews += 1;
    },
  });
  await wait(60);
  const body = '---\nstatus: editing\n---\n\n## TODOs\n\n- [ ] gamma\n';
  fs.writeFileSync(file, body);
  assert.equal(await waitUntil(() => reviews >= 1, 1000), true);
  await wait(250);
  assert.equal(changes, 0);
  watcher.close();
});

test('disk watcher debounces changes and ignores lock files', async () => {
  const cwd = tempDir('reslop-watch-');
  fs.mkdirSync(path.join(cwd, '.git'));
  fs.writeFileSync(path.join(cwd, 'a.js'), 'x\n');
  let n = 0;
  const watcher = createDiskWatcher({
    root: cwd,
    recursive: false,
    debounceMs: 20,
    onChange: () => {
      n += 1;
    },
  });
  fs.writeFileSync(path.join(cwd, '.git', 'index.lock'), 'lock\n');
  await wait(60);
  const before = n;
  fs.writeFileSync(path.join(cwd, 'a.js'), 'y\n');
  assert.equal(await waitUntil(() => n > before), true);
  watcher.close();
});

test('restoredIndex keeps the same changed lines when headers collide', () => {
  const here = sampleItem('f.js', { origin: 'staged', text: 'aaa' });
  const other = sampleItem('f.js', { origin: 'staged', text: 'bbb' });
  const remain = sampleItem('f.js', { text: 'aaa' });
  assert.equal(restoredIndex([other, remain], here), 1);
});

test('ignoreWatch skips the next disk reload', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session, repo } = openWatched([a]);
  session.uiOpen = true;
  session.lifecycle.ignoreWatch();
  repo.setItems([a, b]);
  session.lifecycle.onDiskChange();
  assert.equal(session.items.length, 1);
});

test('alignLoadedItems prefers changed lines over hunk headers', () => {
  const first = sampleItem('f.js', { text: 'aaa' });
  const second = sampleItem('f.js', { text: 'bbb' });
  second.blockId = 1;
  second.hunk = {
    ...second.hunk,
    lines: [{ type: 'add', text: 'bbb', noNl: false, blockId: 1 }],
  };
  const staged = sampleItem('f.js', { origin: 'staged', text: 'bbb' });
  const remain = sampleItem('f.js', { text: 'aaa' });
  const ordered = alignLoadedItems([first, second], [staged, remain]);
  assert.equal(ordered[0].hunk.lines[0].text, 'aaa');
  assert.equal(ordered[0].origin, 'unstaged');
  assert.equal(ordered[1].hunk.lines[0].text, 'bbb');
  assert.equal(ordered[1].origin, 'staged');
});

test('alignLoadedItems keeps order when origin and headers change', () => {
  const prevA = sampleItem('a.js', { text: 'a' });
  const prevB = sampleItem('b.js', { text: 'b' });
  const prevC = sampleItem('c.js', { text: 'c' });
  const nextB = sampleItem('b.js', {
    origin: 'staged',
    text: 'b',
    oldStart: 8,
    newStart: 8,
  });
  const nextA = sampleItem('a.js', { text: 'a' });
  const nextC = sampleItem('c.js', { text: 'c' });
  const prev = [prevA, prevB, prevC];
  const next = [nextB, nextA, nextC];
  const ordered = alignLoadedItems(prev, next);
  assert.deepEqual(
    ordered.map((item) => item.file.newPath),
    ['a.js', 'b.js', 'c.js'],
  );
  assert.equal(ordered[1].origin, 'staged');
  assert.equal(ordered[1].hunk.oldStart, 8);
});

test('watch reload keeps item order after origin change', () => {
  const a = sampleItem('a.js', { text: 'a' });
  const b = sampleItem('b.js', { text: 'b' });
  const c = sampleItem('c.js', { text: 'c' });
  const { session, repo } = openWatched([a, b, c]);
  session.uiOpen = true;
  session.index = 1;
  repo.setItems([{ ...b, origin: 'staged' }, a, c]);
  session.lifecycle.onDiskChange();
  assert.deepEqual(
    session.items.map((item) => item.file.newPath),
    ['a.js', 'b.js', 'c.js'],
  );
  assert.equal(session.items[1].origin, 'staged');
  assert.equal(session.current().file.newPath, 'b.js');
});

test('restoredIndex keeps a shifted hunk on the same file', () => {
  const before = sampleItem('a.js', { oldStart: 1, newStart: 1 });
  const moved = sampleItem('a.js', { oldStart: 40, newStart: 40 });
  const other = sampleItem('b.js');
  assert.equal(restoredIndex([moved, other], before), 0);
  assert.equal(restoredIndex([other, moved], before), 1);
});

test('disk watch reloads without leaving the current screen', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const c = sampleItem('c.js');
  const { session, repo } = openWatched([a, b]);
  session.uiOpen = true;
  session.dispatch('next');
  session.scroll = 6;
  session.selection = { start: { x: 1, y: 1 }, end: { x: 2, y: 1 } };
  session.dismissed.add('unstaged:gone.js:1:1:0');
  session.status = 'staged';
  repo.setItems([a, b, c]);
  session.lifecycle.onDiskChange();
  assert.equal(session.pane, 'diff');
  assert.equal(session.current().file.newPath, 'b.js');
  assert.equal(session.scroll, 6);
  assert.deepEqual(session.selection, {
    start: { x: 1, y: 1 },
    end: { x: 2, y: 1 },
  });
  assert.equal(session.items.length, 3);
  assert.equal(session.dismissed.size, 1);
  assert.equal(session.status, 'staged');
  assert.equal(session.busy, '');
  assert.equal(session.mode, 'review');
});

test('disk watch keeps the files pane on the same path', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const extra = sampleItem('0.js');
  const { session, repo } = openWatched([a, b], { startPane: 'files' });
  session.uiOpen = true;
  session.dispatch('next');
  assert.equal(session.fileList()[session.fileCursor].path, 'a.js');
  repo.setItems([extra, a, b]);
  session.lifecycle.onDiskChange();
  assert.equal(session.pane, 'files');
  assert.equal(session.fileList()[session.fileCursor].path, 'a.js');
  assert.equal(session.busy, '');
});

test('disk watch follows a hunk whose line numbers moved', () => {
  const before = sampleItem('a.js', { oldStart: 1, newStart: 1 });
  const moved = sampleItem('a.js', { oldStart: 12, newStart: 12, text: 'y' });
  const { session, repo } = openWatched([before]);
  session.uiOpen = true;
  session.scroll = 4;
  repo.setItems([moved]);
  session.lifecycle.onDiskChange();
  assert.equal(session.current().hunk.newStart, 12);
  assert.equal(session.current().file.newPath, 'a.js');
  assert.equal(session.scroll, 4);
  assert.equal(session.pane, 'diff');
});

test('compose defers disk reload until the editor closes', async () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session, repo } = openWatched([a]);
  session.uiOpen = true;
  session.dispatch('feedback');
  repo.setItems([a, b]);
  session.lifecycle.onDiskChange();
  assert.equal(session.mode, 'compose');
  assert.equal(session.items.length, 1);
  assert.equal(session.editor.text, '');
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.mode, 'review');
  await wait(DEBOUNCE_MS + 50);
  assert.equal(session.items.length, 2);
  assert.equal(session.current().file.newPath, 'a.js');
});

test('busy git work defers disk reload', async () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session, repo } = openWatched([a]);
  session.uiOpen = true;
  session.gitBusy = true;
  repo.setItems([a, b]);
  session.lifecycle.onDiskChange();
  assert.equal(session.items.length, 1);
  session.gitBusy = false;
  await wait(DEBOUNCE_MS + 50);
  assert.equal(session.items.length, 2);
});

test('commit reviews do not start a disk watcher', () => {
  const { session } = openWatched([sampleItem('a.js')], { rev: 'abc1234' });
  session.uiOpen = true;
  session.lifecycle.startWatch();
  session.lifecycle.stopWatch();
});

test('worktree watch starts and stops fs watchers', () => {
  const { session } = openWatched([sampleItem('a.js')]);
  session.uiOpen = true;
  session.lifecycle.startWatch();
  session.lifecycle.stopWatch();
  session.lifecycle.stopWatch();
});

test('npm extras do not block a disk reload', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session, repo } = openWatched([a]);
  session.uiOpen = true;
  session.busy = 'checking npm';
  repo.setItems([a, b]);
  session.lifecycle.onDiskChange();
  assert.equal(session.items.length, 2);
  assert.equal(session.pane, 'diff');
});

test('diff pane poll reloads when the current file changes', () => {
  const cwd = tempDir('reslop-watch-');
  const file = path.join(cwd, 'a.js');
  fs.writeFileSync(file, 'old\n');
  const before = sampleItem('a.js', { text: 'old' });
  const after = sampleItem('a.js', { text: 'newer' });
  const { session, repo } = openWatched([before], { cwd });
  session.uiOpen = true;
  session.lifecycle.pollCurrentFile();
  assert.equal(session.current().hunk.lines[0].text, 'old');
  repo.setItems([after]);
  fs.writeFileSync(file, 'newer\n');
  session.lifecycle.pollCurrentFile();
  assert.equal(session.current().hunk.lines[0].text, 'newer');
  assert.equal(session.pane, 'diff');
  assert.equal(session.busy, '');
});

test('files pane poll does not reload', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session, repo } = openWatched([a], { startPane: 'files' });
  session.uiOpen = true;
  session.lifecycle.pollCurrentFile();
  repo.setItems([a, b]);
  session.lifecycle.pollCurrentFile();
  assert.equal(session.items.length, 1);
});

test('todo page poll reloads when a worktree file changes', () => {
  const cwd = tempDir('reslop-watch-');
  const file = path.join(cwd, 'a.js');
  fs.writeFileSync(file, 'old\n');
  const before = sampleItem('a.js', { text: 'old' });
  const after = sampleItem('a.js', { text: 'newer' });
  const { session, repo } = openWatched([before], { cwd });
  session.uiOpen = true;
  session.composer.openTodoPage();
  session.lifecycle.pollCurrentFile();
  assert.equal(session.items[0].hunk.lines[0].text, 'old');
  repo.setItems([after]);
  fs.writeFileSync(file, 'newer\n');
  session.lifecycle.pollCurrentFile();
  assert.equal(session.todoOpen, true);
  assert.equal(session.items[0].hunk.lines[0].text, 'newer');
});

test('leaving todos reloads the file list', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session, repo } = openWatched([a]);
  session.uiOpen = true;
  session.composer.openTodoPage();
  repo.setItems([a, b]);
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.pane, 'files');
  assert.equal(session.todoOpen, false);
  assert.equal(session.items.length, 2);
});

test('editing a todo applies a deferred reload on exit', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session, repo } = openWatched([a]);
  session.uiOpen = true;
  session.composer.openTodoPage();
  session.composer.editFocusedTodo();
  assert.equal(session.mode, 'compose');
  repo.setItems([a, b]);
  session.lifecycle.onDiskChange();
  assert.equal(session.items.length, 1);
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.todoOpen, true);
  assert.equal(session.items.length, 1);
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.pane, 'files');
  assert.equal(session.items.length, 2);
});

test('review file change merges into the open todo list', () => {
  const { session } = openWatched([sampleItem('a.js')]);
  session.uiOpen = true;
  session.dispatch('todo');
  session.pushInput('alpha');
  session.handleEvent({ type: 'key', key: 'escape' });
  addTodo(session.notes, 'TODOs', 'beta');
  const file = session.notes.reviewPath;
  const md = fs.readFileSync(file, 'utf8');
  const next = md.replace('- [ ] alpha\n', '- [ ] alpha\n- [ ] gamma\n');
  fs.writeFileSync(file, next);
  session.lifecycle.applyReviewChange();
  const texts = session.notes.todos.map((todo) => todo.text);
  assert.deepEqual(texts, ['alpha', 'gamma', 'beta']);
});

test('external todo edits replace the line instead of stacking', () => {
  const { session } = openWatched([sampleItem('a.js')]);
  session.uiOpen = true;
  session.dispatch('todo');
  session.pushInput('one');
  session.handleEvent({ type: 'key', key: 'escape' });
  addTodo(session.notes, 'TODOs', 'beta');
  const edited = session.notes.todos[0].id;
  const file = session.notes.reviewPath;
  const writeLine = (text) => {
    const md = fs.readFileSync(file, 'utf8');
    const next = md.replace(/- \[ \] one[^\n]*\n/, `- [ ] ${text}\n`);
    fs.writeFileSync(file, next);
    session.lifecycle.applyReviewChange();
  };
  writeLine('one three');
  writeLine('one three four');
  writeLine('one three four five');
  const texts = session.notes.todos.map((todo) => todo.text);
  assert.deepEqual(texts, ['one three four five', 'beta']);
  assert.equal(session.notes.todos[0].id, edited);
});

test('leaving branches reloads the file list', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session, repo } = openWatched([a], { startPane: 'branches' });
  session.uiOpen = true;
  repo.setItems([a, b]);
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.pane, 'files');
  assert.equal(session.items.length, 2);
});

test('async disk watch does not flash a loading state', async () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const cwd = tempDir('reslop-watch-');
  let list = [a];
  const { session } = openWatched([a], {
    cwd,
    repo: {
      load: () => ({ top: cwd, items: [...list], branch: 'main' }),
      loadAsync: async () => ({
        top: cwd,
        items: [...list],
        branch: 'main',
      }),
    },
  });
  session.uiOpen = true;
  session.scroll = 3;
  list = [a, b];
  await new Promise((resolve) => {
    session.refreshFromRepo({
      keepView: true,
      quiet: true,
      afterLoad: resolve,
    });
  });
  assert.equal(session.items.length, 2);
  assert.equal(session.scroll, 3);
  assert.equal(session.busy, '');
  assert.equal(session.status, '');
  assert.equal(session.pane, 'diff');
});

test('watch reload skips npm extras if package files are same', async () => {
  const gitItem = sampleItem('a.js');
  const extraItem = sampleItem('package.json');
  extraItem.dep = { change: { name: 'lodash', section: 'dependencies' } };
  const cwd = tempDir('reslop-watch-');
  fs.writeFileSync(path.join(cwd, 'package.json'), '{}\n');
  let extras = 0;
  const { session } = openWatched([gitItem], {
    cwd,
    audit: true,
    repo: {
      load: () => ({ top: cwd, items: [gitItem], branch: 'main' }),
      loadAsync: async (_dir, _paths, options = {}) => {
        const loaded = [gitItem];
        if (options.auditMap || options.outdatedMap) loaded.push(extraItem);
        return {
          top: cwd,
          items: loaded,
          pending: options.deferExtras === true,
        };
      },
      loadExtras: async () => {
        extras += 1;
        return {
          top: cwd,
          items: [gitItem, extraItem],
          pending: false,
          auditMap: { lodash: 1 },
          outdatedMap: null,
        };
      },
    },
  });
  session.uiOpen = true;
  session.loader.didLoad = false;
  await session.openLoad();
  assert.equal(extras, 1);
  assert.equal(session.items.length, 2);
  await new Promise((resolve) => {
    session.refreshFromRepo({
      keepView: true,
      quiet: true,
      afterLoad: resolve,
    });
  });
  assert.equal(extras, 1);
  assert.equal(session.items.length, 2);
  assert.equal(session.busy, '');
});

test('watch reload runs npm extras when package.json changes', async () => {
  const gitItem = sampleItem('a.js');
  const cwd = tempDir('reslop-watch-');
  const pkg = path.join(cwd, 'package.json');
  fs.writeFileSync(pkg, '{}\n');
  let extras = 0;
  const { session } = openWatched([gitItem], {
    cwd,
    audit: true,
    repo: {
      load: () => ({ top: cwd, items: [gitItem], branch: 'main' }),
      loadAsync: async (_dir, _paths, options = {}) => ({
        top: cwd,
        items: [gitItem],
        pending: options.deferExtras === true,
      }),
      loadExtras: async () => {
        extras += 1;
        return {
          top: cwd,
          items: [gitItem],
          pending: false,
          auditMap: { lodash: extras },
          outdatedMap: null,
        };
      },
    },
  });
  session.uiOpen = true;
  session.loader.didLoad = false;
  await session.openLoad();
  assert.equal(extras, 1);
  fs.writeFileSync(pkg, '{"name":"demo"}\n');
  await new Promise((resolve) => {
    session.refreshFromRepo({
      keepView: true,
      quiet: true,
      afterLoad: resolve,
    });
  });
  assert.equal(extras, 2);
});

const npmReloadRepo = (cwd, gitItem, extras) => ({
  load: () => ({ top: cwd, items: [gitItem], branch: 'main' }),
  loadAsync: async (_dir, _paths, options = {}) => ({
    top: cwd,
    items: [gitItem],
    pending: options.deferExtras === true,
  }),
  loadExtras: async () => {
    extras.count += 1;
    return {
      top: cwd,
      items: [gitItem],
      pending: false,
      auditMap: { lodash: extras.count },
      outdatedMap: null,
    };
  },
});

test('source reload skips npm extras when packages are unchanged', async () => {
  const gitItem = sampleItem('a.js');
  const cwd = tempDir('reslop-watch-');
  fs.writeFileSync(path.join(cwd, 'package.json'), '{}\n');
  const extras = { count: 0 };
  const { session } = openWatched([gitItem], {
    cwd,
    audit: true,
    repo: npmReloadRepo(cwd, gitItem, extras),
  });
  session.uiOpen = true;
  session.loader.didLoad = false;
  await session.openLoad();
  assert.equal(extras.count, 1);
  await new Promise((resolve) => {
    session.reloadAfterChange(resolve);
  });
  await waitUntil(() => session.busy === '');
  assert.equal(extras.count, 1);
  await new Promise((resolve) => {
    session.refreshFromRepo({ afterLoad: resolve });
  });
  await waitUntil(() => session.busy === '');
  assert.equal(extras.count, 1);
});

test('nested package.json reload runs npm extras', async () => {
  const rel = 'packages/app/package.json';
  const gitItem = sampleItem(rel);
  const cwd = tempDir('reslop-watch-');
  const pkg = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(pkg), { recursive: true });
  fs.writeFileSync(pkg, '{}\n');
  const extras = { count: 0 };
  const { session } = openWatched([gitItem], {
    cwd,
    audit: true,
    repo: npmReloadRepo(cwd, gitItem, extras),
  });
  session.uiOpen = true;
  session.loader.didLoad = false;
  await session.openLoad();
  assert.equal(extras.count, 1);
  fs.writeFileSync(pkg, '{"name":"app"}\n');
  await new Promise((resolve) => {
    session.reloadAfterChange(resolve);
  });
  await waitUntil(() => session.busy === '');
  assert.equal(extras.count, 2);
});
