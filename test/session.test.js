'use strict';

const nodeTest = require('node:test');
const { test } = nodeTest;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const session = require('../lib/session.js');
const { Session } = session;
const ops = require('../lib/session/ops.js');
const { createOpsRunner } = ops;
const keys = require('../lib/keys.js');
const { hitAction } = keys;
const helpers = require('./helpers.js');
const { uiSink, sampleHunk, tempDir } = helpers;
const review = require('../lib/review.js');
const { createStore, addTodo, serializeReview } = review;
const { parseReview } = review;
const ansi = require('../lib/ansi.js');
const { stripAnsi, THEME, BOLD, seq } = ansi;
const npm = require('../lib/render/npm.js');
const { logViewRows } = npm;
const { setTheme, themeName } = ansi;
const files = require('../lib/files.js');
const { REVIEW_DIR } = files;

const pad2 = (n) => `${n}`.padStart(2, '0');

const dateStamp = (date = new Date()) => {
  const y = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  return `${y}-${month}-${day}`;
};

const sampleItem = (name, origin = 'unstaged') => ({
  origin,
  file: {
    oldPath: name,
    newPath: name,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    preamble: [`diff --git a/${name} b/${name}`],
    hunks: [],
  },
  hunk: sampleHunk([
    { type: 'del', text: 'a', noNl: false, blockId: 0 },
    { type: 'add', text: 'b', noNl: false, blockId: 0 },
  ]),
  blockId: 0,
  patchAdd: 'add',
  patchRevert: 'rev',
});

const tallItem = (name, count) => {
  const item = sampleItem(name);
  const lines = [];
  for (let i = 0; i < count; i++) {
    lines.push({ type: 'add', text: `line${i}`, noNl: false, blockId: 0 });
  }
  const hunk = { ...item.hunk, lines, oldCount: 0, newCount: count };
  return { ...item, hunk };
};

const hunkPair = (name) => {
  const file = {
    oldPath: name,
    newPath: name,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    preamble: [`diff --git a/${name} b/${name}`],
    hunks: [],
  };
  const hunk = {
    oldStart: 1,
    oldCount: 3,
    newStart: 1,
    newCount: 3,
    header: '@@ -1,3 +1,3 @@',
    lines: [
      { type: 'del', text: 'a', noNl: false, blockId: 0 },
      { type: 'add', text: 'A', noNl: false, blockId: 0 },
      { type: 'ctx', text: 'mid', noNl: false, blockId: null },
      { type: 'del', text: 'c', noNl: false, blockId: 1 },
      { type: 'add', text: 'C', noNl: false, blockId: 1 },
    ],
  };
  const first = {
    origin: 'unstaged',
    file,
    hunk,
    blockId: 0,
    patchAdd: 'add0',
    patchRevert: 'rev0',
  };
  const second = {
    origin: 'unstaged',
    file,
    hunk,
    blockId: 1,
    patchAdd: 'add1',
    patchRevert: 'rev1',
  };
  return [first, second];
};

const mockRepo = (initial, top) => {
  let items = [...initial];
  const added = [];
  const reverted = [];
  const unstageCalls = [];
  const commits = [];
  const commitDrops = [];
  const applyFixups = [];
  const rewords = [];
  const pulls = [];
  const pushes = [];
  const checkouts = [];
  const created = [];
  const rebases = [];
  const drops = [];
  const edited = [];
  const listed = [];
  const writes = [];
  const stagedPaths = [];
  const fileBodies = Object.create(null);
  const extraFiles = [];
  let commitList = [
    {
      sha: 'aaa1111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      shortSha: 'aaa1111',
      author: 'Ada',
      date: '2 hours ago',
      subject: 'land the change',
    },
    {
      sha: 'bbb2222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      shortSha: 'bbb2222',
      author: 'Bob',
      date: 'yesterday',
      subject: 'init',
    },
  ];
  return {
    added,
    reverted,
    unstageCalls,
    commits,
    pulls,
    pushes,
    checkouts,
    created,
    rebases,
    drops,
    edited,
    listed,
    writes,
    stagedPaths,
    fileBodies,
    extraFiles,
    commitDrops,
    applyFixups,
    rewords,
    load: () => ({ top, items: [...items], branch: 'main' }),
    add: (top, item) => {
      added.push(item);
      items = items.filter((entry) => entry !== item);
    },
    unstage: (top, item) => {
      unstageCalls.push(item);
      items = items.filter((entry) => entry !== item);
    },
    revert: (top, item) => {
      reverted.push(item);
      items = items.filter((entry) => entry !== item);
    },
    revertFile: (top, rel, group) => {
      const targets = group && group.length ? group : [];
      for (const item of targets) {
        reverted.push(item);
        items = items.filter((entry) => entry !== item);
      }
    },
    commit: (top, kind, message) => {
      commits.push({ top, kind, message });
    },
    lastMessage: () => 'previous message',
    listBranches: () => {
      listed.push(true);
      return [
        { name: 'main', current: true },
        { name: 'feat', current: false },
      ];
    },
    checkout: (top, name) => checkouts.push(name),
    createBranch: (top, name) => created.push(name),
    rebase: (top, onto) => rebases.push(onto),
    drop: (top, name) => drops.push(name),
    listCommits: () =>
      commitList.map((entry, index) => ({ ...entry, head: index === 0 })),
    dropCommit: (top, sha) => {
      commitDrops.push(sha);
      commitList = commitList.filter((entry) => entry.sha !== sha);
    },
    applyFixup: (top, sha) => {
      applyFixups.push(sha);
      commitList = commitList.filter((entry) => entry.sha !== sha);
    },
    commitMessage: (top, sha) => {
      const entry = commitList.find((item) => item.sha === sha);
      if (entry && entry.subject) return entry.subject;
      return 'previous message';
    },
    reword: (top, sha, message) => {
      rewords.push({ sha, message });
      commitList = commitList.map((entry) => {
        if (entry.sha !== sha) return entry;
        const subject = `${message}`.split('\n')[0];
        return { ...entry, subject };
      });
    },
    setCommits: (next) => {
      commitList = next;
    },
    pull: () => pulls.push(true),
    push: () => pushes.push(true),
    edit: (top, item, text) => {
      edited.push({ top, item, text });
    },
    listFiles: () => {
      const names = new Set(extraFiles);
      for (const item of items) names.add(item.file.newPath);
      return [...names].sort();
    },
    fileText: (top, rel) => {
      if (Object.hasOwn(fileBodies, rel)) return fileBodies[rel];
      return 'b\n';
    },
    writeFile: (top, rel, text) => {
      fileBodies[rel] = text;
      writes.push({ top, rel, text });
    },
    stagePath: (top, rel) => {
      stagedPaths.push(rel);
    },
  };
};

const openSession = (items, extra = {}) => {
  const stdout = extra.stdout ?? uiSink();
  const cwd = extra.cwd ?? tempDir('reslop-ui-');
  const repo = extra.repo ?? mockRepo(items, cwd);
  const session = new Session({
    color: false,
    startPane: 'diff',
    ...extra,
    cwd,
    stdout,
    repo,
  });
  session.load();
  return { session, repo, stdout, cwd };
};

const clickStatusChoice = (session, id) => {
  session.draw();
  const hit = session.lastFrame.statusHits.find((entry) => entry.id === id);
  assert.ok(hit);
  session.handleEvent({
    type: 'mouse',
    button: 0,
    btn: 0,
    kind: 'press',
    x: hit.x0 + 1,
    y: hit.y,
    press: true,
  });
  session.handleEvent({
    type: 'mouse',
    button: 0,
    btn: 0,
    kind: 'release',
    x: hit.x0 + 1,
    y: hit.y,
    press: false,
  });
};

const clickFooter = (session, id) => {
  session.draw();
  const hit = session.lastFrame.buttons.find((entry) => entry.id === id);
  assert.ok(hit);
  const y = session.lastFrame.height;
  session.handleEvent({
    type: 'mouse',
    button: 0,
    btn: 0,
    kind: 'press',
    x: hit.x0 + 1,
    y,
    press: true,
  });
  session.handleEvent({
    type: 'mouse',
    button: 0,
    btn: 0,
    kind: 'release',
    x: hit.x0 + 1,
    y,
    press: false,
  });
};

test('prev at first block opens todos and next reaches last', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const c = sampleItem('c.js');
  const { session } = openSession([a, b, c]);
  session.dispatch('prev');
  assert.equal(session.current().origin, 'todo');
  session.dispatch('next');
  assert.equal(session.current().file.newPath, 'a.js');
  session.dispatch('next');
  assert.equal(session.current().file.newPath, 'b.js');
  session.dispatch('next');
  assert.equal(session.current().file.newPath, 'c.js');
  session.dispatch('next');
  assert.equal(session.current().file.newPath, 'c.js');
});

test('AC8 add on staged is a no-op', () => {
  const item = sampleItem('s.js', 'staged');
  const { session, repo } = openSession([item]);
  session.dispatch('add');
  assert.equal(session.status, '');
  assert.equal(repo.added.length, 0);
  assert.equal(session.items.length, 1);
  assert.equal(session.items[0].origin, 'staged');
});

test('diff screen dims a on staged and u on unstaged', () => {
  const stagedItem = sampleItem('s.js', 'staged');
  const staged = openSession([stagedItem], { color: true });
  staged.session.draw();
  const stagedRow = staged.session.lastFrame.rows.at(-1);
  const rest = seq(THEME.buttonFg, THEME.buttonBg);
  const hot = seq(THEME.buttonHotFg, THEME.buttonBg);
  const stagedHits = staged.session.lastFrame.buttons;
  assert.equal(
    stagedHits.find((hit) => hit.id === 'add'),
    undefined,
  );
  assert.ok(stagedHits.find((hit) => hit.id === 'unstage'));
  assert.ok(stagedRow.includes(`${rest}add`));
  assert.ok(!stagedRow.includes(`${BOLD}${hot}a`));
  assert.ok(stagedRow.includes(`${BOLD}${hot}u`));
  staged.session.handleEvent({ type: 'key', key: 'a' });
  assert.equal(staged.repo.added.length, 0);
  assert.equal(staged.session.status, '');

  const unstaged = openSession([sampleItem('u.js')], { color: true });
  unstaged.session.draw();
  const unstagedRow = unstaged.session.lastFrame.rows.at(-1);
  assert.ok(unstaged.session.lastFrame.buttons.find((hit) => hit.id === 'add'));
  assert.equal(
    unstaged.session.lastFrame.buttons.find((hit) => hit.id === 'unstage'),
    undefined,
  );
  assert.ok(unstagedRow.includes(`${BOLD}${hot}a`));
  assert.ok(unstagedRow.includes(`${rest}unstage`));
  unstaged.session.handleEvent({ type: 'key', key: 'u' });
  assert.equal(unstaged.repo.unstageCalls.length, 0);
  assert.equal(unstaged.session.status, '');
});

test('add and unstage keep block order', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const c = sampleItem('c.js');
  const { session, repo } = openSession([a, b, c]);
  let loads = 0;
  const inner = repo.load;
  repo.load = () => {
    loads += 1;
    return inner();
  };
  session.index = 1;
  session.dispatch('add');
  assert.equal(loads, 0);
  assert.equal(repo.added.length, 1);
  assert.deepEqual(
    session.items.map((item) => item.file.newPath),
    ['a.js', 'b.js', 'c.js'],
  );
  assert.equal(session.items[1].origin, 'staged');
  assert.equal(session.current().file.newPath, 'b.js');
  const stagedFirst = [session.items[1], session.items[0], session.items[2]];
  repo.load = () => ({ top: '/tmp', items: stagedFirst, branch: 'main' });
  session.refreshFromRepo({ keepView: true });
  assert.deepEqual(
    session.items.map((item) => item.file.newPath),
    ['a.js', 'b.js', 'c.js'],
  );
  assert.equal(session.items[1].origin, 'staged');
  assert.equal(session.current().file.newPath, 'b.js');
  session.dispatch('unstage');
  assert.equal(loads, 0);
  assert.equal(session.items[1].origin, 'unstaged');
  assert.deepEqual(
    session.items.map((item) => item.file.newPath),
    ['a.js', 'b.js', 'c.js'],
  );
});

test('AC28 unstage drops index keeps worktree', () => {
  const staged = sampleItem('s.js', 'staged');
  const other = sampleItem('a.js');
  const { session, repo } = openSession([staged, other]);
  session.dispatch('unstage');
  assert.equal(repo.unstageCalls.length, 1);
  assert.equal(session.status, 'unstaged');
});

test('AC28 unstage on unstaged is a no-op', () => {
  const item = sampleItem('a.js');
  const { session, repo } = openSession([item]);
  session.dispatch('unstage');
  assert.equal(session.status, '');
  assert.equal(repo.unstageCalls.length, 0);
  assert.equal(session.items.length, 1);
});

test('AC21 commit add and revert are read only', () => {
  const item = sampleItem('c.js', 'commit');
  const { session, repo } = openSession([item]);
  session.revShort = '7ac260c';
  session.dispatch('add');
  assert.equal(session.status, 'read only');
  assert.equal(repo.added.length, 0);
  session.dispatch('revert');
  assert.equal(session.status, 'read only');
  assert.equal(repo.reverted.length, 0);
  session.dispatch('unstage');
  assert.equal(session.status, 'read only');
  assert.equal(repo.unstageCalls.length, 0);
  session.dispatch('commit');
  assert.equal(session.status, 'read only');
  assert.equal(repo.commits.length, 0);
  const files = session.fileList();
  assert.equal(files[0].kind, 'todos');
  assert.equal(files[1].status, '7ac260c');
  session.dispatch('next');
  assert.equal(session.status, 'read only');
  assert.equal(repo.added.length, 0);
});

test('PR add and revert are read only and feedback attaches', () => {
  const item = sampleItem('lib/a.js', 'pr');
  const { session, repo } = openSession([item], {
    sourceLabel: '#12',
    change: {
      source: 'pr',
      repository: 'acme/app',
      title: 'Fix',
      author: 'alice',
      number: 12,
    },
    repoName: 'acme/app',
  });
  session.dispatch('add');
  assert.equal(session.status, 'read only');
  assert.equal(repo.added.length, 0);
  session.dispatch('revert');
  assert.equal(session.status, 'read only');
  assert.equal(repo.reverted.length, 0);
  session.dispatch('unstage');
  assert.equal(session.status, 'read only');
  session.dispatch('commit');
  assert.equal(session.status, 'read only');
  assert.equal(repo.commits.length, 0);
  const files = session.fileList();
  assert.equal(files[0].kind, 'todos');
  assert.equal(files[1].status, '#12');
  session.dispatch('feedback');
  session.pushInput('prefer const');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  const note = session.notes.feedback.get('lib/a.js:1:1:0');
  assert.equal(note.text, 'prefer const');
  assert.equal(session.counts().pr, 1);
  assert.equal(session.counts().feedback, 1);
  session.dispatch('next');
  assert.equal(session.status, 'saved');
  session.dispatch('prev');
  assert.equal(session.current().origin, 'todo');
  session.dispatch('next');
  assert.equal(session.current().file.newPath, 'lib/a.js');
  const view = session.view();
  assert.equal(view.sourceKind, 'pr');
  assert.equal(view.sourceLabel, '#12');
  assert.equal(view.repoName, 'acme/app');
});

test('MR add and revert are read only and feedback attaches', () => {
  const item = sampleItem('lib/a.js', 'pr');
  const { session, repo } = openSession([item], {
    sourceLabel: '!12',
    change: {
      source: 'mr',
      repository: 'acme/app',
      title: 'Fix',
      author: 'alice',
      number: 12,
    },
    repoName: 'acme/app',
  });
  session.dispatch('add');
  assert.equal(session.status, 'read only');
  assert.equal(repo.added.length, 0);
  session.dispatch('revert');
  assert.equal(session.status, 'read only');
  const files = session.fileList();
  assert.equal(files[0].kind, 'todos');
  assert.equal(files[1].status, '!12');
  const view = session.view();
  assert.equal(view.sourceKind, 'mr');
  assert.equal(view.sourceLabel, '!12');
  assert.equal(view.repoName, 'acme/app');
});

test('-r blocks add unstage revert and still takes feedback', () => {
  const item = sampleItem('a.js');
  const { session, repo } = openSession([item], { readOnly: true });
  session.dispatch('add');
  assert.equal(session.status, 'read only');
  assert.equal(repo.added.length, 0);
  session.dispatch('unstage');
  assert.equal(session.status, 'read only');
  assert.equal(repo.unstageCalls.length, 0);
  session.dispatch('revert');
  assert.equal(session.status, 'read only');
  assert.equal(repo.reverted.length, 0);
  session.dispatch('commit');
  assert.equal(session.status, 'read only');
  assert.equal(repo.commits.length, 0);
  session.pane = 'files';
  session.dispatch('add');
  assert.equal(session.status, 'read only');
  assert.equal(repo.added.length, 0);
  session.pane = 'diff';
  session.dispatch('feedback');
  session.pushInput('keep this');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  const note = session.notes.feedback.get('a.js:1:1:0');
  assert.equal(note.text, 'keep this');
});

test('AC9 hotkeys dispatch add revert next prev quit', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const c = sampleItem('c.js');
  const { session, repo } = openSession([a, b, c]);
  assert.equal(session.layout, 'unified');
  session.pushInput('n');
  assert.equal(session.current().file.newPath, 'b.js');
  session.pushInput('p');
  assert.equal(session.current().file.newPath, 'a.js');
  session.pushInput('a');
  assert.equal(repo.added.length, 1);
  assert.equal(repo.added[0].file.newPath, 'a.js');
  session.pushInput('d');
  assert.equal(repo.reverted.length, 1);
  session.pushInput('m');
  assert.equal(session.layout, 'mixed');
  assert.equal(session.status, 'mixed');
  session.pushInput('m');
  assert.equal(session.layout, 'side');
  assert.equal(session.status, 'side-by-side');
  session.pushInput('m');
  assert.equal(session.layout, 'unified');
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.pane, 'files');
  session.pushInput('q');
  assert.equal(session.done, true);
});

test('j and k move next and prev on the diff', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session } = openSession([a, b]);
  session.pushInput('j');
  assert.equal(session.current().file.newPath, 'b.js');
  session.pushInput('k');
  assert.equal(session.current().file.newPath, 'a.js');
  session.pushInput('k');
  assert.equal(session.current().origin, 'todo');
  session.pushInput('j');
  assert.equal(session.current().file.newPath, 'a.js');
});

test('j and k move the files cursor', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session } = openSession([a, b], { startPane: 'files' });
  assert.equal(session.fileCursor, 0);
  session.handleEvent({ type: 'key', key: 'right' });
  assert.equal(session.fileCursor, 0);
  session.handleEvent({ type: 'key', key: 'left' });
  assert.equal(session.fileCursor, 0);
  session.pushInput('j');
  assert.equal(session.fileCursor, 1);
  session.pushInput('k');
  assert.equal(session.fileCursor, 0);
  session.handleEvent({ type: 'key', key: 'down' });
  assert.equal(session.fileCursor, 1);
});

test('vim ctrl keys scroll the diff by line and page', () => {
  const { session } = openSession([tallItem('a.js', 80)]);
  session.draw();
  const page = session.lastFrame.bodyH;
  assert.ok(page > 1);
  session.handleEvent({ type: 'key', key: 'ctrl-e' });
  assert.equal(session.scroll, 1);
  session.handleEvent({ type: 'key', key: 'ctrl-y' });
  assert.equal(session.scroll, 0);
  session.handleEvent({ type: 'key', key: 'ctrl-f' });
  assert.equal(session.scroll, page);
  session.handleEvent({ type: 'key', key: 'ctrl-b' });
  assert.equal(session.scroll, 0);
  session.handleEvent({ type: 'key', key: 'ctrl-d' });
  assert.equal(session.scroll, Math.max(1, Math.floor(page * 0.5)));
  session.handleEvent({ type: 'key', key: 'ctrl-u' });
  assert.equal(session.scroll, 0);
  session.handleEvent({ type: 'key', key: 'pageDown' });
  assert.equal(session.scroll, page);
  session.handleEvent({ type: 'key', key: 'end' });
  assert.equal(session.scroll, session.lastFrame.scrollMax);
  session.handleEvent({ type: 'key', key: 'home' });
  assert.equal(session.scroll, 0);
  session.handleEvent({ type: 'key', key: 'pageUp' });
  assert.equal(session.scroll, 0);
});

test('diff up scrolls immediately after the last line', () => {
  const { session } = openSession([tallItem('a.js', 80)]);
  session.draw();
  const max = session.lastFrame.scrollMax;
  assert.ok(max > 1);
  for (let i = 0; i < max + 10; i++) session.dispatch('scrollDown');
  assert.equal(session.scroll, max);
  session.dispatch('scrollUp');
  assert.equal(session.scroll, max - 1);
});

test('vim ctrl-f pages down the files list', () => {
  const items = [];
  for (let i = 0; i < 20; i++) items.push(sampleItem(`f${i}.js`));
  const { session } = openSession(items, { startPane: 'files' });
  session.draw();
  const page = session.lastFrame.bodyH;
  assert.equal(session.fileCursor, 0);
  session.handleEvent({ type: 'key', key: 'ctrl-f' });
  assert.equal(session.fileCursor, page);
  session.handleEvent({ type: 'key', key: 'ctrl-b' });
  assert.equal(session.fileCursor, 0);
});

test('files list up moves the cursor before scrolling', () => {
  const items = [];
  for (let i = 0; i < 20; i++) items.push(sampleItem(`f${i}.js`));
  const { session } = openSession(items, { startPane: 'files' });
  const last = session.fileList().length - 1;
  for (let i = 0; i < last; i++) session.dispatch('next');
  session.draw();
  assert.equal(session.fileCursor, last);
  const markRow = (frame) => {
    for (let i = 0; i < frame.rows.length; i++) {
      if (stripAnsi(frame.rows[i]).includes('▶')) return i;
    }
    return -1;
  };
  const listNames = (frame) => {
    const names = [];
    for (const hit of frame.fileHits) {
      const match = /f\d+\.js/.exec(stripAnsi(frame.rows[hit.y - 1]));
      if (match) names.push(match[0]);
    }
    return names;
  };
  const bottom = session.lastFrame;
  const bottomMark = markRow(bottom);
  const bottomNames = listNames(bottom);
  assert.ok(bottomMark > 0);
  assert.ok(bottomNames.length > 1);
  session.dispatch('prev');
  session.draw();
  assert.equal(session.fileCursor, last - 1);
  assert.deepEqual(listNames(session.lastFrame), bottomNames);
  assert.equal(markRow(session.lastFrame), bottomMark - 1);
});

test('home end and page keys jump the files list', () => {
  const items = [];
  for (let i = 0; i < 20; i++) items.push(sampleItem(`f${i}.js`));
  const { session } = openSession(items, { startPane: 'files' });
  session.draw();
  const page = session.lastFrame.bodyH;
  const last = session.fileList().length - 1;
  session.handleEvent({ type: 'key', key: 'pageDown' });
  assert.equal(session.fileCursor, page);
  session.handleEvent({ type: 'key', key: 'pageUp' });
  assert.equal(session.fileCursor, 0);
  session.handleEvent({ type: 'key', key: 'end' });
  assert.equal(session.fileCursor, last);
  session.handleEvent({ type: 'key', key: 'home' });
  assert.equal(session.fileCursor, 0);
});

test('AC10 footer Add hitbox dispatches add', () => {
  const item = sampleItem('c.js');
  const { session, repo } = openSession([item]);
  session.draw();
  const hit = session.lastFrame.buttons.find((entry) => entry.id === 'add');
  assert.ok(hit);
  assert.equal(hitAction(session.lastFrame.buttons, hit.x0), 'add');
  session.handleEvent({
    type: 'mouse',
    button: 0,
    btn: 0,
    kind: 'press',
    x: hit.x0 + 1,
    y: session.lastFrame.height,
    press: true,
  });
  session.handleEvent({
    type: 'mouse',
    button: 0,
    btn: 0,
    kind: 'release',
    x: hit.x0 + 1,
    y: session.lastFrame.height,
    press: false,
  });
  assert.equal(repo.added.length, 1);
});

test('AC13 drag copies selected text', () => {
  const item = sampleItem('c.js');
  const { session, stdout } = openSession([item]);
  session.draw();
  session.handleEvent({
    type: 'mouse',
    kind: 'press',
    btn: 0,
    button: 0,
    x: 1,
    y: 3,
    press: true,
  });
  session.handleEvent({
    type: 'mouse',
    kind: 'drag',
    btn: 0,
    button: 32,
    x: 40,
    y: 5,
    press: true,
  });
  session.handleEvent({
    type: 'mouse',
    kind: 'release',
    btn: 0,
    button: 0,
    x: 40,
    y: 5,
    press: false,
  });
  assert.ok(stdout.dump().includes(']52;c;'));
  assert.equal(session.status, 'copied');
});

test('draw writes once for an unchanged frame', () => {
  const item = sampleItem('c.js');
  const { session, stdout } = openSession([item]);
  session.draw();
  const first = stdout.dump();
  session.draw();
  assert.equal(stdout.dump(), first);
  assert.ok(first.includes('[?2026h'));
  assert.ok(first.includes('[2J'));
  session.dispatch('layout');
  session.draw();
  const second = stdout.dump();
  assert.ok(second.length > first.length);
  const extra = second.slice(first.length);
  assert.ok(extra.includes('[?2026h'));
  assert.ok(!extra.includes('[2J'));
});

test('escape from diff opens the file list, then quits', () => {
  const { session } = openSession([sampleItem('a.js'), sampleItem('b.js')]);
  assert.equal(session.pane, 'diff');
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.pane, 'files');
  assert.equal(session.done, false);
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.done, true);
});

test('escape from files with notes asks to finish or continue', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.dispatch('feedback');
  session.pushInput('nits');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.pane, 'files');
  assert.equal(session.done, false);
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.done, false);
  assert.equal(session.mode, 'confirmQuit');
  session.pushInput('c');
  assert.equal(session.done, true);
  assert.equal(session.notes.status, 'editing');
});

test('starts on the file list', () => {
  const { session } = openSession([sampleItem('a.js')], { startPane: 'files' });
  assert.equal(session.pane, 'files');
  assert.equal(session.fileCursor, 0);
  assert.equal(session.fileList()[0].kind, 'todos');
  session.dispatch('open');
  assert.equal(session.pane, 'diff');
  assert.equal(session.current().origin, 'todo');
});

test('AC14 files pane lists paths and enter opens', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session, stdout } = openSession([a, b], { startPane: 'files' });
  assert.equal(session.pane, 'files');
  session.draw();
  const text = stdout.dump();
  assert.match(text, /: Project Backlog and Issues/);
  assert.ok(!text.includes('todo 1/3'));
  assert.ok(!text.includes('@@'));
  assert.match(text, /Project Backlog and Issues/);
  assert.match(text, /a\.js/);
  assert.match(text, /b\.js/);
  session.dispatch('scrollDown');
  assert.equal(session.fileCursor, 1);
  session.dispatch('open');
  assert.equal(session.pane, 'diff');
  assert.equal(session.current().file.newPath, 'a.js');
  session.dispatch('files');
  assert.equal(session.pane, 'files');
  assert.equal(session.fileCursor, 1);
});

test('enter on a partial file opens the first unstaged hunk', () => {
  const staged = sampleItem('a.js', 'staged');
  const unstaged = sampleItem('a.js');
  unstaged.blockId = 1;
  const { session } = openSession([staged, unstaged], { startPane: 'files' });
  session.dispatch('next');
  session.dispatch('open');
  assert.equal(session.pane, 'diff');
  assert.equal(session.current().origin, 'unstaged');
  assert.equal(session.index, 1);
});

test('files pane add moves to the next file', () => {
  const { session } = openSession(
    [sampleItem('a.js'), sampleItem('b.js'), sampleItem('c.js')],
    { startPane: 'files' },
  );
  session.dispatch('next');
  session.dispatch('add');
  assert.equal(session.fileCursor, 2);
  assert.equal(session.fileList()[2].path, 'b.js');
  assert.equal(session.items[0].origin, 'staged');
  session.dispatch('prev');
  session.dispatch('unstage');
  assert.equal(session.fileCursor, 2);
  assert.equal(session.items[0].origin, 'unstaged');
});

test('files pane add on last file keeps the cursor', () => {
  const { session } = openSession(
    [sampleItem('a.js'), sampleItem('b.js'), sampleItem('c.js')],
    { startPane: 'files' },
  );
  session.dispatch('next');
  session.dispatch('next');
  session.dispatch('next');
  assert.equal(session.fileCursor, 3);
  session.reviewPath = 'a.js';
  session.dispatch('add');
  assert.equal(session.fileCursor, 3);
  assert.equal(session.fileList()[3].path, 'c.js');
  assert.equal(session.items[2].origin, 'staged');
  session.dispatch('unstage');
  assert.equal(session.fileCursor, 3);
  assert.equal(session.items[2].origin, 'unstaged');
});

test('files pane add unstage revert apply to the whole file', () => {
  const first = sampleItem('a.js');
  const second = sampleItem('a.js');
  second.blockId = 1;
  second.hunk = {
    ...second.hunk,
    oldStart: 10,
    newStart: 10,
    header: '@@ -10,1 +10,1 @@',
    blockId: 1,
  };
  const other = sampleItem('b.js');
  const { session, repo } = openSession([first, second, other], {
    startPane: 'files',
  });
  session.dispatch('next');
  session.dispatch('add');
  assert.equal(repo.added.length, 2);
  assert.equal(repo.added[0].file.newPath, 'a.js');
  assert.equal(repo.added[1].file.newPath, 'a.js');
  assert.equal(session.items[0].origin, 'staged');
  assert.equal(session.items[1].origin, 'staged');
  assert.equal(session.items[2].origin, 'unstaged');
  assert.equal(session.fileCursor, 2);
  session.dispatch('prev');
  session.dispatch('unstage');
  assert.equal(repo.unstageCalls.length, 2);
  assert.equal(session.items[0].origin, 'unstaged');
  assert.equal(session.items[1].origin, 'unstaged');
  assert.equal(session.fileCursor, 2);
  session.dispatch('prev');
  session.dispatch('revert');
  assert.equal(repo.reverted.length, 2);
  assert.equal(repo.reverted[0].file.newPath, 'a.js');
  assert.equal(repo.reverted[1].file.newPath, 'a.js');
  assert.equal(session.fileCursor, 1);
  assert.equal(session.fileList()[1].path, 'b.js');
});

test('files pane disables mode and feedback', () => {
  const { session } = openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.dispatch('layout');
  assert.equal(session.layout, 'unified');
  assert.equal(session.status, '');
  session.dispatch('feedback');
  assert.equal(session.mode, 'review');
  assert.equal(session.pane, 'files');
  session.dispatch('code');
  assert.equal(session.mode, 'review');
  assert.equal(session.notes.code.size, 0);
});

test('files pane todos row ignores add unstage drop', () => {
  const { session } = openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  assert.equal(session.fileCursor, 0);
  assert.equal(session.fileList()[0].kind, 'todos');
  session.dispatch('add');
  session.dispatch('unstage');
  session.dispatch('revert');
  assert.equal(session.status, '');
  assert.equal(session.pane, 'files');
  assert.equal(session.fileCursor, 0);
  session.dispatch('next');
  session.dispatch('add');
  assert.equal(session.status, 'staged');
});

test('reload picks up disk changes and keeps the current hunk', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const c = sampleItem('c.js');
  const { session, repo } = openSession([a, b]);
  session.dispatch('next');
  assert.equal(session.current().file.newPath, 'b.js');
  session.notes.feedback.set('b.js:1:1:0', {
    file: 'b.js',
    oldStart: 1,
    newStart: 1,
    blockId: 0,
    text: 'keep me',
  });
  repo.load = () => ({ top: '/tmp', items: [a, b, c] });
  session.dispatch('reload');
  assert.equal(session.status, 'reloaded');
  assert.equal(session.pane, 'diff');
  assert.equal(session.current().file.newPath, 'b.js');
  assert.equal(session.items.length, 3);
  assert.equal(session.notes.feedback.get('b.js:1:1:0').text, 'keep me');
});

test('reload brings back dismissed hunks', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session } = openSession([a, b], { startPane: 'files' });
  session.dismissed.add('unstaged:a.js:1:1:0');
  session.items = session.items.filter((item) => item.file.newPath !== 'a.js');
  session.index = 0;
  assert.equal(session.current().file.newPath, 'b.js');
  session.dispatch('reload');
  assert.equal(session.status, 'reloaded');
  assert.equal(session.dismissed.size, 0);
  assert.equal(session.items.length, 2);
  assert.equal(session.current().file.newPath, 'b.js');
});

test('reload from the file list still refreshes', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session, repo } = openSession([a], { startPane: 'files' });
  repo.load = () => ({ top: '/tmp', items: [a, b] });
  session.dispatch('reload');
  assert.equal(session.status, 'reloaded');
  assert.equal(session.pane, 'files');
  assert.equal(session.items.length, 2);
});

test('compose r inserts a letter and does not reload', () => {
  const a = sampleItem('a.js');
  const { session, repo } = openSession([a]);
  let loads = 0;
  const orig = repo.load;
  repo.load = (...args) => {
    loads += 1;
    return orig(...args);
  };
  session.dispatch('feedback');
  session.handleEvent({ type: 'key', key: 'r' });
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'r');
  assert.equal(loads, 0);
});

test('files pane add on a staged file still moves down', () => {
  const item = sampleItem('a.js', 'staged');
  const next = sampleItem('b.js');
  const { session, repo } = openSession([item, next], { startPane: 'files' });
  session.dispatch('next');
  session.dispatch('add');
  assert.equal(session.status, 'already staged');
  assert.equal(repo.added.length, 0);
  assert.equal(session.fileCursor, 2);
  assert.equal(session.fileList()[2].path, 'b.js');
});

test('files pane unstage on an unstaged file still moves down', () => {
  const { session, repo } = openSession(
    [sampleItem('a.js'), sampleItem('b.js')],
    { startPane: 'files' },
  );
  session.dispatch('next');
  session.dispatch('unstage');
  assert.equal(session.status, 'not staged');
  assert.equal(repo.unstageCalls.length, 0);
  assert.equal(session.fileCursor, 2);
  assert.equal(session.fileList()[2].path, 'b.js');
});

test('f maps feedback to the hunk location', () => {
  const item = sampleItem('a.js');
  const { session } = openSession([item]);
  session.dispatch('feedback');
  assert.equal(session.mode, 'compose');
  assert.equal(session.composeKind, 'feedback');
  session.pushInput('extract helper');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  assert.equal(session.mode, 'review');
  const note = session.notes.feedback.get('a.js:1:1:0');
  assert.equal(note.text, 'extract helper');
  assert.equal(note.file, 'a.js');
  assert.equal(note.newStart, 1);
  assert.equal(session.counts().feedback, 1);
  assert.equal(session.counts().todo, 0);
  assert.equal(session.idleNoteText(), '[ ] extract helper');
});

test('compose arrows move by visual wrap rows', () => {
  const stdout = uiSink();
  stdout.columns = 10;
  const { session } = openSession([sampleItem('a.js')], { stdout });
  session.dispatch('feedback');
  session.pushInput('hello world');
  session.handleEvent({ type: 'key', key: 'up' });
  assert.equal(session.editor.cursor, 5);
  session.handleEvent({ type: 'key', key: 'down' });
  assert.equal(session.editor.cursor, 11);
});

test('compose cursor blinks by hiding and showing', () => {
  const item = sampleItem('a.js');
  const { session, stdout } = openSession([item]);
  session.dispatch('feedback');
  session.draw();
  const on = stdout.dump();
  assert.ok(on.includes('[1 q'));
  assert.ok(on.includes('[?12h'));
  assert.ok(on.includes('[?25h'));
  session.tickBlink();
  const hidden = stdout.dump().slice(on.length);
  assert.ok(hidden.includes('[?25l'));
  assert.ok(!hidden.includes('[?2026h'));
  session.tickBlink();
  const shown = stdout.dump().slice(on.length + hidden.length);
  assert.ok(shown.includes('[?25h'));
  assert.ok(!shown.includes('[?2026h'));
});

test('enter and escape save feedback and return to browse', () => {
  const item = sampleItem('a.js');
  const { session } = openSession([item]);
  session.dispatch('feedback');
  session.pushInput('note');
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.mode, 'review');
  assert.equal(session.done, false);
  const key = 'a.js:1:1:0';
  assert.equal(session.notes.feedback.get(key).text, 'note');
  session.dispatch('feedback');
  session.pushInput(' two');
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.mode, 'review');
  assert.equal(session.done, false);
  assert.equal(session.notes.feedback.get(key).text, 'note two');
  assert.equal(session.status, 'saved');
});

test('editing feedback keeps one latest version', () => {
  const item = sampleItem('a.js');
  const { session } = openSession([item]);
  session.dispatch('feedback');
  session.pushInput('first');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  session.dispatch('feedback');
  session.pushInput(' more');
  session.autosave();
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  const key = 'a.js:1:1:0';
  assert.equal(session.notes.feedback.size, 1);
  assert.equal(session.notes.feedback.get(key).text, 'first more');
  session.dispatch('feedback');
  assert.equal(session.editor.text, 'first more');
  const view = session.view();
  assert.equal(view.compose.text, 'first more');
  assert.ok(!view.compose.text.includes('\n1 '));
});

test('feedback templates count reuse on another hunk not a re-save', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session } = openSession([a, b]);
  session.dispatch('feedback');
  session.pushInput('extract helper');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  session.dispatch('feedback');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  assert.equal(session.notes.templates.length, 1);
  assert.equal(session.notes.templates[0].count, 1);
  session.dispatch('next');
  session.dispatch('feedback');
  session.pushInput('extract helper');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  assert.equal(session.notes.templates.length, 1);
  assert.equal(session.notes.templates[0].text, 'extract helper');
  assert.equal(session.notes.templates[0].count, 2);
});

test('feedback templates are picked with tab arrows enter and click', () => {
  const { session } = openSession([sampleItem('a.js'), sampleItem('b.js')]);
  session.notes.templates = [
    { text: 'extract helper', count: 2 },
    { text: 'add tests', count: 1 },
  ];
  const feedKey = 'a.js:1:1:0';
  session.dispatch('feedback');
  assert.equal(session.mode, 'compose');
  session.draw();
  const body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /extract helper/);
  assert.match(body, /add tests/);
  session.handleEvent({ type: 'key', key: 'tab' });
  assert.equal(session.mode, 'review');
  assert.equal(session.notes.feedback.get(feedKey).text, 'extract helper');
  session.dispatch('feedback');
  session.editor.replace('');
  session.handleEvent({ type: 'key', key: 'down' });
  assert.equal(session.mode, 'compose');
  assert.equal(session.templateFocus, true);
  assert.equal(session.templateIndex, 0);
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.mode, 'review');
  assert.equal(session.notes.feedback.get(feedKey).text, 'extract helper');
  session.dispatch('feedback');
  session.editor.replace('');
  session.draw();
  const hit = session.lastFrame.templateHits.find((row) => row.cursor === 1);
  assert.ok(hit);
  session.handleEvent({
    type: 'mouse',
    kind: 'press',
    btn: 0,
    button: 0,
    x: 2,
    y: hit.y,
    press: true,
  });
  session.handleEvent({
    type: 'mouse',
    kind: 'release',
    btn: 0,
    button: 0,
    x: 2,
    y: hit.y,
    press: false,
  });
  assert.equal(session.mode, 'review');
  assert.equal(session.notes.feedback.get(feedKey).text, 'add tests');
});

test('feedback templates filter by prefix and hide if none match', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.notes.templates = [
    { text: 'extract helper', count: 2 },
    { text: 'add tests', count: 1 },
  ];
  session.dispatch('feedback');
  session.draw();
  let body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /extract helper/);
  assert.match(body, /add tests/);
  session.pushInput('ex');
  session.draw();
  body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /extract helper/);
  assert.ok(!body.includes('add tests'));
  assert.equal(session.lastFrame.templateHits.length, 1);
  session.handleEvent({ type: 'key', key: 'tab' });
  assert.equal(session.mode, 'review');
  assert.equal(session.notes.feedback.get('a.js:1:1:0').text, 'extract helper');
  session.dispatch('feedback');
  session.draw();
  body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /extract helper/);
  assert.ok(!body.includes('add tests'));
  assert.equal(session.lastFrame.templateHits.length, 0);
  session.editor.replace('');
  session.pushInput('z');
  session.draw();
  body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.ok(!body.includes('extract helper'));
  assert.ok(!body.includes('add tests'));
  assert.equal(session.lastFrame.templateHits.length, 0);
  session.handleEvent({ type: 'key', key: 'tab' });
  assert.equal(session.editor.text, 'z');
  session.handleEvent({ type: 'key', key: 'backspace' });
  session.draw();
  body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /extract helper/);
  assert.match(body, /add tests/);
});

test('exact template text hides the template list', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.notes.templates = [
    { text: 'extract helper', count: 2 },
    { text: 'add tests', count: 1 },
  ];
  session.dispatch('feedback');
  session.pushInput('extract helper');
  session.draw();
  const body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /extract helper/);
  assert.ok(!body.includes('add tests'));
  assert.equal(session.lastFrame.templateHits.length, 0);
  assert.deepEqual(session.shownTemplates(), []);
});

test('existing unique feedback hides the template list', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.notes.templates = [
    { text: 'extract helper', count: 2 },
    { text: 'add tests', count: 1 },
  ];
  session.notes.feedback.set('a.js:1:1:0', {
    file: 'a.js',
    oldStart: 1,
    newStart: 1,
    blockId: 0,
    text: 'unique note',
  });
  session.dispatch('feedback');
  session.draw();
  const body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /unique note/);
  assert.ok(!body.includes('extract helper'));
  assert.ok(!body.includes('add tests'));
  assert.equal(session.lastFrame.templateHits.length, 0);
});

test('e edits added lines in the reviewed file', () => {
  const item = sampleItem('a.js');
  const { session, repo } = openSession([item]);
  session.pushInput('e');
  assert.equal(session.mode, 'compose');
  assert.equal(session.composeKind, 'code');
  assert.equal(session.editor.text, 'b');
  assert.equal(session.view().compose, null);
  session.draw();
  const body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /\+ b/);
  assert.ok(session.lastFrame.cursor);
  assert.equal(session.lastFrame.cursor.x, 4);
  session.pushInput('2');
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'b2\n');
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.mode, 'review');
  assert.equal(session.notes.code.size, 0);
  assert.equal(session.counts().code, 0);
  assert.equal(repo.edited.length, 1);
  assert.equal(repo.edited[0].text, 'b2\n');
  assert.equal(repo.edited[0].item.file.newPath, 'a.js');
  assert.deepEqual(repo.stagedPaths, ['a.js']);
});

test('e on a read-only commit keeps a code proposal', () => {
  const item = sampleItem('a.js', 'commit');
  const { session, repo } = openSession([item], { rev: 'abc1234' });
  session.pushInput('e');
  session.pushInput('2');
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(repo.edited.length, 0);
  const note = session.notes.code.get('a.js:1:1:0');
  assert.equal(note.text, 'b2');
  assert.equal(session.counts().code, 1);
});

test('code save equal to original drops the proposal', () => {
  const item = sampleItem('a.js');
  const { session, repo } = openSession([item]);
  session.dispatch('code');
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.notes.code.size, 0);
  assert.equal(session.counts().code, 0);
  assert.equal(repo.stagedPaths.length, 0);
});

test('todos screen ignores commit and todo hotkeys', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.dispatch('todo');
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.todoOpen, true);
  assert.equal(session.mode, 'review');
  session.dispatch('commit');
  assert.equal(session.mode, 'review');
  session.dispatch('todo');
  assert.equal(session.mode, 'review');
});

test('todo list scrolls the focused row into view', () => {
  const { session, stdout } = openSession([sampleItem('a.js')]);
  stdout.rows = 12;
  for (let i = 0; i < 30; i++) addTodo(session.notes, 'a.js', `item ${i}`);
  session.composer.openTodoPage();
  session.todoFocus = 0;
  session.draw();
  const top = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(top, /item 0(?!\d)/);
  assert.ok(!/item 29(?!\d)/.test(top));
  assert.equal(session.scroll, 0);
  for (let i = 0; i < 25; i++) session.dispatch('scrollDown');
  session.draw();
  const down = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(down, /item 25(?!\d)/);
  assert.ok(!/item 0(?!\d)/.test(down));
  assert.ok(session.scroll > 0);
  session.handleEvent({
    type: 'mouse',
    kind: 'wheelUp',
    button: 64,
    x: 2,
    y: 4,
    press: true,
  });
  session.draw();
  const up = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.equal(session.todoFocus, 24);
  assert.match(up, /item 24(?!\d)/);
  session.dispatch('pageDown');
  session.draw();
  const paged = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.equal(session.todoFocus, 30);
  assert.match(paged, /item 29(?!\d)/);
  assert.ok(!/item 0(?!\d)/.test(paged));
});

test('todo edits in the list not the note line', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.dispatch('todo');
  session.pushInput('in the list');
  session.draw();
  const body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /\[ \] in the list/);
  assert.equal(body.split('in the list').length - 1, 1);
  assert.equal(session.view().compose, null);
  assert.ok(session.view().todoEdit);
  const hit = session.lastFrame.todoHits.find((row) => row.cursor === 0);
  assert.ok(hit);
  assert.equal(session.lastFrame.cursor.y, hit.y);
});

test('t from any file adds a repo todo and starts editing', () => {
  const { session } = openSession([sampleItem('a.js'), sampleItem('b.js')], {
    startPane: 'files',
  });
  session.dispatch('scrollDown');
  assert.equal(session.fileCursor, 1);
  session.dispatch('todo');
  assert.equal(session.pane, 'diff');
  assert.equal(session.current().origin, 'todo');
  assert.equal(session.current().file.newPath, 'TODOs');
  assert.equal(session.mode, 'compose');
  assert.equal(session.composeKind, 'todo');
  assert.equal(session.todoFocus, 0);
  assert.deepEqual(session.view().todos, ['[ ] ']);
  session.handleEvent({ type: 'key', key: 'escape' });
  session.dispatch('files');
  session.fileCursor = 0;
  session.dispatch('todo');
  assert.equal(session.current().file.newPath, 'TODOs');
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, '');
});

test('t opens the repo todo page and lets you edit it', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session } = openSession([a, b]);
  const files = session.fileList();
  assert.equal(files[0].kind, 'todos');
  assert.equal(files[0].path, 'Project Backlog and Issues');
  assert.equal(files[0].remaining, 0);
  assert.equal(files[0].staged, 0);
  session.dispatch('todo');
  assert.equal(session.current().origin, 'todo');
  assert.equal(session.current().file.newPath, 'TODOs');
  assert.equal(session.mode, 'compose');
  assert.equal(session.items[0].origin, 'unstaged');
  session.pushInput('rewrite loop');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  assert.equal(session.items[0].file.newPath, 'a.js');
  assert.equal(session.items[1].file.newPath, 'b.js');
  assert.equal(session.current().origin, 'todo');
  assert.deepEqual(session.view().todos, ['[ ] rewrite loop', '[ ] ']);
  assert.equal(session.view().total, 2);
  assert.equal(session.counts().todo, 1);
  assert.equal(session.counts().feedback, 0);
  assert.equal(session.fileList()[0].remaining, 1);
  assert.equal(session.fileList()[0].staged, 0);
  assert.equal(session.todoFocus, 0);
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'rewrite loop');
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.mode, 'review');
  assert.equal(session.todoFocus, 0);
  session.dispatch('next');
  assert.equal(session.current().origin, 'unstaged');
  assert.equal(session.current().file.newPath, 'a.js');
  assert.equal(session.idleNoteText(), '');
  session.dispatch('todo');
  assert.equal(session.current().origin, 'todo');
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, '');
  assert.deepEqual(session.view().todos, ['[ ] rewrite loop', '[ ] ']);
  assert.equal(session.todoFocus, 1);
  session.pushInput('add tests');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  assert.equal(session.todoOpen, true);
  assert.deepEqual(session.view().todos, [
    '[ ] rewrite loop',
    '[ ] add tests',
    '[ ] ',
  ]);
  assert.equal(session.todoFocus, 1);
  session.dispatch('next');
  assert.equal(session.current().origin, 'unstaged');
  assert.equal(session.current().file.newPath, 'a.js');
  session.dispatch('next');
  assert.equal(session.current().file.newPath, 'b.js');
  assert.equal(session.idleNoteText(), '');
  session.dispatch('prev');
  session.dispatch('prev');
  assert.equal(session.current().origin, 'todo');
});

test('todo list keeps a blank row to start a new item', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.dispatch('todo');
  session.pushInput('first note');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  assert.equal(session.mode, 'review');
  assert.deepEqual(session.view().todos, ['[ ] first note', '[ ] ']);
  session.dispatch('scrollDown');
  assert.equal(session.todoFocus, 1);
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.mode, 'compose');
  assert.equal(session.composeTodoId, null);
  assert.equal(session.editor.text, '');
  session.handleEvent({ type: 'key', key: 'escape' });
  session.draw();
  const draft = session.lastFrame.todoHits.find((row) => row.cursor === 1);
  assert.ok(draft);
  session.handleEvent({
    type: 'mouse',
    kind: 'press',
    btn: 0,
    button: 0,
    x: 2,
    y: draft.y,
    press: true,
  });
  session.handleEvent({
    type: 'mouse',
    kind: 'release',
    btn: 0,
    button: 0,
    x: 2,
    y: draft.y,
    press: false,
  });
  assert.equal(session.todoFocus, 1);
  assert.equal(session.mode, 'compose');
  assert.equal(session.composeTodoId, null);
  session.pushInput('second note');
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.deepEqual(session.view().todos, [
    '[ ] first note',
    '[ ] second note',
    '[ ] ',
  ]);
  assert.equal(session.mode, 'compose');
  assert.equal(session.todoFocus, 2);
  assert.equal(session.editor.text, '');
});

test('enter and click edit the focused todo', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.dispatch('todo');
  session.pushInput('first note');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  session.startDraftCompose();
  session.pushInput('second note');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  assert.equal(session.mode, 'review');
  assert.equal(session.todoFocus, 1);
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'second note');
  session.handleEvent({ type: 'key', key: 'escape' });
  session.dispatch('scrollUp');
  assert.equal(session.todoFocus, 0);
  session.draw();
  const hit = session.lastFrame.todoHits.find((row) => row.cursor === 0);
  assert.ok(hit);
  session.handleEvent({
    type: 'mouse',
    kind: 'press',
    btn: 0,
    button: 0,
    x: 8,
    y: hit.y,
    press: true,
  });
  session.handleEvent({
    type: 'mouse',
    kind: 'release',
    btn: 0,
    button: 0,
    x: 8,
    y: hit.y,
    press: false,
  });
  assert.equal(session.todoFocus, 0);
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'first note');
  session.handleEvent({ type: 'key', key: 'escape' });
  session.draw();
  const other = session.lastFrame.todoHits.find((row) => row.cursor === 1);
  assert.ok(other);
  session.handleEvent({
    type: 'mouse',
    kind: 'press',
    btn: 0,
    button: 0,
    x: 8,
    y: other.y,
    press: true,
  });
  session.handleEvent({
    type: 'mouse',
    kind: 'release',
    btn: 0,
    button: 0,
    x: 8,
    y: other.y,
    press: false,
  });
  assert.equal(session.todoFocus, 1);
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'second note');
});

test('todo list stays on screen while composing', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.dispatch('todo');
  session.pushInput('first note');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  session.startDraftCompose();
  session.pushInput('draft two');
  assert.equal(session.mode, 'compose');
  session.draw();
  const body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /\[ \] first note/);
  const hit = session.lastFrame.todoHits.find((row) => row.cursor === 0);
  assert.ok(hit);
  session.handleEvent({
    type: 'mouse',
    kind: 'press',
    btn: 0,
    button: 0,
    x: 8,
    y: hit.y,
    press: true,
  });
  session.handleEvent({
    type: 'mouse',
    kind: 'release',
    btn: 0,
    button: 0,
    x: 8,
    y: hit.y,
    press: false,
  });
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'first note');
  assert.equal(session.notes.todos.length, 2);
  assert.equal(session.notes.todos[1].text, 'draft two');
});

test('delete and backspace remove the selected todo', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.dispatch('todo');
  session.pushInput('first note');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  session.startDraftCompose();
  session.pushInput('second note');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  assert.equal(session.mode, 'review');
  assert.equal(session.todoFocus, 1);
  session.handleEvent({ type: 'key', key: 'delete' });
  assert.deepEqual(session.view().todos, ['[ ] first note', '[ ] ']);
  assert.equal(session.todoFocus, 0);
  assert.equal(session.current().origin, 'todo');
  session.handleEvent({ type: 'key', key: 'backspace' });
  assert.deepEqual(session.view().todos, ['[ ] ']);
  assert.equal(session.current().origin, 'todo');
});

test('empty autosave does not persist a draft todo', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.dispatch('todo');
  assert.equal(session.composeTodoId, null);
  session.autosave();
  assert.equal(session.notes.todos.length, 0);
  session.pushInput('keep this');
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, '');
  assert.equal(session.todoFocus, 1);
  assert.equal(session.notes.todos[0].text, 'keep this');
  assert.equal(session.current().origin, 'todo');
});

test('todo autosave updates one draft instead of duplicating', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.dispatch('todo');
  session.pushInput('keep this');
  session.autosave();
  assert.equal(session.notes.todos.length, 1);
  assert.equal(session.composeTodoId, session.notes.todos[0].id);
  session.autosave();
  assert.equal(session.notes.todos.length, 1);
  session.pushInput(' more');
  session.autosave();
  assert.equal(session.notes.todos.length, 1);
  assert.equal(session.notes.todos[0].text, 'keep this more');
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, '');
  assert.equal(session.todoFocus, 1);
  assert.deepEqual(session.view().todos, ['[ ] keep this more', '[ ] ']);
});

test('typing a todo starts editing at the end of the line', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.dispatch('todo');
  session.pushInput('first');
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.mode, 'review');
  assert.equal(session.todoFocus, 0);
  session.pushInput('+more');
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'first+more');
  assert.equal(session.editor.cursor, 'first+more'.length);
});

test('home end and page keys jump the todo list', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.dispatch('todo');
  session.pushInput('one');
  session.handleEvent({ type: 'key', key: 'enter' });
  session.pushInput('two');
  session.handleEvent({ type: 'key', key: 'enter' });
  session.pushInput('three');
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.mode, 'review');
  session.handleEvent({ type: 'key', key: 'home' });
  assert.equal(session.todoFocus, 0);
  session.handleEvent({ type: 'key', key: 'end' });
  assert.equal(session.todoFocus, 3);
  session.handleEvent({ type: 'key', key: 'home' });
  session.handleEvent({ type: 'key', key: 'pageDown' });
  assert.equal(session.todoFocus, 3);
  session.handleEvent({ type: 'key', key: 'pageUp' });
  assert.equal(session.todoFocus, 0);
});

test('todo edit arrows move across todos without leaving edit', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.dispatch('todo');
  session.pushInput('first');
  session.handleEvent({ type: 'key', key: 'enter' });
  session.pushInput('second');
  session.handleEvent({ type: 'key', key: 'up' });
  assert.equal(session.mode, 'compose');
  assert.equal(session.todoFocus, 0);
  assert.equal(session.editor.text, 'first');
  assert.equal(session.editor.cursor, 'first'.length);
  session.handleEvent({ type: 'key', key: 'up' });
  assert.equal(session.mode, 'compose');
  assert.equal(session.todoFocus, 0);
  session.handleEvent({ type: 'key', key: 'down' });
  assert.equal(session.mode, 'compose');
  assert.equal(session.todoFocus, 1);
  assert.equal(session.editor.text, 'second');
  session.handleEvent({ type: 'key', key: 'down' });
  assert.equal(session.mode, 'compose');
  assert.equal(session.todoFocus, 2);
  assert.equal(session.editor.text, '');
  session.handleEvent({ type: 'key', key: 'down' });
  assert.equal(session.mode, 'compose');
  assert.equal(session.todoFocus, 2);
  assert.deepEqual(session.view().todos, ['[ ] first', '[ ] second', '[ ] ']);
});

test('todo edit arrows move inside a multiline todo', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.dispatch('todo');
  session.pushInput('first');
  session.handleEvent({ type: 'key', key: 'enter' });
  session.pushInput('second');
  session.handleEvent({ type: 'key', key: 'escape' });
  session.notes.todos[1].text = 'one\ntwo\nthree';
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.linePos().line, 2);
  session.handleEvent({ type: 'key', key: 'up' });
  assert.equal(session.todoFocus, 1);
  assert.equal(session.editor.linePos().line, 1);
  session.handleEvent({ type: 'key', key: 'up' });
  assert.equal(session.todoFocus, 1);
  assert.equal(session.editor.linePos().line, 0);
  session.handleEvent({ type: 'key', key: 'up' });
  assert.equal(session.mode, 'compose');
  assert.equal(session.todoFocus, 0);
  assert.equal(session.editor.text, 'first');
  session.handleEvent({ type: 'key', key: 'down' });
  assert.equal(session.todoFocus, 1);
  assert.equal(session.editor.text, 'one\ntwo\nthree');
  assert.equal(session.editor.linePos().line, 2);
  session.handleEvent({ type: 'key', key: 'down' });
  assert.equal(session.todoFocus, 2);
  assert.equal(session.editor.text, '');
});

test('todo list arrows skip over multiline items', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.dispatch('todo');
  session.pushInput('first');
  session.handleEvent({ type: 'key', key: 'enter' });
  session.pushInput('second');
  session.handleEvent({ type: 'key', key: 'escape' });
  session.notes.todos[1].text = 'one\ntwo\nthree';
  assert.equal(session.mode, 'review');
  assert.equal(session.todoFocus, 1);
  session.handleEvent({ type: 'key', key: 'up' });
  assert.equal(session.mode, 'review');
  assert.equal(session.todoFocus, 0);
  session.handleEvent({ type: 'key', key: 'down' });
  assert.equal(session.todoFocus, 1);
  session.handleEvent({ type: 'key', key: 'down' });
  assert.equal(session.todoFocus, 2);
});

test('todo edit arrows move across wrapped lines', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.dispatch('todo');
  session.pushInput('first');
  session.handleEvent({ type: 'key', key: 'enter' });
  session.pushInput('second');
  session.handleEvent({ type: 'key', key: 'escape' });
  const long = 'x'.repeat(90);
  session.notes.todos[1].text = long;
  session.handleEvent({ type: 'key', key: 'enter' });
  session.handleEvent({ type: 'key', key: 'up' });
  assert.equal(session.todoFocus, 1);
  assert.ok(session.editor.cursor < long.length);
  session.handleEvent({ type: 'key', key: 'down' });
  assert.equal(session.todoFocus, 1);
  assert.equal(session.editor.cursor, long.length);
  session.handleEvent({ type: 'key', key: 'down' });
  assert.equal(session.todoFocus, 2);
});

test('todo edit page keys jump across todos', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.dispatch('todo');
  session.pushInput('first');
  session.handleEvent({ type: 'key', key: 'enter' });
  session.pushInput('second');
  session.handleEvent({ type: 'key', key: 'enter' });
  session.pushInput('third');
  session.handleEvent({ type: 'key', key: 'pageUp' });
  assert.equal(session.mode, 'compose');
  assert.equal(session.todoFocus, 0);
  assert.equal(session.editor.text, 'first');
  session.handleEvent({ type: 'key', key: 'pageDown' });
  assert.equal(session.todoFocus, 3);
  assert.equal(session.editor.text, '');
});

test('enter edits the next todo and escape stays on it', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.dispatch('todo');
  session.pushInput('first');
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.mode, 'compose');
  assert.equal(session.todoFocus, 1);
  assert.equal(session.editor.text, '');
  session.pushInput('second');
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.mode, 'review');
  assert.equal(session.todoFocus, 1);
  assert.deepEqual(session.view().todos, ['[ ] first', '[ ] second', '[ ] ']);
});

test('todo save recovers if the stub was dropped', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.dispatch('todo');
  session.notes.todos = [];
  session.pushInput('still here');
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.notes.todos.length, 1);
  assert.equal(session.notes.todos[0].text, 'still here');
  assert.equal(session.current().origin, 'todo');
});

test('quit with notes asks f to finish or c to continue', () => {
  const item = sampleItem('a.js');
  const { session } = openSession([item]);
  session.dispatch('feedback');
  session.pushInput('nits');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  session.dispatch('quit');
  assert.equal(session.done, false);
  assert.equal(session.mode, 'confirmQuit');
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.done, false);
  assert.equal(session.mode, 'review');
  session.dispatch('quit');
  session.pushInput('f');
  assert.equal(session.done, true);
  const md = fs.readFileSync(session.notes.reviewPath, 'utf8');
  assert.match(md, /nits/);
  assert.match(md, /status: ready/);
});

test('click quit prompt continues next time', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.dispatch('feedback');
  session.pushInput('nits');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  session.dispatch('quit');
  assert.equal(session.mode, 'confirmQuit');
  clickStatusChoice(session, 'c');
  assert.equal(session.done, true);
  assert.equal(session.notes.status, 'editing');
});

test('quit continue keeps editing so the next run can resume', () => {
  const item = sampleItem('a.js');
  const { session } = openSession([item]);
  session.dispatch('feedback');
  session.pushInput('nits');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  session.dispatch('quit');
  session.pushInput('c');
  assert.equal(session.done, true);
  assert.equal(session.notes.status, 'editing');
  const md = fs.readFileSync(session.notes.reviewPath, 'utf8');
  assert.match(md, /status: editing/);
  assert.match(md, /nits/);
});

test('initReview resumes latest editing file', () => {
  const cwd = tempDir('reslop-ui-');
  const name = `${dateStamp()}-00.md`;
  const reviewPath = path.join(cwd, REVIEW_DIR, name);
  const draft = createStore(reviewPath);
  addTodo(draft, 'a.js', 'rewrite loop');
  fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
  fs.writeFileSync(reviewPath, serializeReview(draft), 'utf8');
  const { session } = openSession([sampleItem('a.js')], { cwd });
  assert.equal(session.notes.reviewPath, reviewPath);
  assert.equal(session.notes.status, 'editing');
  assert.equal(session.notes.todos[0].text, 'rewrite loop');
  assert.equal(
    session.fileList().some((entry) => entry.kind === 'todos'),
    true,
  );
});

test('initReview starts a new file when latest is ready', () => {
  const cwd = tempDir('reslop-ui-');
  const name = `${dateStamp()}-00.md`;
  const reviewPath = path.join(cwd, REVIEW_DIR, name);
  const draft = createStore(reviewPath);
  draft.status = 'ready';
  addTodo(draft, 'a.js', 'rewrite loop');
  fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
  fs.writeFileSync(reviewPath, serializeReview(draft), 'utf8');
  const { session } = openSession([sampleItem('a.js')], { cwd });
  assert.equal(
    session.notes.reviewPath,
    path.join(cwd, REVIEW_DIR, `${dateStamp()}-01.md`),
  );
  assert.equal(session.notes.todos.length, 0);
});

test('newReview starts a new file even if latest is editing', () => {
  const cwd = tempDir('reslop-ui-');
  const name = `${dateStamp()}-00.md`;
  const reviewPath = path.join(cwd, REVIEW_DIR, name);
  const draft = createStore(reviewPath);
  addTodo(draft, 'a.js', 'rewrite loop');
  fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
  fs.writeFileSync(reviewPath, serializeReview(draft), 'utf8');
  const { session } = openSession([sampleItem('a.js')], {
    cwd,
    newReview: true,
  });
  assert.equal(
    session.notes.reviewPath,
    path.join(cwd, REVIEW_DIR, `${dateStamp()}-01.md`),
  );
  assert.equal(session.notes.todos.length, 0);
});

test('files pane c lists commits and c commits the message', () => {
  const { session, repo } = openSession([sampleItem('a.js', 'staged')], {
    startPane: 'files',
  });
  session.pushInput('c');
  assert.equal(session.pane, 'commits');
  assert.equal(session.mode, 'review');
  assert.equal(session.commitCursor, 0);
  assert.equal(session.view().commits[0].subject, 'uncommitted changes');
  assert.equal(session.view().commits[1].subject, 'land the change');
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.pane, 'files');
  assert.equal(repo.commits.length, 0);
  session.pushInput('c');
  session.pushInput('c');
  assert.equal(session.mode, 'compose');
  assert.equal(session.composeKind, 'commit');
  assert.equal(session.commitKind, 'commit');
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.mode, 'compose');
  assert.equal(session.status, 'empty commit message');
  assert.equal(repo.commits.length, 0);
  session.pushInput('land the change');
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.mode, 'review');
  assert.equal(session.status, 'committed');
  assert.equal(repo.commits.length, 1);
  assert.equal(repo.commits[0].kind, 'commit');
  assert.equal(repo.commits[0].message, 'land the change');
});

test('enter on uncommitted changes leaves a viewed commit', () => {
  const { session } = openSession([sampleItem('a.js', 'staged')], {
    startPane: 'files',
  });
  const sha = 'aaa1111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  session.pushInput('c');
  session.dispatch('next');
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.pane, 'diff');
  assert.equal(session.rev, sha);
  session.handleEvent({ type: 'key', key: 'escape' });
  session.pushInput('c');
  assert.equal(session.commitCursor, 0);
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.rev, '');
  assert.equal(session.revShort, '');
  assert.equal(session.mode, 'review');
  assert.equal(session.pane, 'diff');
  assert.notEqual(session.items[0].origin, 'commit');
});

test('enter on uncommitted changes opens the commit editor', () => {
  const { session } = openSession([sampleItem('a.js', 'staged')], {
    startPane: 'files',
  });
  session.pushInput('c');
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.pane, 'commits');
  assert.equal(session.mode, 'compose');
  assert.equal(session.commitKind, 'commit');
  assert.equal(session.commitCursor, 0);
});

test('amend is active on uncommitted and while unstaged is current', () => {
  const { session } = openSession([sampleItem('a.js', 'staged')], {
    startPane: 'files',
  });
  const amendHit = () => {
    session.draw();
    return session.lastFrame.buttons.find((hit) => hit.id === 'amend');
  };
  session.pushInput('c');
  assert.ok(amendHit());
  session.dispatch('next');
  assert.ok(amendHit());
  session.rev = 'aaa1111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  session.revShort = 'aaa1111';
  assert.equal(amendHit(), undefined);
  session.pushInput('a');
  assert.equal(session.mode, 'review');
  assert.equal(session.commitKind, null);
  session.handleEvent({ type: 'key', key: 'home' });
  assert.ok(amendHit());
  session.pushInput('a');
  assert.equal(session.commitKind, 'amend');
});

test('click commit footer chooses commit amend or fixup', () => {
  const clickKind = (id, kind) => {
    const { session } = openSession([sampleItem('a.js', 'staged')], {
      startPane: 'files',
    });
    session.pushInput('c');
    if (id !== 'commit') session.dispatch('next');
    clickFooter(session, id);
    assert.equal(session.pane, 'commits');
    assert.equal(session.mode, 'compose');
    assert.equal(session.commitKind, kind);
  };
  clickKind('commit', 'commit');
  clickKind('amend', 'amend');
  clickKind('reword', 'reword');
  clickKind('fixup', 'fixup');
});

test('commits pane v toggles brief on and off', () => {
  const { session } = openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('c');
  assert.equal(session.view().commitView, 'brief');
  session.pushInput('v');
  assert.equal(session.view().commitView, 'full');
  assert.equal(session.status, 'full');
  session.pushInput('v');
  assert.equal(session.view().commitView, 'brief');
  assert.equal(session.status, 'brief');
});

test('full mode commit enter inserts a newline', () => {
  const { session, repo } = openSession([sampleItem('a.js', 'staged')], {
    startPane: 'files',
  });
  session.pushInput('c');
  session.pushInput('v');
  session.pushInput('c');
  session.pushInput('one');
  session.handleEvent({ type: 'key', key: 'enter' });
  session.pushInput('two');
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'one\ntwo');
  assert.equal(repo.commits.length, 0);
  session.handleEvent({ type: 'key', key: 'up' });
  assert.equal(session.editor.cursor, 3);
  assert.equal(session.commitCursor, 0);
});

test('full mode ctrl-s saves the message', () => {
  const { session, repo } = openSession([sampleItem('a.js', 'staged')], {
    startPane: 'files',
  });
  session.pushInput('c');
  session.pushInput('v');
  session.pushInput('c');
  session.pushInput('one');
  session.handleEvent({ type: 'key', key: 'enter' });
  session.pushInput('two');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  assert.equal(session.mode, 'review');
  assert.equal(repo.commits.length, 1);
  assert.equal(repo.commits[0].message, 'one\ntwo');
});

test('full mode enter on an empty last line saves', () => {
  const { session, repo } = openSession([sampleItem('a.js', 'staged')], {
    startPane: 'files',
  });
  session.pushInput('c');
  session.pushInput('v');
  session.pushInput('c');
  session.pushInput('ship it');
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'ship it\n');
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.mode, 'review');
  assert.equal(repo.commits[0].message, 'ship it\n');
});

test('editing a commit ignores clicks and scrolls on other commits', () => {
  const { session, stdout } = openSession([sampleItem('a.js', 'staged')], {
    startPane: 'files',
  });
  stdout.rows = 32;
  session.pushInput('c');
  session.pushInput('v');
  session.dispatch('next');
  session.dispatch('next');
  session.pushInput('r');
  session.pushInput('x');
  assert.equal(session.mode, 'compose');
  assert.equal(session.commitCursor, 2);
  assert.equal(session.editor.text, 'initx');
  const cursor = session.editor.cursor;
  session.draw();
  const other = session.lastFrame.fileHits.find((hit) => hit.cursor === 0);
  assert.ok(other);
  session.handleEvent({
    type: 'mouse',
    button: 0,
    btn: 0,
    kind: 'press',
    x: 4,
    y: other.y,
    press: true,
  });
  session.handleEvent({
    type: 'mouse',
    button: 0,
    btn: 0,
    kind: 'release',
    x: 4,
    y: other.y,
    press: false,
  });
  session.handleEvent({
    type: 'mouse',
    kind: 'wheelDown',
    x: 4,
    y: other.y,
  });
  assert.equal(session.commitCursor, 2);
  assert.equal(session.editor.text, 'initx');
  assert.equal(session.editor.cursor, cursor);
  assert.equal(session.mode, 'compose');
});

test('brief reword edits the first line and keeps the body', () => {
  const { session, repo } = openSession([sampleItem('a.js', 'staged')], {
    startPane: 'files',
  });
  repo.setCommits([
    {
      sha: 'aaa1111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      shortSha: 'aaa1111',
      author: 'Ada',
      date: '2 hours ago',
      subject: 'land the change\n\nexplain the change',
    },
  ]);
  session.pushInput('c');
  session.dispatch('next');
  session.pushInput('r');
  assert.equal(session.editor.text, 'land the change');
  assert.equal(session.editor.cursor, 'land the change'.length);
  session.editor.replace('ship it');
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.status, 'reworded');
  assert.deepEqual(repo.rewords, [
    {
      sha: 'aaa1111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      message: 'ship it\n\nexplain the change',
    },
  ]);
});

test('brief amend edits the first line and keeps the body', () => {
  const { session, repo } = openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  repo.lastMessage = () => 'land the change\n\nexplain the change';
  session.pushInput('c');
  session.dispatch('next');
  session.pushInput('a');
  assert.equal(session.editor.text, 'land the change');
  assert.equal(session.editor.cursor, 'land the change'.length);
  session.editor.replace('ship it');
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.status, 'amended');
  assert.equal(repo.commits[0].kind, 'amend');
  assert.equal(repo.commits[0].message, 'ship it\n\nexplain the change');
});

test('full mode reword edits the whole message', () => {
  const { session, repo } = openSession([sampleItem('a.js', 'staged')], {
    startPane: 'files',
  });
  repo.setCommits([
    {
      sha: 'aaa1111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      shortSha: 'aaa1111',
      author: 'Ada',
      date: '2 hours ago',
      subject: 'land the change\n\nexplain the change',
    },
  ]);
  session.pushInput('c');
  session.pushInput('v');
  session.dispatch('next');
  session.pushInput('r');
  assert.equal(session.editor.text, 'land the change\n\nexplain the change');
  session.editor.replace('ship it\n\nnew body');
  session.handleEvent({ type: 'key', key: 'ctrl-s' });
  assert.deepEqual(repo.rewords, [
    {
      sha: 'aaa1111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      message: 'ship it\n\nnew body',
    },
  ]);
});

test('commits pane a amends with the previous message', () => {
  const { session, repo } = openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('c');
  session.dispatch('next');
  session.pushInput('a');
  assert.equal(session.commitCursor, 1);
  assert.equal(session.composeKind, 'commit');
  assert.equal(session.commitKind, 'amend');
  assert.equal(session.editor.text, 'previous message');
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.status, 'amended');
  assert.equal(repo.commits[0].kind, 'amend');
  assert.equal(repo.commits[0].message, 'previous message');
});

test('commits pane r rewords the selected commit', () => {
  const { session, repo } = openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('c');
  session.dispatch('next');
  session.dispatch('next');
  session.pushInput('r');
  assert.equal(session.commitCursor, 2);
  assert.equal(session.composeKind, 'commit');
  assert.equal(session.commitKind, 'reword');
  assert.equal(session.editor.text, 'init');
  session.editor.replace('rewritten init');
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.status, 'reworded');
  assert.deepEqual(repo.rewords, [
    {
      sha: 'bbb2222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      message: 'rewritten init',
    },
  ]);
  assert.equal(session.view().commits[2].subject, 'rewritten init');
});

test('commits pane a applies a selected fixup', () => {
  const { session, repo } = openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('c');
  repo.setCommits([
    {
      sha: 'fff0000fffffffffffffffffffffffffffffff',
      shortSha: 'fff0000',
      author: 'Ada',
      date: 'now',
      subject: 'fixup! land the change',
    },
    {
      sha: 'aaa1111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      shortSha: 'aaa1111',
      author: 'Ada',
      date: '2 hours ago',
      subject: 'land the change',
    },
  ]);
  session.commits.refresh();
  session.dispatch('next');
  session.draw();
  assert.ok(session.lastFrame.buttons.find((hit) => hit.id === 'apply'));
  session.pushInput('a');
  assert.deepEqual(repo.applyFixups, [
    'fff0000fffffffffffffffffffffffffffffff',
  ]);
  assert.equal(session.status, 'applied');
  assert.equal(session.mode, 'review');
  assert.equal(session.composeKind, null);
});

test('click apply footer squashes the selected fixup', () => {
  const { session, repo } = openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('c');
  repo.setCommits([
    {
      sha: 'fff0000fffffffffffffffffffffffffffffff',
      shortSha: 'fff0000',
      author: 'Ada',
      date: 'now',
      subject: 'fixup! land the change',
    },
    {
      sha: 'aaa1111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      shortSha: 'aaa1111',
      author: 'Ada',
      date: '2 hours ago',
      subject: 'land the change',
    },
  ]);
  session.commits.refresh();
  session.dispatch('next');
  clickFooter(session, 'apply');
  assert.deepEqual(repo.applyFixups, [
    'fff0000fffffffffffffffffffffffffffffff',
  ]);
  assert.equal(session.status, 'applied');
});

test('commits pane f fixups the selected commit', () => {
  const { session, repo } = openSession([sampleItem('a.js', 'staged')], {
    startPane: 'files',
  });
  session.pushInput('c');
  session.dispatch('next');
  session.pushInput('f');
  assert.equal(session.editor.text, 'fixup! land the change');
  session.handleEvent({ type: 'key', key: 'escape' });
  session.dispatch('next');
  session.pushInput('f');
  assert.equal(session.editor.text, 'fixup! init');
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.status, 'fixup');
  assert.equal(repo.commits[0].kind, 'fixup');
  assert.equal(repo.commits[0].message, 'fixup! init');
});

test('escape from commit message does not run git', () => {
  const { session, repo } = openSession([sampleItem('a.js', 'staged')], {
    startPane: 'files',
  });
  session.pushInput('c');
  session.pushInput('c');
  session.pushInput('draft');
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.mode, 'review');
  assert.equal(repo.commits.length, 0);
});

test('compose c inserts a letter and does not open commit', () => {
  const { session, repo } = openSession([sampleItem('a.js')]);
  session.dispatch('feedback');
  session.pushInput('c');
  assert.equal(session.mode, 'compose');
  assert.equal(session.composeKind, 'feedback');
  assert.equal(session.editor.text, 'c');
  assert.equal(repo.commits.length, 0);
});

test('diff pane c does not open commits', () => {
  const { session } = openSession([sampleItem('a.js', 'staged')]);
  session.pushInput('c');
  assert.equal(session.mode, 'review');
  assert.equal(session.pane, 'diff');
});

test('commits pane skips commit when nothing is staged', () => {
  const { session, repo } = openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('c');
  assert.equal(session.pane, 'commits');
  session.pushInput('c');
  assert.equal(session.mode, 'review');
  assert.equal(session.status, 'nothing to commit');
  assert.equal(repo.commits.length, 0);
  session.pushInput('f');
  assert.equal(session.mode, 'review');
  assert.equal(session.status, 'nothing to commit');
  assert.equal(repo.commits.length, 0);
});

test('commits pane lists newest first', () => {
  const { session } = openSession([sampleItem('a.js')], { startPane: 'files' });
  session.pushInput('c');
  const listed = session.view().commits.map((entry) => entry.subject);
  assert.deepEqual(listed, ['uncommitted changes', 'land the change', 'init']);
  session.handleEvent({ type: 'key', key: 'right' });
  assert.equal(session.commitCursor, 0);
  session.handleEvent({ type: 'key', key: 'down' });
  assert.equal(session.commitCursor, 1);
  session.handleEvent({ type: 'key', key: 'up' });
  assert.equal(session.commitCursor, 0);
  session.pushInput('j');
  assert.equal(session.commitCursor, 1);
  session.handleEvent({ type: 'key', key: 'home' });
  assert.equal(session.commitCursor, 0);
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.pane, 'commits');
  assert.equal(session.mode, 'review');
  assert.equal(session.status, 'nothing to commit');
  session.handleEvent({ type: 'key', key: 'escape' });
  session.pushInput('c');
  session.handleEvent({ type: 'key', key: 'end' });
  assert.equal(session.commitCursor, 2);
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.pane, 'diff');
  assert.equal(session.rev, 'bbb2222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
});

test('commits pane d asks to drop the selected commit', () => {
  const { session, repo } = openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('c');
  session.dispatch('next');
  session.pushInput('d');
  assert.equal(session.mode, 'confirmDrop');
  assert.equal(session.view().dropName, 'aaa1111');
  session.pushInput('n');
  assert.equal(session.mode, 'review');
  assert.equal(repo.commitDrops.length, 0);
  session.pushInput('d');
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.mode, 'review');
  assert.equal(repo.commitDrops.length, 0);
  session.pushInput('d');
  session.pushInput('y');
  assert.deepEqual(repo.commitDrops, [
    'aaa1111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ]);
  assert.match(session.status, /dropped aaa1111/);
  assert.equal(session.pane, 'commits');
  assert.equal(session.view().commits[1].subject, 'init');
});

test('click commit row selects it', () => {
  const { session } = openSession([sampleItem('a.js')], { startPane: 'files' });
  session.pushInput('c');
  session.draw();
  const hit = session.lastFrame.fileHits.find((entry) => entry.cursor === 1);
  assert.ok(hit);
  session.handleEvent({
    type: 'mouse',
    button: 0,
    btn: 0,
    kind: 'press',
    x: 4,
    y: hit.y,
    press: true,
  });
  session.handleEvent({
    type: 'mouse',
    button: 0,
    btn: 0,
    kind: 'release',
    x: 4,
    y: hit.y,
    press: false,
  });
  assert.equal(session.commitCursor, 1);
  assert.equal(session.pane, 'commits');
});

test('files pane a and d stay add and revert', () => {
  const added = openSession([sampleItem('a.js')], { startPane: 'files' });
  added.session.handleEvent({ type: 'key', key: 'down' });
  added.session.pushInput('a');
  assert.equal(added.repo.added.length, 1);
  const reverted = openSession([sampleItem('a.js')], { startPane: 'files' });
  reverted.session.handleEvent({ type: 'key', key: 'down' });
  reverted.session.pushInput('d');
  assert.equal(reverted.repo.reverted.length, 1);
});

test('files pane p pulls and s pushes', () => {
  const { session, repo } = openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('p');
  assert.equal(repo.pulls.length, 1);
  assert.equal(session.status, 'pulled');
  session.pushInput('s');
  assert.equal(repo.pushes.length, 1);
  assert.equal(session.status, 'pushed');
});

test('commits pane p pulls and s pushes', () => {
  const { session, repo } = openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('c');
  assert.equal(session.pane, 'commits');
  session.pushInput('p');
  assert.equal(repo.pulls.length, 1);
  assert.equal(session.status, 'pulled');
  assert.equal(session.pane, 'commits');
  session.pushInput('s');
  assert.equal(repo.pushes.length, 1);
  assert.equal(session.status, 'pushed');
  assert.equal(session.pane, 'commits');
  clickFooter(session, 'pull');
  assert.equal(repo.pulls.length, 2);
  clickFooter(session, 'push');
  assert.equal(repo.pushes.length, 2);
});

test('quit without notes does not write a review file', () => {
  const { session } = openSession([sampleItem('a.js')]);
  const reviewPath = session.notes.reviewPath;
  session.dispatch('quit');
  assert.equal(session.done, true);
  assert.equal(fs.existsSync(reviewPath), false);
});

test('load applies imported GitHub notes on a new review', () => {
  const item = sampleItem('lib/parser.js', 'pr');
  const cwd = tempDir('reslop-ui-');
  const imported = {
    feedback: [
      {
        file: 'lib/parser.js',
        oldStart: 1,
        newStart: 1,
        blockId: 0,
        origin: 'pr',
        header: '@@ -1,1 +1,1 @@',
        text: '@alice review at github: use const',
        done: false,
      },
    ],
    todos: [
      {
        file: 'pull request',
        text: '@bob review at github: add tests',
        done: false,
      },
    ],
  };
  const repo = {
    load: () => ({
      top: cwd,
      items: [item],
      imported,
      sourceLabel: '#123',
    }),
    add: () => {},
    unstage: () => {},
    revert: () => {},
  };
  const { session } = openSession([item], { cwd, repo });
  const notes = [...session.notes.feedback.values()];
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /use const/);
  assert.equal(session.notes.todos.length, 1);
  assert.equal(session.notes.todos[0].file, 'pull request');
  assert.equal(
    session.fileList().some((entry) => entry.kind === 'todos'),
    true,
  );
  session.load();
  assert.equal(session.notes.todos.length, 1);
});

test('load skips imported GitHub notes when resuming a review', () => {
  const cwd = tempDir('reslop-ui-');
  const reviewPath = path.join(cwd, REVIEW_DIR, `${dateStamp()}-00.md`);
  const draft = createStore(reviewPath);
  addTodo(draft, 'a.js', 'rewrite loop');
  fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
  fs.writeFileSync(reviewPath, serializeReview(draft), 'utf8');
  const item = sampleItem('lib/parser.js', 'pr');
  const imported = {
    feedback: [],
    todos: [{ file: 'pull request', text: 'from github', done: false }],
  };
  const { session } = openSession([item], {
    cwd,
    repo: {
      load: () => ({ top: cwd, items: [item], imported }),
      add: () => {},
      unstage: () => {},
      revert: () => {},
    },
  });
  assert.equal(session.notes.todos.length, 1);
  assert.equal(session.notes.todos[0].text, 'rewrite loop');
});

test('openLoad paints git items before npm extras arrive', async () => {
  const gitItem = sampleItem('a.js');
  const extraItem = sampleItem('package.json');
  extraItem.dep = { change: { name: 'lodash', section: 'dependencies' } };
  const cwd = tempDir('reslop-ui-');
  let extrasResolve;
  const extras = new Promise((resolve) => {
    extrasResolve = resolve;
  });
  let extrasStarted = false;
  const repo = {
    loadAsync: async () => ({
      top: cwd,
      items: [gitItem],
      parsed: [gitItem],
      pending: true,
    }),
    loadExtras: async () => {
      extrasStarted = true;
      await extras;
      return {
        top: cwd,
        items: [gitItem, extraItem],
        pending: false,
      };
    },
    load: () => ({ top: cwd, items: [gitItem] }),
    add: () => {},
    unstage: () => {},
    revert: () => {},
  };
  const session = new Session({
    cwd,
    stdout: uiSink(),
    color: false,
    repo,
    audit: true,
    startPane: 'files',
  });
  session.uiOpen = true;
  const pending = session.openLoad();
  await new Promise((resolve, reject) => {
    const tick = (left) => {
      if (extrasStarted) {
        resolve();
        return;
      }
      if (left <= 0) {
        reject(new Error('extras did not start'));
        return;
      }
      setImmediate(() => tick(left - 1));
    };
    tick(50);
  });
  assert.equal(session.items.length, 1);
  assert.equal(session.items[0].file.newPath, 'a.js');
  assert.equal(session.busy, 'checking npm');
  session.dispatch('next');
  extrasResolve();
  await pending;
  assert.equal(session.items.length, 2);
  assert.equal(session.busy, '');
});

const openUpdating = (extra = {}) => {
  const cacheFile = path.join(tempDir('reslop-cache-'), 'update.json');
  const installed = [];
  let fetchResolve;
  let fetchGate = null;
  if (extra.gateFetch) {
    fetchGate = new Promise((resolve) => {
      fetchResolve = resolve;
    });
  }
  const update = {
    enabled: true,
    current: extra.current ?? '0.1.5',
    cacheFile,
    fetch:
      extra.fetch ??
      (async () => {
        if (fetchGate) await fetchGate;
        return {
          ok: true,
          json: async () => ({ version: extra.latest ?? '0.1.6' }),
        };
      }),
    install:
      extra.install ??
      (async (version) => {
        installed.push(version);
      }),
  };
  const { session } = openSession([sampleItem('a.js'), sampleItem('b.js')], {
    startPane: 'files',
    update,
    ...extra.session,
  });
  session.uiOpen = true;
  return { session, installed, fetchResolve, cacheFile, update };
};

test('update check does not block loading', async () => {
  const { session, fetchResolve, installed } = openUpdating({
    gateFetch: true,
    latest: '0.1.6',
  });
  const updateP = session.openUpdate();
  assert.equal(session.didLoad, true);
  assert.equal(session.items.length, 2);
  assert.equal(session.mode, 'review');
  assert.deepEqual(installed, []);
  fetchResolve();
  await updateP;
  assert.deepEqual(installed, ['0.1.6']);
});

test('patch update installs in the background', async () => {
  const { session, installed } = openUpdating({ latest: '0.1.6' });
  await session.openUpdate();
  assert.deepEqual(installed, ['0.1.6']);
  assert.equal(session.status, 'updated');
  assert.equal(session.mode, 'review');
});

test('major update asks y or n on the loaded status line', async () => {
  const { session, installed } = openUpdating({ latest: '1.0.0' });
  await session.openUpdate();
  session.draw();
  assert.equal(session.mode, 'confirmUpdate');
  assert.equal(session.updateFrom, '0.1.5');
  assert.equal(session.updateTo, '1.0.0');
  assert.deepEqual(installed, []);
  const text = session.lastFrame.text;
  assert.match(text, /update reslop 0\.1\.5 → 1\.0\.0\? y\/n/);
  session.handleEvent({ type: 'key', key: 'n' });
  assert.equal(session.mode, 'review');
  assert.deepEqual(installed, []);
  session.handleEvent({ type: 'key', key: 'j' });
  assert.equal(session.fileCursor, 1);
});

test('click update prompt y and n', async () => {
  const declined = openUpdating({ latest: '1.0.0' });
  await declined.session.openUpdate();
  clickStatusChoice(declined.session, 'n');
  assert.equal(declined.session.mode, 'review');
  assert.deepEqual(declined.installed, []);

  const accepted = openUpdating({ latest: '1.0.0' });
  await accepted.session.openUpdate();
  clickStatusChoice(accepted.session, 'y');
  await accepted.session.updater.installPromise;
  assert.deepEqual(accepted.installed, ['1.0.0']);
});

test('major prompt waits until the UI has loaded', async () => {
  const cwd = tempDir('reslop-ui-');
  const session = new Session({
    cwd,
    stdout: uiSink(),
    color: false,
    startPane: 'files',
    repo: mockRepo([sampleItem('a.js')], cwd),
    update: {
      enabled: true,
      current: '0.1.5',
      cacheFile: path.join(tempDir('reslop-cache-'), 'update.json'),
      fetch: async () => ({
        ok: true,
        json: async () => ({ version: '1.0.0' }),
      }),
      install: async () => {},
    },
  });
  session.uiOpen = true;
  await session.openUpdate();
  assert.equal(session.updateOffer, true);
  assert.equal(session.didLoad, false);
  assert.equal(session.mode, 'review');
  session.didLoad = true;
  session.draw();
  assert.equal(session.mode, 'confirmUpdate');
});

test('major update y installs the new version', async () => {
  const { session, installed } = openUpdating({ latest: '1.0.0' });
  await session.openUpdate();
  session.draw();
  session.handleEvent({ type: 'key', key: 'y' });
  await session.installPromise;
  assert.deepEqual(installed, ['1.0.0']);
  assert.equal(session.status, 'updated');
  assert.equal(session.mode, 'review');
});

test('declined major update is not asked again from cache', async () => {
  const { session, cacheFile, update } = openUpdating({ latest: '1.0.0' });
  await session.openUpdate();
  session.draw();
  session.handleEvent({ type: 'key', key: 'n' });
  let fetched = 0;
  const again = openSession([sampleItem('a.js')], {
    startPane: 'files',
    update: {
      ...update,
      fetch: async () => {
        fetched += 1;
        return { ok: true, json: async () => ({ version: '1.0.0' }) };
      },
    },
  }).session;
  again.uiOpen = true;
  await again.openUpdate();
  again.draw();
  assert.equal(again.mode, 'review');
  assert.equal(fetched, 0);
  assert.equal(fs.existsSync(cacheFile), true);
});

test('declined major still auto-installs a later patch', async () => {
  const { session, installed, update } = openUpdating({ latest: '1.0.0' });
  await session.openUpdate();
  session.draw();
  session.handleEvent({ type: 'key', key: 'n' });
  const next = openSession([sampleItem('a.js')], {
    startPane: 'files',
    update: {
      ...update,
      interval: 0,
      fetch: async () => ({
        ok: true,
        json: async () => ({
          versions: { '0.1.5': {}, '0.1.6': {}, '1.0.0': {} },
        }),
      }),
    },
  }).session;
  next.uiOpen = true;
  await next.openUpdate();
  assert.deepEqual(installed, ['0.1.6']);
  assert.equal(next.status, 'updated');
  assert.equal(next.mode, 'review');
});

test('declined major asks again when 1.0.1 appears', async () => {
  const { session, installed, update } = openUpdating({ latest: '1.0.0' });
  await session.openUpdate();
  session.draw();
  session.handleEvent({ type: 'key', key: 'n' });
  const next = openSession([sampleItem('a.js')], {
    startPane: 'files',
    update: {
      ...update,
      interval: 0,
      fetch: async () => ({
        ok: true,
        json: async () => ({
          versions: { '0.1.5': {}, '1.0.0': {}, '1.0.1': {} },
        }),
      }),
    },
  }).session;
  next.uiOpen = true;
  await next.openUpdate();
  next.draw();
  assert.deepEqual(installed, []);
  assert.equal(next.mode, 'confirmUpdate');
  assert.equal(next.updateTo, '1.0.1');
});

test('click status branch opens the branch list', () => {
  const { session } = openSession([sampleItem('a.js')], { startPane: 'files' });
  session.draw();
  const hit = session.lastFrame.statusHits[0];
  assert.ok(hit);
  session.handleEvent({
    type: 'mouse',
    button: 0,
    btn: 0,
    kind: 'press',
    x: hit.x0 + 1,
    y: hit.y,
    press: true,
  });
  session.handleEvent({
    type: 'mouse',
    button: 0,
    btn: 0,
    kind: 'release',
    x: hit.x0 + 1,
    y: hit.y,
    press: false,
  });
  assert.equal(session.pane, 'branches');
});

test('files pane b lists branches and enter checks out', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session, repo } = openSession([a, b], { startPane: 'files' });
  assert.equal(session.branch, 'main');
  session.pushInput('b');
  assert.equal(session.pane, 'branches');
  assert.equal(session.branchCursor, 0);
  session.handleEvent({ type: 'key', key: 'right' });
  assert.equal(session.branchCursor, 0);
  session.handleEvent({ type: 'key', key: 'left' });
  assert.equal(session.branchCursor, 0);
  session.handleEvent({ type: 'key', key: 'down' });
  assert.equal(session.branchCursor, 1);
  session.handleEvent({ type: 'key', key: 'up' });
  assert.equal(session.branchCursor, 0);
  session.pushInput('j');
  assert.equal(session.branchCursor, 1);
  session.handleEvent({ type: 'key', key: 'home' });
  assert.equal(session.branchCursor, 0);
  session.handleEvent({ type: 'key', key: 'end' });
  assert.equal(session.branchCursor, session.branches.length - 1);
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.deepEqual(repo.checkouts, ['feat']);
  assert.equal(session.pane, 'files');
  assert.match(session.status, /checked out feat/);
});

test('branch list p pulls and s pushes', () => {
  const a = sampleItem('a.js');
  const b = sampleItem('b.js');
  const { session, repo } = openSession([a, b], { startPane: 'files' });
  session.pushInput('b');
  assert.equal(repo.listed.length, 1);
  session.pushInput('p');
  assert.equal(repo.pulls.length, 1);
  assert.equal(repo.listed.length, 2);
  assert.equal(session.status, 'pulled');
  assert.equal(session.pane, 'branches');
  session.pushInput('s');
  assert.equal(repo.pushes.length, 1);
  assert.equal(repo.listed.length, 3);
  assert.equal(session.status, 'pushed');
  session.handleEvent({ type: 'key', key: 'down' });
  session.pushInput('p');
  assert.equal(repo.pulls.length, 1);
  session.pushInput('s');
  assert.equal(repo.pushes.length, 1);
  session.handleEvent({ type: 'key', key: 'up' });
  session.pushInput('p');
  assert.equal(repo.pulls.length, 2);
});

test('rejected push asks f to force or escape to cancel', () => {
  const { session, repo } = openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.repo.push = (top, force) => {
    if (force) {
      repo.pushes.push(true);
      return;
    }
    const error = new Error('non-fast-forward');
    error.rejected = true;
    throw error;
  };
  session.pushInput('b');
  session.pushInput('s');
  assert.equal(session.mode, 'confirmPush');
  assert.equal(repo.pushes.length, 0);
  session.pushInput('x');
  assert.equal(session.mode, 'confirmPush');
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.mode, 'review');
  assert.equal(repo.pushes.length, 0);
  session.pushInput('s');
  session.pushInput('f');
  assert.deepEqual(repo.pushes, [true]);
  assert.equal(session.mode, 'review');
  assert.equal(session.status, 'force pushed');
});

test('click force push prompt', () => {
  const { session, repo } = openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.repo.push = (top, force) => {
    if (force) {
      repo.pushes.push(true);
      return;
    }
    const error = new Error('non-fast-forward');
    error.rejected = true;
    throw error;
  };
  session.pushInput('b');
  session.pushInput('s');
  clickStatusChoice(session, 'f');
  assert.deepEqual(repo.pushes, [true]);
  assert.equal(session.mode, 'review');
});

test('pull shows progress until git finishes', async () => {
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const { session, repo } = openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.repo.pullAsync = () => pending;
  session.pushInput('b');
  session.pushInput('p');
  assert.equal(repo.pulls.length, 0);
  assert.equal(session.busy, 'pulling');
  assert.equal(session.viewStatus(), 'pulling');
  assert.equal(session.progressFrame, 0);
  session.tickProgress();
  assert.equal(session.progressFrame, 1);
  session.pushInput('p');
  finish();
  await pending;
  await Promise.resolve();
  assert.equal(session.status, 'pulled');
  assert.equal(session.busy, '');
  assert.equal(session.gitBusy, false);
});

test('npm i shows progress until install finishes', async () => {
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const { session } = openSession([sampleItem('a.js')], {
    startPane: 'diff',
  });
  session.uiOpen = true;
  const item = session.current();
  item.reload = true;
  item.dep = {
    change: { propose: true, name: 'lodash' },
    files: ['package.json'],
  };
  session.repo.addAsync = () => pending;
  session.dispatch('add');
  assert.equal(session.current().origin, 'staged');
  assert.equal(session.busy, 'npm i');
  session.tickProgress();
  assert.equal(session.progressFrame, 1);
  finish();
  await pending;
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.equal(session.status, 'staged');
  assert.equal(session.busy, '');
});

test('stage moves on while npm install is still running', async () => {
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const proposed = sampleItem('package.json');
  proposed.reload = true;
  proposed.dep = {
    change: { propose: true, name: 'lodash' },
    files: ['package.json'],
  };
  const other = sampleItem('b.js');
  const { session, repo } = openSession([proposed, other]);
  session.uiOpen = true;
  let installs = 0;
  session.repo.addAsync = () => {
    installs += 1;
    return pending;
  };
  session.repo.add = (top, item) => {
    repo.added.push(item);
  };
  session.dispatch('add');
  assert.equal(session.items[0].origin, 'staged');
  assert.equal(installs, 0);
  session.dispatch('next');
  session.dispatch('add');
  assert.equal(session.items[1].origin, 'staged');
  assert.equal(repo.added.length, 0);
  await Promise.resolve();
  assert.equal(installs, 1);
  assert.equal(repo.added.length, 0);
  finish();
  await pending;
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.equal(repo.added.length, 1);
  assert.equal(repo.added[0].file.newPath, 'b.js');
  assert.equal(session.busy, '');
});

test('openLoad shows progress while a remote change loads', async () => {
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const item = sampleItem('lib/a.js', 'pr');
  const cwd = tempDir('reslop-ui-');
  const session = new Session({
    cwd,
    stdout: uiSink(),
    color: false,
    startPane: 'files',
    repo: {
      load: () => ({ items: [] }),
      loadAsync: async () => {
        await pending;
        return {
          items: [item],
          sourceLabel: '#123',
          change: {
            source: 'pr',
            repository: 'acme/app',
            number: 123,
          },
        };
      },
    },
  });
  session.uiOpen = true;
  const ready = session.openLoad();
  assert.equal(session.busy, 'loading');
  session.tickProgress();
  assert.equal(session.progressFrame, 1);
  finish();
  await ready;
  assert.equal(session.busy, '');
  assert.equal(session.items.length, 1);
  assert.equal(session.sourceLabel, '#123');
  assert.equal(session.repoName, 'acme/app');
});

test('checkout shows progress until git finishes', async () => {
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const { session, repo } = openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.uiOpen = true;
  session.repo.checkoutAsync = async (top, name) => {
    await pending;
    repo.checkouts.push(name);
  };
  session.pushInput('b');
  session.pushInput('j');
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(repo.checkouts.length, 0);
  assert.equal(session.busy, 'checking out');
  session.tickProgress();
  assert.equal(session.progressFrame, 1);
  finish();
  await pending;
  await Promise.resolve();
  assert.deepEqual(repo.checkouts, ['feat']);
  assert.match(session.status, /checked out feat/);
  assert.equal(session.busy, '');
});

test('commit shows progress until git finishes', async () => {
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const { session, repo } = openSession([sampleItem('a.js', 'staged')], {
    startPane: 'files',
  });
  session.uiOpen = true;
  session.repo.commitAsync = async (top, kind, message) => {
    await pending;
    repo.commits.push({ top, kind, message });
  };
  session.pushInput('c');
  session.pushInput('c');
  session.pushInput('land the change');
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(repo.commits.length, 0);
  assert.equal(session.busy, 'committing');
  session.tickProgress();
  assert.equal(session.progressFrame, 1);
  finish();
  await pending;
  await Promise.resolve();
  assert.equal(repo.commits.length, 1);
  assert.equal(session.status, 'committed');
  assert.equal(session.busy, '');
});

test('files pane u unstages', () => {
  const item = sampleItem('a.js', 'staged');
  const { session, repo } = openSession([item], { startPane: 'files' });
  session.dispatch('next');
  session.pushInput('u');
  assert.equal(repo.unstageCalls.length, 1);
  assert.equal(session.status, 'unstaged');
});

test('files pane f and d switch file and diff scope', () => {
  const item = sampleItem('a.js', 'staged');
  const { session, repo } = openSession([item], { startPane: 'files' });
  session.dispatch('next');
  session.pushInput('f');
  assert.equal(session.fileScope, 'file');
  assert.equal(session.status, 'file scope');
  assert.equal(repo.unstageCalls.length, 0);
  session.pushInput('d');
  assert.equal(session.fileScope, 'diff');
  assert.equal(session.status, 'diff mode');
  assert.equal(repo.unstageCalls.length, 0);
  assert.equal(repo.reverted.length, 0);
});

test('unit scope lists every file sorted by path', () => {
  const { session, repo } = openSession([sampleItem('b.js')], {
    startPane: 'files',
  });
  repo.extraFiles.push('a.js', 'z.js');
  session.dispatch('file');
  const names = session.fileList().map((entry) => entry.path);
  assert.deepEqual(names, [
    'Project Backlog and Issues',
    'a.js',
    'b.js',
    'z.js',
  ]);
});

test('unit view shows the file with current block marks', () => {
  const first = sampleItem('a.js');
  const second = sampleItem('a.js');
  second.blockId = 1;
  second.hunk = {
    oldStart: 3,
    oldCount: 1,
    newStart: 3,
    newCount: 1,
    header: '@@ -3,1 +3,1 @@',
    lines: [
      { type: 'del', text: 'c', noNl: false, blockId: 1 },
      { type: 'add', text: 'd', noNl: false, blockId: 1 },
    ],
  };
  const { session, repo } = openSession([first, second], {
    startPane: 'files',
  });
  repo.fileBodies['a.js'] = 'b\nkeep\nd\n';
  session.dispatch('file');
  session.dispatch('next');
  session.dispatch('open');
  assert.equal(session.pane, 'unit');
  const view = session.view();
  const types = view.unitLines.map((line) => `${line.type}:${line.text}`);
  assert.deepEqual(types, ['del:a', 'add:b', 'ctx:keep', 'del:c', 'add:d']);
  assert.equal(session.unitLine, 0);
  session.dispatch('next');
  assert.equal(session.unitLine, 3);
  assert.equal(session.current(), second);
  session.dispatch('prev');
  assert.equal(session.unitLine, 0);
  session.scroll = 5;
  session.handleEvent({ type: 'key', key: 'up' });
  assert.equal(session.scroll, 4);
  session.handleEvent({ type: 'key', key: 'down' });
  assert.equal(session.scroll, 5);
});

test('unit view marks every block in the current hunk', () => {
  const [first, second] = hunkPair('a.js');
  const { session, repo } = openSession([first, second], {
    startPane: 'files',
  });
  repo.fileBodies['a.js'] = 'A\nmid\nC\n';
  session.dispatch('file');
  session.dispatch('next');
  session.dispatch('open');
  session.draw();
  const body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /- a/);
  assert.match(body, /\+ A/);
  assert.match(body, /- c/);
  assert.match(body, /\+ C/);
  session.dispatch('add');
  assert.equal(repo.added.length, 2);
  assert.equal(session.items[0].origin, 'staged');
  assert.equal(session.items[1].origin, 'staged');
});

test('file scope next scrolls the whole block into view', () => {
  const first = sampleItem('a.js');
  const second = sampleItem('a.js');
  second.blockId = 1;
  const adds = [];
  for (let i = 0; i < 5; i++) {
    adds.push({ type: 'add', text: `chg${i}`, noNl: false, blockId: 1 });
  }
  second.hunk = {
    oldStart: 40,
    oldCount: 0,
    newStart: 40,
    newCount: 5,
    header: '@@ -40,0 +40,5 @@',
    lines: adds,
  };
  const rows = ['b'];
  for (let i = 2; i < 40; i++) rows.push(`keep${i}`);
  for (let i = 0; i < 5; i++) rows.push(`chg${i}`);
  rows.push('tail');
  const { session, repo } = openSession([first, second], {
    startPane: 'files',
  });
  repo.fileBodies['a.js'] = `${rows.join('\n')}\n`;
  session.dispatch('file');
  session.dispatch('next');
  session.dispatch('open');
  session.draw();
  session.dispatch('next');
  session.draw();
  const body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /chg0/);
  assert.match(body, /chg4/);
  const page = session.lastFrame.bodyH;
  assert.equal(session.scroll, 46 - page + 1);
  assert.match(body, /keep39/);
  assert.match(body, /tail/);
});

test('file scope next pins an oversized block at its start', () => {
  const first = sampleItem('a.js');
  const second = sampleItem('a.js');
  second.blockId = 1;
  const adds = [];
  for (let i = 0; i < 40; i++) {
    adds.push({ type: 'add', text: `chg${i}`, noNl: false, blockId: 1 });
  }
  second.hunk = {
    oldStart: 40,
    oldCount: 0,
    newStart: 40,
    newCount: 40,
    header: '@@ -40,0 +40,40 @@',
    lines: adds,
  };
  const rows = ['b'];
  for (let i = 2; i < 40; i++) rows.push(`keep${i}`);
  for (let i = 0; i < 40; i++) rows.push(`chg${i}`);
  rows.push('tail');
  const { session, repo } = openSession([first, second], {
    startPane: 'files',
  });
  repo.fileBodies['a.js'] = `${rows.join('\n')}\n`;
  session.dispatch('file');
  session.dispatch('next');
  session.dispatch('open');
  session.draw();
  session.dispatch('next');
  session.draw();
  const body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /chg0/);
  assert.equal(body.includes('chg39'), false);
  assert.equal(session.scroll, 41);
});

test('unit view e edits the whole file and autosaves', () => {
  const { session, repo } = openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  repo.fileBodies['a.js'] = 'b\n';
  session.dispatch('file');
  session.dispatch('next');
  session.dispatch('open');
  session.dispatch('code');
  assert.equal(session.composeKind, 'file');
  session.editor.replace('edited\n');
  session.autosave();
  assert.equal(repo.writes.length, 1);
  assert.equal(repo.writes[0].text, 'edited\n');
  assert.equal(repo.fileBodies['a.js'], 'edited\n');
  assert.equal(repo.stagedPaths.length, 0);
  session.composer.saveCompose();
  assert.deepEqual(repo.stagedPaths, ['a.js']);
  assert.equal(session.status, 'staged');
});

test('file compose keeps del and add highlighting', () => {
  const { session, repo } = openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  repo.fileBodies['a.js'] = 'b\nkeep\n';
  session.dispatch('file');
  session.dispatch('next');
  session.dispatch('open');
  session.dispatch('code');
  const types = session
    .view()
    .unitLines.map((line) => `${line.type}:${line.text}`);
  assert.deepEqual(types, ['del:a', 'add:b', 'ctx:keep', 'ctx:']);
  const del = session.view().unitLines[0];
  const add = session.view().unitLines[1];
  assert.equal(del.editStart, undefined);
  assert.equal(add.editStart, 0);
  session.editor.insert('x');
  const after = session
    .view()
    .unitLines.map((line) => `${line.type}:${line.text}`);
  assert.deepEqual(after, ['del:a', 'add:xb', 'ctx:keep', 'ctx:']);
});

test('file compose cursor stays on a trailing empty line', () => {
  const { session, repo } = openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  repo.fileBodies['a.js'] = 'b\nkeep\n';
  session.dispatch('file');
  session.dispatch('next');
  session.dispatch('open');
  session.dispatch('code');
  session.editor.cursor = session.editor.text.length;
  session.draw();
  assert.ok(session.lastFrame.cursor);
  const lines = session.view().unitLines;
  const last = lines[lines.length - 1];
  assert.equal(last.text, '');
  assert.equal(last.editLast, true);
});

test('file compose scroll follows the editor cursor', () => {
  const { session, repo } = openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push(`line${i}`);
  repo.fileBodies['a.js'] = `${rows.join('\n')}\n`;
  session.dispatch('file');
  session.dispatch('next');
  session.dispatch('open');
  session.dispatch('code');
  session.scroll = 0;
  session.editor.cursor = 0;
  for (let i = 0; i < 30; i++) session.composer.handleKey('down');
  const downScroll = session.scroll;
  assert.ok(downScroll > 0);
  session.editor.cursor = 0;
  session.composer.handleKey('up');
  assert.ok(session.scroll < downScroll);
  assert.ok(session.unitLine + 1 >= session.scroll);
});

test('unit view reloads disk text in view and edit', () => {
  const { session, repo } = openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  repo.fileBodies['a.js'] = 'b\n';
  session.dispatch('file');
  session.dispatch('next');
  session.dispatch('open');
  repo.fileBodies['a.js'] = 'from-disk\n';
  const view = session.view();
  assert.ok(view.unitLines.some((line) => line.text === 'from-disk'));
  session.dispatch('code');
  repo.fileBodies['a.js'] = 'later\n';
  session.composer.applyDiskText('later\n');
  assert.equal(session.editor.text, 'later\n');
});

test('branch list n creates a new branch', () => {
  const { session, repo } = openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('b');
  session.pushInput('n');
  assert.equal(session.pane, 'branches');
  assert.equal(session.mode, 'compose');
  assert.equal(session.composeKind, 'branch');
  session.pushInput('topic');
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.deepEqual(repo.created, ['topic']);
  assert.equal(repo.listed.length, 2);
  assert.equal(session.pane, 'files');
  assert.equal(session.mode, 'review');
  assert.match(session.status, /created topic/);
});

test('branch list r rebases current onto selected', () => {
  const { session, repo } = openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('b');
  session.pushInput('r');
  assert.equal(repo.rebases.length, 0);
  session.dispatch('next');
  session.pushInput('r');
  assert.deepEqual(repo.rebases, ['feat']);
  assert.equal(repo.listed.length, 2);
  assert.match(session.status, /rebased onto feat/);
  assert.equal(session.pane, 'branches');
});

test('branch list d asks to drop the selected branch', () => {
  const { session, repo } = openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('b');
  session.pushInput('d');
  assert.equal(session.mode, 'review');
  assert.equal(repo.drops.length, 0);
  session.dispatch('next');
  session.pushInput('d');
  assert.equal(session.mode, 'confirmDrop');
  assert.equal(session.dropName, 'feat');
  session.pushInput('n');
  assert.equal(session.mode, 'review');
  assert.equal(repo.drops.length, 0);
  session.pushInput('d');
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.mode, 'review');
  assert.equal(repo.drops.length, 0);
  session.pushInput('d');
  session.pushInput('y');
  assert.deepEqual(repo.drops, ['feat']);
  assert.match(session.status, /dropped feat/);
  assert.equal(session.pane, 'branches');
});

test('click drop prompt y and n', () => {
  const { session, repo } = openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  session.pushInput('b');
  session.dispatch('next');
  session.pushInput('d');
  clickStatusChoice(session, 'n');
  assert.equal(session.mode, 'review');
  assert.equal(repo.drops.length, 0);
  session.pushInput('d');
  clickStatusChoice(session, 'y');
  assert.deepEqual(repo.drops, ['feat']);
});

test('escape from branch list returns to files', () => {
  const { session } = openSession([sampleItem('a.js')], { startPane: 'files' });
  session.pushInput('b');
  assert.equal(session.pane, 'branches');
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.pane, 'files');
});

test('read only blocks branch pull and push', () => {
  const { session, repo } = openSession([sampleItem('a.js')], {
    startPane: 'files',
    readOnly: true,
  });
  session.pushInput('b');
  assert.equal(session.pane, 'files');
  assert.equal(session.status, 'read only');
  session.pushInput('p');
  assert.equal(repo.pulls.length, 0);
  session.pushInput('s');
  assert.equal(repo.pushes.length, 0);
});

test('ops runner releases busy if after throws', async () => {
  const runner = createOpsRunner({
    top: '/tmp',
    done: false,
    mode: 'review',
    status: '',
    paint: () => {},
    startProgress: () => {},
    stopProgress: () => {},
  });
  await assert.rejects(
    () =>
      runner.runBusy(
        'pulling',
        'pulled',
        async () => {},
        () => {
          throw new Error('follow-up failed');
        },
      ),
    /follow-up failed/,
  );
  assert.equal(runner.gitBusy, false);
  assert.equal(runner.busy, '');
});

test('partial file add reloads after a later hunk fails', () => {
  const first = sampleItem('a.js');
  const second = sampleItem('a.js');
  second.blockId = 1;
  second.hunk = {
    ...second.hunk,
    oldStart: 10,
    newStart: 10,
    header: '@@ -10,1 +10,1 @@',
  };
  const other = sampleItem('b.js');
  const staged = new Set();
  let loads = 0;
  const snapshot = () => {
    loads += 1;
    const a1 = { ...first, origin: staged.has(0) ? 'staged' : 'unstaged' };
    const a2 = {
      ...second,
      origin: staged.has(1) ? 'staged' : 'unstaged',
      blockId: 1,
      hunk: second.hunk,
    };
    return { top: '/tmp', items: [a1, a2, other], branch: 'main' };
  };
  const repo = {
    load: snapshot,
    add: (top, item) => {
      if (item.blockId === 1) throw new Error('patch failed');
      staged.add(item.blockId ?? 0);
    },
    unstage: () => {},
    revert: () => {},
    revertFile: () => {},
  };
  const { session } = openSession([first, second, other], {
    startPane: 'files',
    repo,
  });
  const before = loads;
  session.dispatch('next');
  session.dispatch('add');
  assert.equal(session.status, 'patch failed');
  assert.ok(loads > before);
  assert.equal(session.items[0].origin, 'staged');
  assert.equal(session.items[1].origin, 'unstaged');
  assert.equal(session.items[1].blockId, 1);
});

const clickAt = (session, x, y) => {
  session.handleEvent({
    type: 'mouse',
    kind: 'press',
    btn: 0,
    button: 0,
    x,
    y,
    press: true,
  });
  session.handleEvent({
    type: 'mouse',
    kind: 'release',
    btn: 0,
    button: 0,
    x,
    y,
    press: false,
  });
};

test('x and a checkbox click toggle a todo and the file keeps it', () => {
  const { session } = openSession([sampleItem('a.js')]);
  session.dispatch('todo');
  session.pushInput('ship it');
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.mode, 'review');
  session.draw();
  let body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /\[ \] ship it/);
  session.pushInput('x');
  assert.equal(session.notes.todos[0].done, true);
  session.draw();
  body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /\[x\] ship it/);
  assert.match(body, /→ {2}x/);
  assert.ok(!body.includes(' q'));
  session.pushInput(' ');
  assert.equal(session.notes.todos[0].done, false);
  session.draw();
  const box = session.lastFrame.todoHits.find((row) => row.check);
  assert.ok(box);
  clickAt(session, box.x0 + 1, box.y);
  assert.equal(session.mode, 'review');
  assert.equal(session.notes.todos[0].done, true);
  assert.equal(session.notes.todos[0].text, 'ship it');
  const loaded = parseReview(
    serializeReview(session.notes),
    session.notes.reviewPath,
  );
  assert.equal(loaded.todos[0].done, true);
  assert.equal(loaded.todos[0].text, 'ship it');
  session.handleEvent({ type: 'key', key: 'enter' });
  session.handleEvent({ type: 'key', key: 'x' });
  session.handleEvent({ type: 'key', key: ' ' });
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'ship itx ');
  assert.equal(session.notes.todos[0].done, true);
});

test('l toggles the theme and is typed as text while composing', () => {
  const { session } = openSession([sampleItem('a.js')]);
  try {
    session.pushInput('l');
    assert.equal(themeName(), 'light');
    assert.equal(session.status, 'light');
    session.pushInput('l');
    assert.equal(themeName(), 'dark');
    assert.equal(session.status, 'dark');
    session.dispatch('feedback');
    session.handleEvent({ type: 'key', key: 'l' });
    assert.equal(session.mode, 'compose');
    assert.equal(session.editor.text, 'l');
    assert.equal(themeName(), 'dark');
  } finally {
    setTheme('dark');
  }
});

test('files pane n opens npm scripts and bins', () => {
  const { session, cwd, repo } = openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({
      scripts: { test: 'node --test', lint: 'eslint .' },
      dependencies: { leftpad: '1.0.0' },
    })}\n`,
  );
  const dep = path.join(cwd, 'node_modules', 'leftpad');
  fs.mkdirSync(dep, { recursive: true });
  fs.writeFileSync(
    path.join(dep, 'package.json'),
    `${JSON.stringify({ name: 'leftpad', bin: { leftpad: 'bin.js' } })}\n`,
  );
  session.pushInput('n');
  assert.equal(session.pane, 'npm');
  session.draw();
  let body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /test/);
  assert.match(body, /lint/);
  assert.match(body, /leftpad/);
  assert.match(body, /: npm/);
  assert.ok(!body.includes(' q'));
  session.pushInput('e');
  assert.equal(session.mode, 'compose');
  assert.equal(session.editor.text, 'test: node --test');
  session.editor.replace('nope');
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.mode, 'compose');
  assert.equal(session.status, 'name: command');
  session.editor.replace('test: node --test test');
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.mode, 'review');
  const file = path.join(cwd, 'package.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.scripts.test, 'node --test test');
  session.handleEvent({ type: 'key', key: 'ctrl-down' });
  const order = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(order.scripts), ['lint', 'test']);
  session.handleEvent({ type: 'key', key: 'delete' });
  assert.equal(session.mode, 'confirmDrop');
  session.pushInput('n');
  assert.equal(session.mode, 'review');
  assert.equal(order.scripts.lint, 'eslint .');
  session.handleEvent({ type: 'key', key: 'end' });
  session.pushInput('e');
  assert.equal(session.status, 'not a script');
  session.handleEvent({ type: 'key', key: 'home' });
  const ran = [];
  repo.runNpmCommand = (root, entry, onData, onClose) => {
    ran.push(entry.name);
    const lines = [
      '✔ passes',
      `${root}/lib/app.js:4`,
      '✖ fails',
      'Error: boom',
    ];
    const text = lines.join('\n');
    onData(text);
    onClose({ status: 1, text });
    return { kill() {} };
  };
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.deepEqual(ran, ['lint']);
  session.draw();
  body = stripAnsi(session.lastFrame.rows.join('\n'));
  assert.match(body, /lib\/app\.js:4/);
  assert.match(body, /Error: boom/);
  assert.match(body, /exit 1/);
  assert.ok(!body.includes('✔'));
  assert.ok(!body.includes(cwd));
  const stamp = dateStamp();
  const logPath = path.join(cwd, '.log', `${stamp}-lint-01.log`);
  const log = fs.readFileSync(logPath, 'utf8');
  assert.match(log, /exit 1/);
  assert.ok(!log.includes('✔'));
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.pane, 'npm');
  assert.equal(session.view().npmView, false);
  session.pushInput('q');
  assert.equal(session.done, true);
});

const frameBody = (session) => {
  session.draw();
  const bodyH = session.lastFrame.bodyH;
  const rows = session.lastFrame.rows.slice(1, 1 + bodyH);
  return rows.map((row) => stripAnsi(row));
};

test('esc stops a running npm command and waits to leave', () => {
  const { session, cwd, repo } = openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({ scripts: { test: 'node --test' } })}\n`,
  );
  let close = null;
  let push = null;
  let killed = false;
  let starts = 0;
  repo.runNpmCommand = (root, entry, onData, onClose) => {
    starts += 1;
    push = onData;
    onData('hello\n');
    close = onClose;
    return {
      kill() {
        killed = true;
      },
    };
  };
  session.pushInput('n');
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.view().npmRunning, true);
  session.draw();
  const footer = () => stripAnsi(session.lastFrame.rows.at(-1));
  const hitIds = () => session.lastFrame.buttons.map((hit) => hit.id);
  assert.match(footer(), / esc /);
  assert.match(footer(), / re-run/);
  assert.ok(!footer().includes('edit'));
  assert.ok(!footer().includes('new'));
  assert.ok(hitIds().includes('npmStop'));
  assert.ok(!hitIds().includes('npmRerun'));
  session.handleEvent({ type: 'key', key: 'r' });
  assert.equal(starts, 1);
  assert.equal(session.view().npmRunning, true);
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(killed, true);
  assert.equal(session.view().npmView, true);
  assert.equal(session.view().npmRunning, false);
  assert.equal(session.status, 'terminated');
  let text = frameBody(session).join('\n');
  assert.match(text, /hello/);
  assert.match(text, /terminated/);
  push('hello\nmore\n');
  text = frameBody(session).join('\n');
  assert.match(text, /hello/);
  assert.match(text, /terminated/);
  assert.ok(!text.includes('more'));
  close({ status: null, text: 'hello\nlate\n' });
  assert.equal(session.view().npmView, true);
  text = frameBody(session).join('\n');
  assert.match(text, /hello/);
  assert.match(text, /terminated/);
  assert.ok(!text.includes('late'));
  assert.ok(!text.includes('more'));
  assert.ok(!text.includes('exit null'));
  session.draw();
  let hits = hitIds();
  assert.ok(hits.includes('npmStop'));
  assert.ok(hits.includes('npmRerun'));
  assert.ok(!hits.includes('npmEdit'));
  const runs = [];
  repo.runNpmCommand = (root, entry, onData, onClose) => {
    runs.push(entry.name);
    onData('again\n');
    return {
      kill() {
        onClose({ status: null, text: 'again\n' });
      },
    };
  };
  session.handleEvent({ type: 'key', key: 'r' });
  assert.deepEqual(runs, ['test']);
  assert.equal(session.view().npmRunning, true);
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.view().npmView, true);
  assert.equal(session.status, 'terminated');
  session.draw();
  hits = hitIds();
  assert.ok(hits.includes('npmStop'));
  session.handleEvent({ type: 'key', key: 'escape' });
  assert.equal(session.view().npmView, false);
  assert.equal(session.pane, 'npm');
});

test('npm output scrolls with the editor hotkeys', () => {
  const { session, cwd, repo } = openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({ scripts: { test: 'node --test' } })}\n`,
  );
  const lines = [];
  for (let i = 0; i < 80; i++) lines.push(`row ${i}`);
  let push = null;
  repo.runNpmCommand = (root, entry, onData, onClose) => {
    push = onData;
    onData(lines.join('\n'));
    onClose({ status: 0, text: lines.join('\n') });
    return { kill() {} };
  };
  session.pushInput('n');
  session.handleEvent({ type: 'key', key: 'enter' });
  session.draw();
  const page = logViewRows(session.lastFrame.bodyH);
  assert.ok(page > 1);
  const half = Math.max(1, Math.floor(page * 0.5));
  const at = () => session.view().npmScroll;
  session.handleEvent({ type: 'key', key: 'home' });
  assert.equal(at(), 0);
  assert.equal(session.view().npmFollow, false);
  session.handleEvent({ type: 'key', key: 'up' });
  assert.equal(at(), 0);
  session.handleEvent({ type: 'key', key: 'down' });
  assert.equal(at(), 1);
  session.handleEvent({ type: 'key', key: 'ctrl-y' });
  assert.equal(at(), 0);
  session.handleEvent({ type: 'key', key: 'ctrl-e' });
  assert.equal(at(), 1);
  session.handleEvent({ type: 'key', key: 'home' });
  session.handleEvent({ type: 'key', key: 'ctrl-f' });
  assert.equal(at(), page);
  session.handleEvent({ type: 'key', key: 'ctrl-b' });
  assert.equal(at(), 0);
  session.handleEvent({ type: 'key', key: 'ctrl-d' });
  assert.equal(at(), half);
  session.handleEvent({ type: 'key', key: 'ctrl-u' });
  assert.equal(at(), 0);
  session.handleEvent({ type: 'key', key: 'pageDown' });
  assert.equal(at(), page);
  session.handleEvent({ type: 'key', key: 'pageUp' });
  assert.equal(at(), 0);
  session.handleEvent({ type: 'key', key: 'end' });
  assert.equal(session.view().npmFollow, true);
  session.handleEvent({ type: 'key', key: 'up' });
  assert.equal(session.view().npmFollow, false);
  const stayed = at();
  push('row extra\n');
  assert.equal(at(), stayed);
  assert.equal(session.view().npmFollow, false);
  const body = frameBody(session);
  assert.equal(body[0].trim(), '');
  assert.equal(body[body.length - 1].trim(), '');
  assert.match(body[1], /^ {2}row /);
});

test('npm output animates progress until the command exits', () => {
  const { session, cwd, repo } = openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({ scripts: { test: 'node --test' } })}\n`,
  );
  let finish = null;
  repo.runNpmCommand = (root, entry, onData, onClose) => {
    onData('hello\n');
    finish = () => onClose({ status: 0, text: 'hello\n' });
    return {
      kill() {
        finish();
      },
    };
  };
  session.pushInput('n');
  session.handleEvent({ type: 'key', key: 'enter' });
  assert.equal(session.view().npmRunning, true);
  assert.equal(session.progress.size(), 1);
  let body = frameBody(session);
  const hello = body.findIndex((row) => row.includes('hello'));
  assert.match(body[hello + 1], /^ {2}running {2}·•●•·/);
  session.tickProgress();
  body = frameBody(session);
  assert.match(body[hello + 1], /^ {2}running {2}··•●•/);
  finish();
  body = frameBody(session);
  assert.equal(session.view().npmRunning, false);
  assert.equal(session.progress.size(), 0);
  const text = body.join('\n');
  assert.match(text, /hello/);
  assert.match(text, /exit 0/);
  assert.ok(!text.includes('running'));
});

test('npm screen refuses edits when read only', () => {
  const { session, cwd } = openSession([sampleItem('a.js')], {
    startPane: 'files',
    readOnly: true,
  });
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({ scripts: { test: 'node --test' } })}\n`,
  );
  session.pushInput('n');
  session.pushInput('e');
  assert.equal(session.status, 'read only');
  assert.equal(session.mode, 'review');
  session.pushInput('n');
  assert.equal(session.status, 'read only');
  session.handleEvent({ type: 'key', key: 'delete' });
  assert.equal(session.mode, 'review');
  session.handleEvent({ type: 'key', key: 'd' });
  assert.equal(session.status, 'read only');
  assert.equal(session.mode, 'review');
  session.handleEvent({ type: 'key', key: 'c' });
  assert.equal(session.status, 'read only');
  assert.equal(session.mode, 'review');
});

test('double click runs the selected npm command', () => {
  const { session, cwd, repo } = openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({
      scripts: { test: 'node --test', lint: 'eslint .' },
    })}\n`,
  );
  const ran = [];
  repo.runNpmCommand = (root, entry, onData, onClose) => {
    ran.push(entry.name);
    onClose({ status: 0, text: '' });
    return { kill() {} };
  };
  session.pushInput('n');
  session.draw();
  const hits = session.lastFrame.fileHits;
  assert.ok(hits.length >= 2);
  clickAt(session, 2, hits[1].y);
  assert.deepEqual(ran, []);
  assert.equal(session.npmCursor, hits[1].cursor);
  clickAt(session, 2, hits[1].y);
  assert.deepEqual(ran, ['lint']);
  assert.equal(session.view().npmView, true);
});

test('d deletes the selected npm script after confirmation', () => {
  const { session, cwd } = openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  const file = path.join(cwd, 'package.json');
  fs.writeFileSync(
    file,
    `${JSON.stringify({
      scripts: { test: 'node --test', lint: 'eslint .' },
    })}\n`,
  );
  session.pushInput('n');
  session.draw();
  const footer = stripAnsi(session.lastFrame.rows.at(-1));
  assert.match(footer, /edit {2}new {2}delete {2}cleanup/);
  session.handleEvent({ type: 'key', key: 'd' });
  assert.equal(session.mode, 'confirmDrop');
  session.pushInput('y');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.scripts.test, undefined);
  assert.equal(saved.scripts.lint, 'eslint .');
  assert.equal(session.status, 'dropped test');
});

const daysAgoStamp = (ago) => {
  const date = new Date();
  date.setDate(date.getDate() - ago);
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  const d = `${date.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
};

test('npm screen deletes logs older than 5 days', () => {
  const { session, cwd } = openSession([sampleItem('a.js')], {
    startPane: 'files',
  });
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    `${JSON.stringify({ scripts: { test: 'node --test' } })}\n`,
  );
  const dir = path.join(cwd, '.log');
  fs.mkdirSync(dir);
  const stale = path.join(dir, `${daysAgoStamp(6)}-test-01.log`);
  const kept = path.join(dir, `${daysAgoStamp(5)}-test-01.log`);
  fs.writeFileSync(stale, 'abcdef');
  fs.writeFileSync(kept, 'keep');
  session.pushInput('n');
  session.draw();
  const status = () => stripAnsi(session.lastFrame.rows.at(-2));
  assert.match(status(), /old logs 6b/);
  session.handleEvent({ type: 'key', key: 'c' });
  assert.equal(session.mode, 'confirmDrop');
  session.draw();
  assert.match(status(), /drop logs older than 5 days \(6b\)\? y\/n/);
  session.pushInput('n');
  assert.equal(fs.existsSync(stale), true);
  session.handleEvent({ type: 'key', key: 'c' });
  session.pushInput('y');
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(kept), true);
  session.draw();
  assert.ok(!status().includes('old logs'));
  assert.equal(session.status, 'dropped logs');
  const hits = session.lastFrame.buttons.map((hit) => hit.id);
  assert.ok(!hits.includes('npmLogs'));
  assert.match(stripAnsi(session.lastFrame.rows.at(-1)), /cleanup/);
  session.handleEvent({ type: 'key', key: 'c' });
  assert.equal(session.status, 'dropped logs');
  assert.equal(session.mode, 'review');
});
