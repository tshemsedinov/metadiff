'use strict';

const helpers = require('./helpers.js');
const { sampleHunk, reviewView } = helpers;

const nodeTest = require('node:test');
const { test } = nodeTest;
const assert = require('node:assert/strict');

const diff = require('../lib/diff/diff.js');
const { displayLines } = diff;
const render = require('../lib/render/render.js');
const wrap = require('../lib/wrap.js');
const ansi = require('../lib/ansi.js');
const { THEME, CODE_FG, fg, bg, stripAnsi, BOLD, seq } = ansi;
const { ESC, RESET, EL, visibleWidth } = ansi;

test('AC2 muted line color differs from strong char color', () => {
  assert.notDeepEqual(THEME.delLineBg, THEME.delCharBg);
  assert.notDeepEqual(THEME.addLineBg, THEME.addCharBg);
  assert.notDeepEqual(THEME.delLineFg, THEME.delCharFg);
  assert.notDeepEqual(THEME.addLineFg, THEME.addCharFg);
  const hunk = sampleHunk([
    { type: 'del', text: 'hello world', noNl: false, blockId: 0 },
    { type: 'add', text: 'hello World', noNl: false, blockId: 0 },
  ]);
  const lines = displayLines(hunk, 0);
  const del = render.paintDiffLine(lines[0], 40, true, 'unstaged', 'txt');
  const add = render.paintDiffLine(lines[1], 40, true, 'unstaged', 'txt');
  assert.ok(del.includes(bg(THEME.delLineBg)));
  assert.ok(del.includes(bg(THEME.delCharBg)));
  assert.ok(add.includes(bg(THEME.addLineBg)));
  assert.ok(add.includes(bg(THEME.addCharBg)));
  assert.ok(del.includes(fg(CODE_FG.plain)));
  assert.ok(!del.includes(fg(THEME.delLineFg)));
  assert.ok(!add.includes(fg(THEME.addLineFg)));
  const view = reviewView({
    origin: 'unstaged',
    file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
    hunk,
    blockId: 0,
  });
  const frame = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: true,
  });
  assert.ok(frame.text.includes(render.delCharBg()));
  assert.ok(frame.text.includes(render.addCharBg()));
  assert.ok(frame.text.includes(fg(CODE_FG.variable)));
  assert.ok(!frame.text.includes(fg(THEME.delLineFg)));
  assert.equal(frame.rows.length, 16);
  assert.ok(!frame.text.includes('@@'));
  assert.match(render.headerText(view), /reslop: demo\/f\.js$/);
  assert.ok(!/\d+\/\d+/.test(render.headerText(view)));
});

test('AC27 side layout paints old left and new right', () => {
  const hunk = sampleHunk([
    { type: 'del', text: 'hello world', noNl: false, blockId: 0 },
    { type: 'add', text: 'hello World', noNl: false, blockId: 0 },
  ]);
  const view = reviewView(
    {
      origin: 'unstaged',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk,
      blockId: 0,
    },
    { pane: 'diff', layout: 'side' },
  );
  const width = 80;
  const frame = render.renderFrame(view, { width, height: 8, color: true });
  const gap = frame.rows[1];
  assert.equal(stripAnsi(gap).trim(), '');
  assert.ok(gap.includes(bg(THEME.splitGutterBg)));
  const row = frame.rows[2];
  const plain = stripAnsi(row);
  assert.equal(visibleWidth(plain), width);
  assert.match(plain, /-/);
  assert.match(plain, /\+/);
  assert.ok(!plain.includes('|'));
  assert.ok(!plain.includes('│'));
  const leftW = Math.floor((width - 1) / 2);
  assert.equal(plain[leftW], ' ');
  assert.ok(plain.slice(0, leftW).includes('hello world'));
  assert.ok(plain.slice(leftW + 1).includes('hello World'));
  assert.ok(row.includes(bg(THEME.delLineBg)));
  assert.ok(row.includes(bg(THEME.addLineBg)));
  assert.ok(row.includes(bg(THEME.splitGutterBg)));
  const blank = frame.rows[3];
  assert.ok(blank.includes(bg(THEME.splitGutterBg)));
  assert.deepEqual(THEME.splitGutterBg, THEME.chromeBg);
});

test('js toString paints in side layout', () => {
  const hunk = sampleHunk([
    { type: 'del', text: 'foo.toString()', noNl: false, blockId: 0 },
    { type: 'add', text: 'bar.toString()', noNl: false, blockId: 0 },
  ]);
  const view = reviewView(
    {
      origin: 'unstaged',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk,
      blockId: 0,
    },
    { pane: 'diff', layout: 'side' },
  );
  const frame = render.renderFrame(view, { width: 80, height: 8, color: true });
  const plain = stripAnsi(frame.rows[2]);
  assert.ok(plain.includes('foo.toString()'));
  assert.ok(plain.includes('bar.toString()'));
});

test('AC29 short diff leaves a gap under the header', () => {
  const addHunk = (n) => ({
    oldStart: 1,
    oldCount: 0,
    newStart: 1,
    newCount: n,
    header: `@@ -1,0 +1,${n} @@`,
    lines: Array.from({ length: n }, (_, i) => ({
      type: 'add',
      text: `line${i}`,
      noNl: false,
      blockId: 0,
    })),
  });
  const viewFor = (n, scroll) => ({
    pane: 'diff',
    item: {
      origin: 'unstaged',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk: addHunk(n),
      blockId: 0,
    },
    index: 0,
    total: 1,
    scroll,
    status: '',
    counts: { staged: 0, unstaged: 1, untracked: 0 },
    repoName: 'demo',
  });
  const opt = { width: 80, height: 8, color: true };
  const short = render.renderFrame(viewFor(1, 0), opt);
  assert.equal(stripAnsi(short.rows[1]).trim(), '');
  assert.ok(short.rows[1].includes(bg(THEME.ctxBg)));
  assert.match(stripAnsi(short.rows[2]), /\+ line0/);
  const full = render.renderFrame(viewFor(5, 0), opt);
  assert.equal(stripAnsi(full.rows[1]).trim(), '');
  assert.match(stripAnsi(full.rows[2]), /\+ line0/);
  const scrolled = render.renderFrame(viewFor(8, 1), opt);
  assert.match(stripAnsi(scrolled.rows[1]), /\+ line0/);
  const leadingBlank = render.renderFrame(
    {
      ...viewFor(1, 0),
      item: {
        ...viewFor(1, 0).item,
        hunk: {
          oldStart: 1,
          oldCount: 1,
          newStart: 2,
          newCount: 2,
          header: '@@ -1,1 +2,2 @@',
          lines: [
            { type: 'ctx', text: '', noNl: false, blockId: null },
            { type: 'add', text: 'line0', noNl: false, blockId: 0 },
          ],
        },
      },
    },
    opt,
  );
  assert.equal(stripAnsi(leadingBlank.rows[1]).trim(), '');
  assert.match(stripAnsi(leadingBlank.rows[2]), /\+ line0/);
  const leadingEmptyAdd = render.renderFrame(
    {
      ...viewFor(1, 0),
      item: {
        ...viewFor(1, 0).item,
        hunk: {
          oldStart: 1,
          oldCount: 0,
          newStart: 1,
          newCount: 2,
          header: '@@ -1,0 +1,2 @@',
          lines: [
            { type: 'add', text: '', noNl: false, blockId: 0 },
            { type: 'add', text: 'line0', noNl: false, blockId: 0 },
          ],
        },
      },
    },
    opt,
  );
  assert.equal(stripAnsi(leadingEmptyAdd.rows[1]).trim(), '');
  assert.match(stripAnsi(leadingEmptyAdd.rows[2]), /\+ line0/);
  const leadingCtx = render.renderFrame(
    {
      ...viewFor(1, 0),
      item: {
        ...viewFor(1, 0).item,
        hunk: {
          oldStart: 1,
          oldCount: 1,
          newStart: 1,
          newCount: 2,
          header: '@@ -1,1 +1,2 @@',
          lines: [
            { type: 'ctx', text: '  hold() {', noNl: false, blockId: null },
            { type: 'add', text: 'line0', noNl: false, blockId: 0 },
          ],
        },
      },
    },
    opt,
  );
  assert.equal(stripAnsi(leadingCtx.rows[1]).trim(), '');
  assert.match(stripAnsi(leadingCtx.rows[2]), /hold/);
  assert.match(stripAnsi(leadingCtx.rows[3]), /\+ line0/);
});

test('AC30 diff lines keep a two-column left gutter', () => {
  const hunk = {
    oldStart: 1,
    oldCount: 2,
    newStart: 1,
    newCount: 2,
    header: '@@ -1,2 +1,2 @@',
    lines: [
      { type: 'ctx', text: 'hold() {', noNl: false, blockId: null },
      { type: 'del', text: 'hello world', noNl: false, blockId: 0 },
      { type: 'add', text: 'hello World', noNl: false, blockId: 0 },
    ],
  };
  const lines = displayLines(hunk, 0);
  const ctx = stripAnsi(
    render.paintDiffLine(lines[0], 40, false, 'unstaged', 'txt'),
  );
  const del = stripAnsi(
    render.paintDiffLine(lines[1], 40, false, 'unstaged', 'txt'),
  );
  const add = stripAnsi(
    render.paintDiffLine(lines[2], 40, false, 'unstaged', 'txt'),
  );
  assert.equal(ctx.startsWith('  hold'), true);
  assert.equal(del.startsWith('- hello world'), true);
  assert.equal(add.startsWith('+ hello World'), true);
  const view = reviewView(
    {
      origin: 'unstaged',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk,
      blockId: 0,
    },
    { pane: 'diff', layout: 'side' },
  );
  const frame = render.renderFrame(view, {
    width: 80,
    height: 8,
    color: false,
  });
  const row = frame.rows[3];
  const leftW = Math.floor((80 - 1) / 2);
  assert.equal(row.slice(0, 2), '- ');
  assert.equal(row.slice(2, 13), 'hello world');
  assert.equal(row.slice(leftW + 1, leftW + 3), '+ ');
  assert.equal(row.slice(leftW + 3, leftW + 14), 'hello World');
});

test('AC23 staged lines are grey with plus and minus marks', () => {
  const hunk = sampleHunk([
    { type: 'del', text: 'hello world', noNl: false, blockId: 0 },
    { type: 'add', text: 'hello World', noNl: false, blockId: 0 },
  ]);
  const lines = displayLines(hunk, 0);
  const del = render.paintDiffLine(lines[0], 40, true, 'staged', 'txt');
  const add = render.paintDiffLine(lines[1], 40, true, 'staged', 'txt');
  assert.equal(stripAnsi(del).startsWith('-'), true);
  assert.equal(stripAnsi(add).startsWith('+'), true);
  assert.ok(del.includes(bg(THEME.stagedDelLineBg)));
  assert.ok(del.includes(bg(THEME.stagedDelCharBg)));
  assert.ok(add.includes(bg(THEME.stagedAddLineBg)));
  assert.ok(add.includes(bg(THEME.stagedAddCharBg)));
  assert.ok(del.includes(fg(CODE_FG.plain)));
  assert.ok(!del.includes(fg(THEME.delLineFg)));
  assert.ok(!del.includes(bg(THEME.delCharBg)));
  assert.ok(!add.includes(fg(THEME.addLineFg)));
  assert.ok(!add.includes(bg(THEME.addCharBg)));
  const view = {
    item: {
      origin: 'staged',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk,
      blockId: 0,
    },
    index: 0,
    total: 1,
    scroll: 0,
    status: '',
    counts: { staged: 1, unstaged: 0, untracked: 0 },
    repoName: 'demo',
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: true,
  });
  assert.ok(frame.text.includes(bg(THEME.stagedDelCharBg)));
  assert.ok(frame.text.includes(bg(THEME.stagedAddCharBg)));
  assert.ok(!frame.text.includes(render.delCharBg()));
  assert.ok(!frame.text.includes(render.addCharBg()));
  const plain = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: false,
  });
  assert.match(plain.text, /^-/m);
  assert.match(plain.text, /^\+/m);
});

test('footer keeps info status on the counts line', () => {
  const hunk = sampleHunk([
    { type: 'add', text: 'x', noNl: false, blockId: 0 },
  ]);
  const view = {
    item: {
      origin: 'unstaged',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk,
      blockId: 0,
    },
    index: 0,
    total: 1,
    scroll: 0,
    status: 'copied',
    counts: { staged: 0, unstaged: 1, untracked: 0 },
    repoName: 'demo',
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: false,
  });
  assert.equal(frame.rows.length, 16);
  const statusRow = frame.rows[frame.rows.length - 2];
  assert.match(statusRow, /0\/1/);
  assert.match(statusRow, /copied /);
  assert.equal(statusRow.endsWith(' '), true);
  const saved = render.renderFrame(
    { ...view, status: 'saved' },
    { width: 80, height: 16, color: false },
  );
  const savedRow = saved.rows[saved.rows.length - 2];
  assert.match(savedRow, /saved /);
  assert.equal(savedRow.endsWith(' '), true);
});

test('status line includes feedback todo and code counts', () => {
  const hunk = sampleHunk([
    { type: 'add', text: 'x', noNl: false, blockId: 0 },
  ]);
  const view = {
    item: {
      origin: 'unstaged',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk,
      blockId: 0,
    },
    index: 0,
    total: 1,
    scroll: 0,
    status: '',
    counts: {
      staged: 6,
      unstaged: 11,
      untracked: 0,
      feedback: 3,
      todo: 2,
      code: 1,
    },
    repoName: 'demo',
    branch: 'main',
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: false,
  });
  const statusRow = frame.rows[frame.rows.length - 2];
  assert.match(statusRow, /main {2}feedback 3 {2}todo 2 {2}code 1/);
  assert.ok(!statusRow.includes('['));
  assert.match(statusRow, /6\/17\s*$/);
  assert.ok(!statusRow.includes('untracked'));
  const notesAt = statusRow.indexOf('feedback 3');
  const ratioAt = statusRow.indexOf('6/17');
  assert.ok(notesAt < ratioAt);
  const colored = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: true,
  });
  const painted = colored.rows[colored.rows.length - 2];
  const chromeBg = bg(THEME.chromeBg);
  const white = `${fg(THEME.buttonHotFg)}${chromeBg}`;
  assert.ok(painted.includes(`${white}main`));
  assert.ok(!painted.includes(`${white}[`));
  assert.equal(frame.statusHits.length, 1);
  assert.equal(frame.statusHits[0].id, 'branch');
  assert.equal(frame.statusHits[0].y, frame.rows.length - 1);
  assert.equal(frame.statusHits[0].x0, 1);
  assert.equal(frame.statusHits[0].x1, 5);
});

test('status line includes repo +/- totals', () => {
  const files = [
    {
      path: 'a.js',
      status: 'unstaged',
      remaining: 4,
      staged: 0,
      added: 12,
      removed: 5,
    },
    {
      path: 'b.js',
      status: 'staged',
      remaining: 1,
      staged: 1,
      added: 3,
      removed: 1,
    },
    {
      path: 'README.md',
      status: 'untracked',
      remaining: 12,
      staged: 0,
      added: 20,
      removed: 0,
    },
  ];
  const view = {
    pane: 'files',
    files,
    fileCursor: 0,
    repoName: 'demo',
    branch: 'main',
    counts: { staged: 1, unstaged: 1, untracked: 1 },
    status: '',
    scroll: 0,
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 10,
    color: false,
  });
  const statusRow = stripAnsi(frame.rows[frame.rows.length - 2]);
  assert.match(statusRow, /main {2}feedback 0 {2}todo 0 {2}code 0/);
  assert.ok(!statusRow.includes('['));
  assert.match(statusRow, /\+3\/35 {2}-1\/6 {2}1\/17\s*$/);
  assert.ok(!statusRow.includes('untracked'));
  const notesAt = statusRow.indexOf('feedback 0');
  const plusAt = statusRow.indexOf('+3/35');
  assert.ok(notesAt < plusAt);
  const colored = render.renderFrame(view, {
    width: 80,
    height: 10,
    color: true,
  });
  const painted = colored.rows[colored.rows.length - 2];
  assert.ok(painted.includes(fg(THEME.addLineFg)));
  assert.ok(painted.includes(fg(THEME.delLineFg)));
});

test('long operations paint an infinite progress bar', () => {
  assert.equal(render.formatBusyStatus('pulled', 0), 'pulled');
  const first = render.formatBusyStatus('pulling', 0);
  const next = render.formatBusyStatus('pulling', 1);
  assert.match(first, /^pulling {2}·•●•·/);
  assert.notEqual(first, next);
  assert.match(render.formatBusyStatus('loading', 0), /^loading {2}·/);
  assert.match(render.formatBusyStatus('checking npm', 2), /^checking npm {2}/);
  assert.match(
    render.formatBusyStatus('updating reslop', 0),
    /^updating reslop {2}·/,
  );
  assert.match(render.formatBusyStatus('npm i', 0), /^npm i {2}·/);
  assert.match(render.formatBusyStatus('npm uninstall', 1), /^npm uninstall /);
  assert.match(render.formatBusyStatus('npm audit fix', 2), /^npm audit fix /);
  assert.match(
    render.formatBusyStatus('checking out', 0),
    /^checking out {2}·/,
  );
  assert.match(
    render.formatBusyStatus('creating branch', 1),
    /^creating branch {2}/,
  );
  assert.match(render.formatBusyStatus('rebasing', 0), /^rebasing {2}·/);
  assert.match(render.formatBusyStatus('dropping', 1), /^dropping {2}/);
  assert.match(render.formatBusyStatus('committing', 2), /^committing {2}/);
  assert.match(
    render.formatBusyStatus('force pushing', 0),
    /^force pushing {2}·/,
  );
  const view = {
    pane: 'files',
    files: [],
    counts: { staged: 0, unstaged: 0, untracked: 0 },
    branch: 'main',
    status: 'pulling',
    progressFrame: 0,
    repoName: 'demo',
    scroll: 0,
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: false,
  });
  const row = stripAnsi(frame.rows[frame.rows.length - 2]);
  const shown = render.formatBusyStatus('pulling', 0);
  const msgAt = row.indexOf(shown);
  const leftEnd = row.indexOf('code 0') + 'code 0'.length;
  const rightAt = row.lastIndexOf('0/0');
  assert.ok(msgAt > leftEnd);
  assert.ok(msgAt + visibleWidth(shown) <= rightAt);
  const leftGap = msgAt - leftEnd;
  const rightGap = rightAt - (msgAt + visibleWidth(shown));
  assert.ok(Math.abs(leftGap - rightGap) <= 1);
});

test('quit prompt paints f and c yellow on grey copy', () => {
  const hunk = sampleHunk([
    { type: 'add', text: 'x', noNl: false, blockId: 0 },
  ]);
  const view = reviewView(
    {
      origin: 'unstaged',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk,
      blockId: 0,
    },
    { mode: 'confirmQuit' },
  );
  const colored = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: true,
  });
  const statusRow = colored.rows[colored.rows.length - 2];
  const plain = stripAnsi(statusRow);
  assert.equal(plain.startsWith(render.QUIT_PROMPT), true);
  assert.ok(plain.includes('finish as ready'));
  assert.ok(plain.includes('continue next time'));
  assert.ok(!plain.includes('discard'));
  assert.ok(!plain.includes('Finish'));
  assert.ok(!plain.includes('Continue'));
  assert.ok(!plain.includes('pending'));
  assert.ok(statusRow.includes(fg(THEME.warnFg)));
  assert.ok(statusRow.includes(fg(THEME.mutedFg)));
  assert.ok(statusRow.includes(bg(THEME.chromeBg)));
  assert.ok(!statusRow.includes(bg(THEME.buttonBg)));
  assert.ok(statusRow.includes(BOLD));
  const warn = fg(THEME.warnFg);
  assert.equal(statusRow.split(warn).length - 1, 2);
  const hits = colored.statusHits;
  assert.equal(hits.length, 2);
  assert.equal(hits[0].id, 'f');
  assert.equal(hits[1].id, 'c');
  assert.equal(hits[0].y, colored.rows.length - 1);
  const finish = plain.slice(hits[0].x0, hits[0].x1).trim();
  const cont = plain.slice(hits[1].x0, hits[1].x1).trim();
  assert.equal(finish, 'finish as ready');
  assert.equal(cont, 'continue next time');
});

test('commit pane brief mode lists subject hash branch and age', () => {
  const view = {
    pane: 'commits',
    commits: [
      {
        sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        shortSha: 'aaa1111',
        author: 'Ada',
        date: '2 hours ago',
        refs: 'HEAD -> main',
        subject: 'land the change',
        head: true,
      },
      {
        sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        shortSha: 'bbb2222',
        author: 'Bob',
        date: 'yesterday',
        refs: 'old',
        subject: 'init',
        head: false,
      },
    ],
    commitCursor: 0,
    repoName: 'demo',
    counts: { staged: 1, unstaged: 0, untracked: 0 },
    branch: 'main',
    status: '',
    scroll: 0,
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: false,
  });
  const rows = frame.rows.map((row) => stripAnsi(row));
  const text = rows.join('\n');
  const headRow = rows.find((row) => row.includes('aaa1111'));
  const oldRow = rows.find((row) => row.includes('bbb2222'));
  assert.ok(headRow);
  assert.ok(oldRow);
  assert.ok(headRow.includes('▶ land the change'));
  assert.ok(headRow.includes('HEAD -> main'));
  assert.ok(headRow.includes('2h ago'));
  assert.equal(headRow.includes('Ada'), false);
  assert.ok(oldRow.includes('   init'));
  assert.ok(oldRow.includes('old'));
  assert.ok(oldRow.includes('1d ago'));
  assert.ok(headRow.indexOf('land the change') < headRow.indexOf('aaa1111'));
  assert.ok(headRow.indexOf('aaa1111') < headRow.indexOf('HEAD -> main'));
  assert.equal(headRow.indexOf('HEAD -> main'), oldRow.indexOf('old'));
  assert.ok(headRow.indexOf('HEAD -> main') < headRow.indexOf('2h ago'));
  assert.ok(headRow.endsWith('2h ago '));
  assert.ok(oldRow.endsWith('1d ago '));
  assert.equal(visibleWidth(headRow), 80);
  assert.equal(visibleWidth(oldRow), 80);
  assert.equal(
    headRow.indexOf('2h ago') + '2h ago'.length,
    oldRow.indexOf('1d ago') + '1d ago'.length,
  );
  assert.match(text, /land the change/);
  assert.match(render.headerText(view), /demo: commits brief$/);
  const footer = frame.rows[frame.rows.length - 1];
  assert.match(footer, /commit/);
  assert.match(footer, /apply/);
  assert.match(footer, /amend/);
  assert.match(footer, /reword/);
  assert.match(footer, /fixup/);
  assert.match(footer, /drop/);
  assert.match(footer, /pull/);
  assert.match(footer, /push/);
  assert.ok(!footer.includes('add'));
  assert.ok(!footer.includes('←'));
  assert.match(footer, /view/);
  assert.ok(frame.buttons.find((hit) => hit.id === 'view'));
  assert.ok(frame.buttons.find((hit) => hit.id === 'commit'));
  assert.ok(!frame.buttons.find((hit) => hit.id === 'apply'));
  assert.ok(frame.buttons.find((hit) => hit.id === 'amend'));
  assert.ok(frame.buttons.find((hit) => hit.id === 'reword'));
  assert.ok(frame.buttons.find((hit) => hit.id === 'fixup'));
  view.commits[0] = {
    ...view.commits[0],
    subject: 'fixup! land the change',
  };
  const fixupFrame = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: false,
  });
  assert.ok(fixupFrame.buttons.find((hit) => hit.id === 'apply'));
  view.commits[0] = {
    ...view.commits[0],
    subject: 'land the change',
  };
  assert.ok(frame.buttons.find((hit) => hit.id === 'drop'));
  assert.ok(frame.buttons.find((hit) => hit.id === 'pull'));
  assert.ok(frame.buttons.find((hit) => hit.id === 'push'));
  const colored = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: true,
  });
  const headPainted = colored.rows.find((row) => row.includes('aaa1111'));
  const mark = ansi.paint(' ▶ ', THEME.chromeFg, THEME.buttonBg, true);
  const subject = ansi.paint(
    'land the change',
    THEME.buttonHotFg,
    THEME.buttonBg,
    true,
  );
  const tail = ansi.paint(' ', THEME.chromeFg, THEME.buttonBg, true);
  assert.ok(headPainted.includes(`${mark}${subject}`));
  assert.ok(headPainted.endsWith(tail));
  assert.ok(!headPainted.includes(bg(THEME.currentBg)));
  assert.equal(visibleWidth(stripAnsi(headPainted)), 80);
  assert.ok(!headPainted.includes(bg(THEME.ctxBg)));
  view.commitCursor = 1;
  const selected = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: true,
  });
  const idleHead = selected.rows.find((row) => row.includes('aaa1111'));
  const idleMark = ansi.paint('   ', THEME.mutedFg, THEME.ctxBg, true);
  const idleSubject = ansi.paint(
    'land the change',
    THEME.chromeFg,
    THEME.ctxBg,
    true,
  );
  assert.ok(idleHead.includes(`${idleMark}${idleSubject}`));
  const selectedRow = selected.rows.find((row) => row.includes('bbb2222'));
  const selectedMark = ansi.paint(' ▶ ', THEME.chromeFg, THEME.buttonBg, true);
  const selectedSubject = ansi.paint(
    'init',
    THEME.buttonHotFg,
    THEME.buttonBg,
    true,
  );
  assert.ok(selectedRow.includes(`${selectedMark}${selectedSubject}`));
  assert.ok(selectedRow.endsWith(tail));
});

test('viewed commit is marked like the current branch', () => {
  const sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const view = {
    pane: 'commits',
    rev: sha,
    revShort: 'aaa1111',
    commits: [
      {
        pending: true,
        subject: 'uncommitted changes',
        sha: '',
        shortSha: '',
        date: '',
        refs: '',
      },
      {
        sha,
        shortSha: 'aaa1111',
        date: '2 hours ago',
        refs: 'HEAD -> main',
        subject: 'land the change',
        head: true,
      },
    ],
    commitCursor: 0,
    repoName: 'demo',
    counts: { staged: 1, unstaged: 0, untracked: 0 },
    branch: 'main',
    status: '',
    scroll: 0,
  };
  const colored = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: true,
  });
  const pending = colored.rows.find((row) => row.includes('uncommitted'));
  const viewed = colored.rows.find((row) => row.includes('aaa1111'));
  const currentBg = bg(THEME.currentBg);
  const currentLead = ansi.paint('   ', THEME.headerFg, THEME.currentBg, true);
  const currentSubject = ansi.paint(
    'land the change',
    THEME.mutedFg,
    THEME.currentBg,
    true,
  );
  const currentSha = ansi.paint(
    'aaa1111',
    THEME.shaDarkFg,
    THEME.currentBg,
    true,
  );
  const currentTail = ansi.paint(' ', THEME.headerFg, THEME.currentBg, true);
  assert.ok(pending.includes(bg(THEME.buttonBg)));
  assert.ok(!pending.includes(currentBg));
  assert.ok(viewed.includes(`${currentLead}${currentSubject}`));
  assert.ok(viewed.includes(currentSha));
  assert.ok(viewed.endsWith(currentTail));
  assert.ok(!viewed.includes(bg(THEME.buttonBg)));
  assert.ok(!viewed.includes(bg(THEME.ctxBg)));
  view.commitCursor = 1;
  const selected = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: true,
  });
  const selectedViewed = selected.rows.find((row) => row.includes('aaa1111'));
  const selectedLead = ansi.paint(' ▶ ', THEME.headerFg, THEME.currentBg, true);
  assert.ok(selectedViewed.includes(`${selectedLead}${currentSubject}`));
  assert.ok(!selectedViewed.includes(bg(THEME.buttonBg)));
  view.rev = '';
  view.revShort = '';
  view.commitCursor = 0;
  const worktree = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: true,
  });
  const currentPending = worktree.rows.find((row) =>
    row.includes('uncommitted'),
  );
  const pendingLead = ansi.paint(' ▶ ', THEME.headerFg, THEME.currentBg, true);
  const pendingSubject = ansi.paint(
    'uncommitted changes',
    THEME.mutedFg,
    THEME.currentBg,
    true,
  );
  assert.ok(currentPending.includes(`${pendingLead}${pendingSubject}`));
  assert.ok(currentPending.endsWith(currentTail));
  assert.ok(!currentPending.includes(bg(THEME.buttonBg)));
  view.rev = sha;
  view.revShort = 'aaa1111';
  view.commitView = 'full';
  view.commitCursor = 1;
  const full = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: true,
  });
  const hash = full.rows.find((row) => row.includes(sha));
  const fullHash = ansi.paint(sha, THEME.shaDarkFg, THEME.currentBg, true);
  assert.ok(hash.includes(fullHash));
  assert.ok(!hash.includes(bg(THEME.ctxBg)));
});

test('full view puts uncommitted changes on the first line', () => {
  const view = {
    pane: 'commits',
    commitView: 'full',
    commits: [
      {
        pending: true,
        subject: 'uncommitted changes',
        sha: '',
        shortSha: '',
        date: '',
        refs: '',
        stagedAdded: 2,
        unstagedAdded: 4,
        stagedRemoved: 1,
        unstagedRemoved: 3,
      },
    ],
    commitCursor: 0,
    repoName: 'demo',
    counts: { staged: 1, unstaged: 0, untracked: 0 },
    branch: 'main',
    status: '',
    scroll: 0,
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: false,
  });
  const rows = frame.rows.map((row) => stripAnsi(row));
  const subject = rows.find((row) => row.includes('uncommitted changes'));
  const at = rows.indexOf(subject);
  assert.ok(subject.includes('▶'));
  assert.ok(subject.includes('Diffs:'));
  assert.ok(subject.indexOf('Diffs:') < subject.indexOf('+2/4'));
  assert.ok(subject.indexOf('+2/4') < subject.indexOf('-1/3'));
  assert.equal(rows[at - 1].trim(), '');
  const brief = render.renderFrame(
    { ...view, commitView: 'brief' },
    { width: 80, height: 8, color: false },
  );
  const briefRow = brief.rows
    .map((row) => stripAnsi(row))
    .find((row) => row.includes('uncommitted'));
  assert.ok(briefRow.includes('+2/4'));
  assert.ok(briefRow.includes('-1/3'));
  assert.equal(briefRow.includes('Diffs:'), false);
  assert.ok(briefRow.indexOf('+2/4') < briefRow.indexOf('-1/3'));
});

test('diff counts follow branches in full and replace them in brief', () => {
  const entry = {
    sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    shortSha: 'aaa1111',
    author: 'Ada',
    email: 'ada@example.com',
    date: '2 hours ago',
    when: '2026-09-26 00:32:00 +0300',
    refs: 'HEAD -> main',
    subject: 'land the change',
    body: 'land the change',
    added: 4,
    removed: 1,
    head: true,
  };
  const view = {
    pane: 'commits',
    commitView: 'full',
    commits: [entry],
    commitCursor: 0,
    repoName: 'demo',
    counts: { staged: 0, unstaged: 0, untracked: 0 },
    branch: 'main',
    status: '',
    scroll: 0,
  };
  const full = render.renderFrame(view, {
    width: 120,
    height: 16,
    color: false,
  });
  const rows = full.rows.map((row) => stripAnsi(row));
  const branches = rows.find((row) => row.includes('HEAD -> main'));
  const count = rows.find((row) => row.includes('Diffs:'));
  const ago = '2h ago';
  const timeRow = rows.find((row) => row.includes(ago));
  const endAt = (row, token) => row.indexOf(token) + token.length;
  assert.ok(count.includes('+4'));
  assert.ok(count.includes('-1'));
  assert.ok(rows.indexOf(branches) < rows.indexOf(count));
  assert.ok(count.indexOf('Diffs:') < count.indexOf('+4'));
  assert.ok(count.indexOf('+4') < count.indexOf('-1'));
  assert.equal(endAt(count, '-1'), endAt(timeRow, ago));
  const wider = render.renderFrame(
    {
      ...view,
      commits: [
        entry,
        {
          ...entry,
          sha: 'b'.repeat(40),
          added: 12,
          removed: 30,
          refs: 'old',
        },
      ],
    },
    { width: 120, height: 20, color: false },
  );
  const wideRows = wider.rows.map((row) => stripAnsi(row));
  const small = wideRows.find(
    (row) => row.includes('Diffs:') && row.includes('+4'),
  );
  const large = wideRows.find((row) => row.includes('+12'));
  assert.equal(endAt(small, '+4'), endAt(large, '+12'));
  assert.equal(endAt(small, '-1'), endAt(large, '-30'));
  const colored = render.renderFrame(view, {
    width: 120,
    height: 16,
    color: true,
  });
  const painted = colored.rows.find((row) => row.includes('Diffs:'));
  const addPaint = ansi.paint('+4', THEME.addLineFg, THEME.buttonBg, true);
  const delPaint = ansi.paint('-1', THEME.delLineFg, THEME.buttonBg, true);
  assert.ok(painted.includes(addPaint));
  assert.ok(painted.includes(delPaint));
  const brief = render.renderFrame(
    { ...view, commitView: 'brief' },
    { width: 80, height: 8, color: false },
  );
  const briefRow = brief.rows
    .map((row) => stripAnsi(row))
    .find((row) => row.includes('aaa1111'));
  assert.ok(briefRow.includes('HEAD -> main'));
  assert.ok(briefRow.includes('+4'));
  assert.ok(briefRow.includes('-1'));
  assert.ok(briefRow.indexOf('HEAD -> main') < briefRow.indexOf('+4'));
  assert.ok(briefRow.indexOf('+4') < briefRow.indexOf('-1'));
  const open = render.renderFrame(
    {
      ...view,
      commitView: 'brief',
      commits: [{ ...entry, refs: '' }],
    },
    { width: 80, height: 8, color: false },
  );
  const openRow = open.rows
    .map((row) => stripAnsi(row))
    .find((row) => row.includes('aaa1111'));
  assert.ok(openRow.includes('+4'));
  assert.ok(openRow.includes('-1'));
  assert.equal(openRow.includes('HEAD -> main'), false);
  assert.ok(openRow.indexOf('+4') < openRow.indexOf('-1'));
  const pair = render.renderFrame(
    {
      ...view,
      commitView: 'brief',
      commits: [
        { ...entry, refs: '', added: 4, removed: 1 },
        {
          ...entry,
          refs: '',
          sha: 'b'.repeat(40),
          shortSha: 'bbb2222',
          added: 12,
          removed: 30,
        },
      ],
    },
    { width: 80, height: 8, color: false },
  );
  const pairRows = pair.rows.map((row) => stripAnsi(row));
  const few = pairRows.find((row) => row.includes('+4'));
  const many = pairRows.find((row) => row.includes('+12'));
  assert.equal(endAt(few, '+4'), endAt(many, '+12'));
  assert.equal(endAt(few, '-1'), endAt(many, '-30'));
  const coloredBrief = render.renderFrame(
    {
      ...view,
      commitView: 'brief',
      commits: [{ ...entry, refs: '' }],
    },
    { width: 80, height: 8, color: true },
  );
  const coloredRow = coloredBrief.rows.find((row) => row.includes('+4'));
  assert.ok(coloredRow.includes(addPaint));
  assert.ok(coloredRow.includes(delPaint));
});

test('brief mode shows only the first line of a commit message', () => {
  const view = {
    pane: 'commits',
    commits: [
      {
        sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        shortSha: 'aaa1111',
        author: 'Ada',
        date: '2 hours ago',
        refs: 'HEAD -> main',
        subject: 'land the change extra line',
        body: 'land the change\nextra line',
        head: true,
      },
    ],
    commitCursor: 0,
    repoName: 'demo',
    counts: { staged: 0, unstaged: 0, untracked: 0 },
    branch: 'main',
    status: '',
    scroll: 0,
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: false,
  });
  const rows = frame.rows.map((row) => stripAnsi(row));
  const headRow = rows.find((row) => row.includes('aaa1111'));
  assert.ok(headRow.includes('land the change'));
  assert.equal(headRow.includes('extra line'), false);
  view.compose = {
    kind: 'commit',
    commitKind: 'reword',
    text: 'ship it\nextra line',
    cursor: 7,
  };
  const editing = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: false,
  });
  const editRows = editing.rows.map((row) => stripAnsi(row));
  const editRow = editRows.find((row) => row.includes('▶'));
  assert.ok(editRow.includes('ship it'));
  assert.equal(editRow.includes('land the change'), false);
  assert.equal(
    editRows.some((row) => row.includes('extra line')),
    false,
  );
});

test('commit pane types a message on a row at the top of the list', () => {
  const view = {
    pane: 'commits',
    commits: [
      {
        sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        shortSha: 'aaa1111',
        author: 'Ada',
        date: '2 hours ago',
        subject: 'land the change',
        head: true,
      },
      {
        sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        shortSha: 'bbb2222',
        author: 'Bob',
        date: 'yesterday',
        subject: 'init',
        head: false,
      },
    ],
    commitCursor: 0,
    compose: { kind: 'commit', text: 'ship it', cursor: 7 },
    repoName: 'demo',
    counts: { staged: 1, unstaged: 0, untracked: 0 },
    branch: 'main',
    status: '',
    scroll: 0,
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: false,
  });
  const rows = frame.rows.map((row) => stripAnsi(row));
  const editAt = rows.findIndex(
    (row) => row.includes('▶') && row.includes('ship it'),
  );
  const headAt = rows.findIndex((row) => row.includes('aaa1111'));
  assert.ok(editAt >= 0);
  assert.ok(headAt > editAt);
  assert.ok(rows[editAt].includes('▶ ship it'));
  assert.ok(!rows[editAt].includes('[ship it]'));
  assert.equal(frame.cursor.y, editAt + 1);
  assert.match(render.headerText(view), /demo: commits brief$/);
});

test('amend types over the current commit row', () => {
  const view = {
    pane: 'commits',
    commits: [
      {
        sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        shortSha: 'aaa1111',
        author: 'Ada',
        date: '2 hours ago',
        subject: 'land the change',
        head: true,
      },
      {
        sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        shortSha: 'bbb2222',
        author: 'Bob',
        date: 'yesterday',
        subject: 'init',
        head: false,
      },
    ],
    commitCursor: 0,
    compose: {
      kind: 'commit',
      commitKind: 'amend',
      text: 'rewritten',
      cursor: 9,
    },
    repoName: 'demo',
    counts: { staged: 1, unstaged: 0, untracked: 0 },
    branch: 'main',
    status: '',
    scroll: 0,
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: false,
  });
  const rows = frame.rows.map((row) => stripAnsi(row));
  const editAt = rows.findIndex(
    (row) => row.includes('▶') && row.includes('rewritten'),
  );
  const oldAt = rows.findIndex((row) => row.includes('bbb2222'));
  assert.ok(editAt >= 0);
  assert.ok(oldAt > editAt);
  assert.ok(rows[editAt].includes('aaa1111'));
  assert.ok(!rows[editAt].includes('land the change'));
  assert.equal(rows.filter((row) => row.includes('▶')).length, 1);
  assert.equal(frame.cursor.y, editAt + 1);
  assert.match(render.headerText(view), /demo: commits brief$/);
});

test('full mode amend edits the message inside the panel', () => {
  const hash = 'a'.repeat(40);
  const view = {
    pane: 'commits',
    commitView: 'full',
    commits: [
      {
        sha: hash,
        shortSha: 'aaa1111',
        author: 'Ada',
        email: 'ada@example.com',
        date: '2 hours ago',
        when: '2026-09-26 00:32:00 +0300',
        refs: 'HEAD -> main',
        subject: 'land the change',
        body: 'land the change\n\nexplain the change',
        head: true,
      },
      {
        sha: 'b'.repeat(40),
        shortSha: 'bbb2222',
        author: 'Bob',
        date: 'yesterday',
        when: '2026-09-25 12:00:00 +0300',
        subject: 'init',
        body: 'init',
        head: false,
      },
    ],
    commitCursor: 0,
    compose: {
      kind: 'commit',
      commitKind: 'amend',
      text: 'rewritten\nsecond line',
      cursor: 9,
    },
    repoName: 'demo',
    counts: { staged: 1, unstaged: 0, untracked: 0 },
    branch: 'main',
    status: '',
    scroll: 0,
  };
  const frame = render.renderFrame(view, {
    width: 120,
    height: 18,
    color: false,
  });
  const rows = frame.rows.map((row) => stripAnsi(row));
  const head = rows.find((row) => row.includes(hash));
  const subject = rows.find((row) => row.includes('rewritten'));
  const editAt = rows.findIndex((row) => row.includes('rewritten'));
  assert.ok(head.includes('▶'));
  assert.ok(head.includes('Ada <ada@example.com>'));
  assert.equal(head.includes('rewritten'), false);
  assert.equal(head.includes('land the change'), false);
  assert.equal(subject.includes(hash), false);
  assert.ok(rows.some((row) => row.includes('second line')));
  assert.equal(
    rows.some((row) => row.includes('explain the change')),
    false,
  );
  assert.equal(rows.filter((row) => row.includes('▶')).length, 1);
  assert.equal(frame.cursor.y, editAt + 1);
  const bob = rows.find((row) => row.includes('Bob'));
  assert.ok(bob.includes('b'.repeat(40)));
  const colored = render.renderFrame(view, {
    width: 120,
    height: 18,
    color: true,
  });
  const subjectPaint = ansi.paint(
    'rewritten',
    THEME.buttonHotFg,
    THEME.buttonBg,
    true,
  );
  const bodyPaint = ansi.paint(
    'second line',
    THEME.mutedFg,
    THEME.buttonBg,
    true,
  );
  const paintedSubject = colored.rows.find((row) => row.includes('rewritten'));
  const paintedBody = colored.rows.find((row) => row.includes('second line'));
  assert.ok(paintedSubject.includes(subjectPaint));
  assert.ok(paintedBody.includes(bodyPaint));
});

test('full mode new commit stays a multiline message', () => {
  const hash = 'a'.repeat(40);
  const view = {
    pane: 'commits',
    commitView: 'full',
    commits: [
      {
        sha: hash,
        shortSha: 'aaa1111',
        author: 'Ada',
        date: '2 hours ago',
        when: '2026-09-26 00:32:00 +0300',
        subject: 'land the change',
        body: 'land the change',
        head: true,
      },
    ],
    commitCursor: 0,
    compose: {
      kind: 'commit',
      commitKind: 'commit',
      text: 'ship it\nmore',
      cursor: 7,
    },
    repoName: 'demo',
    counts: { staged: 1, unstaged: 0, untracked: 0 },
    branch: 'main',
    status: '',
    scroll: 0,
  };
  const frame = render.renderFrame(view, {
    width: 120,
    height: 16,
    color: false,
  });
  const rows = frame.rows.map((row) => stripAnsi(row));
  const draft = rows.find((row) => row.includes('ship it'));
  const editAt = rows.findIndex((row) => row.includes('ship it'));
  const kept = rows.find((row) => row.includes(hash));
  assert.ok(draft.includes('▶'));
  assert.equal(draft.includes(hash), false);
  assert.equal(draft.includes('aaa1111'), false);
  assert.ok(rows.some((row) => row.includes('more')));
  assert.equal(rows.filter((row) => row.includes('▶')).length, 1);
  assert.equal(frame.cursor.y, editAt + 1);
  assert.ok(kept.includes('Ada'));
  assert.equal(kept.includes('▶'), false);
  assert.ok(editAt < rows.findIndex((row) => row.includes(hash)));
});

test('commit pane full mode shows the message author date and branches', () => {
  const view = {
    pane: 'commits',
    commitView: 'full',
    commits: [
      {
        sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        shortSha: 'aaa1111',
        author: 'Ada',
        email: 'ada@example.com',
        date: '2 hours ago',
        when: '2026-09-26 00:32:00 +0300',
        refs: 'HEAD -> main, origin/main',
        subject: 'land the change',
        body: 'land the change\n\nexplain the change',
        head: true,
      },
      {
        sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        shortSha: 'bbb2222',
        author: 'Bob',
        date: 'yesterday',
        when: '2026-09-25 12:00:00 +0300',
        refs: 'old',
        subject: 'init',
        body: 'init',
        head: false,
      },
    ],
    commitCursor: 0,
    repoName: 'demo',
    counts: { staged: 1, unstaged: 0, untracked: 0 },
    branch: 'main',
    status: '',
    scroll: 0,
  };
  const frame = render.renderFrame(view, {
    width: 120,
    height: 18,
    color: false,
  });
  const rows = frame.rows.map((row) => stripAnsi(row));
  const hash = 'a'.repeat(40);
  const head = rows.find((row) => row.includes(hash));
  const stamp = rows.find((row) => row.includes('2026-09-26 00:32:00 +0300'));
  const branches = rows.find((row) =>
    row.includes('HEAD -> main, origin/main'),
  );
  assert.ok(head.includes('▶'));
  assert.ok(head.includes('Ada <ada@example.com>'));
  assert.ok(head.indexOf(hash) < head.indexOf('Ada'));
  assert.ok(stamp.includes('land the change'));
  assert.ok(stamp.includes('2h ago'));
  assert.ok(stamp.indexOf('land the change') < stamp.indexOf('2026-09-26'));
  assert.ok(stamp.indexOf('2026-09-26') < stamp.indexOf('2h ago'));
  assert.ok(rows.some((row) => row.includes('explain the change')));
  const column = head.indexOf('Ada');
  assert.equal(stamp.indexOf('2026-09-26'), column);
  assert.equal(branches.indexOf('HEAD -> main'), column);
  const wideRefs = 'HEAD -> main, origin/main, feature/long-name';
  const when = '2026-09-26 00:32:00 +0300';
  const ago = '2h ago';
  const wide = render.renderFrame(
    {
      ...view,
      commits: [{ ...view.commits[0], refs: wideRefs }, view.commits[1]],
    },
    { width: 120, height: 18, color: false },
  );
  const wideRows = wide.rows.map((row) => stripAnsi(row));
  const timeRow = wideRows.find((row) => row.includes(when));
  const branchRow = wideRows.find((row) => row.includes(wideRefs));
  const origin = timeRow.indexOf(when);
  const columnW = Math.max(
    'Ada <ada@example.com>'.length,
    when.length + 2 + ago.length,
    wideRefs.length,
  );
  assert.equal(branchRow.indexOf(wideRefs), origin);
  assert.equal(timeRow.indexOf(ago) + ago.length, origin + columnW);
  assert.ok(timeRow.endsWith(`${ago} `));
  assert.ok(timeRow.indexOf(ago) > origin + when.length);
  assert.equal(visibleWidth(timeRow), 120);
  const oldHash = 'b'.repeat(40);
  const bob = rows.find((row) => row.includes('Bob'));
  assert.ok(bob.includes(oldHash));
  assert.ok(bob.indexOf(oldHash) < bob.indexOf('Bob'));
  assert.equal(bob.includes('<'), false);
  const old = rows.find((row) => row.includes('old'));
  assert.equal(old.includes(oldHash), false);
  assert.equal(old.includes('init'), false);
  const hits = frame.fileHits.map((hit) => hit.cursor);
  assert.ok(hits.filter((cursor) => cursor === 0).length >= 4);
  assert.ok(hits.includes(1));
  assert.match(render.headerText(view), /demo: commits full$/);
  const colored = render.renderFrame(view, {
    width: 120,
    height: 18,
    color: true,
  });
  const authorPaint = ansi.paint('Ada', THEME.addLineFg, THEME.buttonBg, true);
  const emailPaint = ansi.paint(
    ' <ada@example.com>',
    THEME.mutedFg,
    THEME.buttonBg,
    true,
  );
  const subjectPaint = ansi.paint(
    'land the change',
    THEME.buttonHotFg,
    THEME.buttonBg,
    true,
  );
  const bodyPaint = ansi.paint(
    'explain the change',
    THEME.mutedFg,
    THEME.buttonBg,
    true,
  );
  const paintedAuthor = colored.rows.find((row) => row.includes('Ada'));
  const paintedSubject = colored.rows.find((row) =>
    row.includes('land the change'),
  );
  const paintedBody = colored.rows.find((row) =>
    row.includes('explain the change'),
  );
  assert.ok(paintedAuthor.includes(authorPaint));
  assert.ok(paintedAuthor.includes(emailPaint));
  assert.equal(visibleWidth(stripAnsi(paintedAuthor)), 120);
  assert.ok(!paintedAuthor.includes(bg(THEME.ctxBg)));
  const panelTail = ansi.paint(' ', THEME.chromeFg, THEME.buttonBg, true);
  assert.ok(paintedSubject.endsWith(panelTail));
  assert.ok(stripAnsi(paintedSubject).endsWith('2h ago '));
  assert.ok(paintedSubject.includes(subjectPaint));
  assert.ok(paintedBody.includes(bodyPaint));
  view.commitCursor = 1;
  const lower = render.renderFrame(view, {
    width: 80,
    height: 8,
    color: false,
  });
  const lowerRows = lower.rows.map((row) => stripAnsi(row));
  assert.ok(lowerRows.some((row) => row.includes('b'.repeat(40))));
});

test('full mode commit edit hints how to save', () => {
  const view = {
    pane: 'commits',
    commitView: 'full',
    mode: 'compose',
    compose: {
      kind: 'commit',
      commitKind: 'commit',
      text: 'ship',
      cursor: 4,
    },
    commits: [],
    commitCursor: 0,
    repoName: 'demo',
    counts: { staged: 1, unstaged: 0, untracked: 0 },
    branch: 'main',
    status: '',
    scroll: 0,
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 10,
    color: false,
  });
  const footer = stripAnsi(frame.rows[frame.rows.length - 1]);
  const status = stripAnsi(frame.rows[frame.rows.length - 2]);
  assert.match(footer, /^ Press Ctrl-S or Enter at EOF to save/);
  assert.equal(footer.includes('reword'), false);
  assert.equal(status.includes('Enter at EOF'), false);
  assert.equal(frame.buttons.length, 0);
  const colored = render.renderFrame(view, {
    width: 80,
    height: 10,
    color: true,
  });
  const row = colored.rows[colored.rows.length - 1];
  const hotFg = 0xff;
  const ctrlS = ansi.paint('Ctrl-S', hotFg, THEME.buttonBg, true, true);
  const enter = ansi.paint('Enter', hotFg, THEME.buttonBg, true, true);
  const press = ansi.paint('Press ', THEME.buttonFg, THEME.buttonBg, true);
  const or = ansi.paint(' or ', THEME.buttonFg, THEME.buttonBg, true);
  const tail = ansi.paint(
    ' at EOF to save',
    THEME.buttonFg,
    THEME.buttonBg,
    true,
  );
  assert.ok(row.includes(`${press}${ctrlS}${or}${enter}${tail}`));
  view.status = 'empty commit message';
  const blocked = render.renderFrame(view, {
    width: 80,
    height: 10,
    color: false,
  });
  const errorRow = stripAnsi(blocked.rows[blocked.rows.length - 2]);
  const stillHint = stripAnsi(blocked.rows[blocked.rows.length - 1]);
  assert.ok(errorRow.includes('empty commit message'));
  assert.ok(stillHint.includes('Press Ctrl-S or Enter at EOF to save'));
  view.status = '';
  view.commitView = 'brief';
  const brief = render.renderFrame(view, {
    width: 80,
    height: 10,
    color: false,
  });
  const briefRow = stripAnsi(brief.rows[brief.rows.length - 1]);
  assert.equal(briefRow.includes('Enter at EOF'), false);
  assert.ok(brief.buttons.find((hit) => hit.id === 'view'));
});

test('update prompt paints y and n on the status line', () => {
  const view = {
    pane: 'files',
    files: [{ path: 'a.js', status: 'unstaged', remaining: 1, firstIndex: 0 }],
    fileCursor: 0,
    repoName: 'demo',
    counts: { staged: 0, unstaged: 1, untracked: 0 },
    status: '',
    scroll: 0,
    mode: 'confirmUpdate',
    updateFrom: '0.1.5',
    updateTo: '1.0.0',
  };
  const colored = render.renderFrame(view, {
    width: 80,
    height: 8,
    color: true,
  });
  const statusRow = colored.rows[colored.rows.length - 2];
  const buttons = colored.rows[colored.rows.length - 1];
  const plain = stripAnsi(statusRow);
  assert.equal(plain.startsWith(render.updatePrompt('0.1.5', '1.0.0')), true);
  assert.match(plain, /update reslop 0\.1\.5 → 1\.0\.0\? y\/n/);
  assert.match(stripAnsi(colored.rows[2]), /a\.js/);
  assert.match(stripAnsi(buttons), /add/i);
  assert.ok(statusRow.includes(fg(THEME.warnFg)));
  assert.ok(statusRow.includes(fg(THEME.mutedFg)));
  assert.ok(statusRow.includes(bg(THEME.chromeBg)));
  const warn = fg(THEME.warnFg);
  assert.equal(statusRow.split(warn).length - 1, 2);
  const hits = colored.statusHits;
  assert.equal(hits.length, 2);
  assert.equal(hits[0].id, 'y');
  assert.equal(hits[1].id, 'n');
  assert.equal(hits[0].y, colored.rows.length - 1);
  assert.equal(plain.slice(hits[0].x0, hits[0].x1).trim(), 'y');
  assert.equal(plain.slice(hits[1].x0, hits[1].x1), '/n');
});

test('drop branch prompt paints y and n on the status line', () => {
  const view = {
    pane: 'branches',
    branches: [
      { name: 'main', current: true, isDefault: true },
      { name: 'feat', current: false, isDefault: false },
    ],
    branchCursor: 1,
    repoName: 'demo',
    counts: { staged: 0, unstaged: 0, untracked: 0 },
    branch: 'main',
    status: '',
    scroll: 0,
    mode: 'confirmDrop',
    dropName: 'feat',
  };
  const colored = render.renderFrame(view, {
    width: 80,
    height: 8,
    color: true,
  });
  const statusRow = colored.rows[colored.rows.length - 2];
  const plain = stripAnsi(statusRow);
  assert.equal(plain.startsWith(render.dropPrompt('feat')), true);
  assert.match(plain, /drop feat\? y\/n/);
  const warn = fg(THEME.warnFg);
  assert.equal(statusRow.split(warn).length - 1, 2);
  const hits = colored.statusHits;
  assert.equal(hits.length, 2);
  assert.equal(hits[0].id, 'y');
  assert.equal(hits[1].id, 'n');
  assert.equal(hits[0].y, colored.rows.length - 1);
  assert.equal(plain.slice(hits[0].x0, hits[0].x1).trim(), 'y');
  assert.equal(plain.slice(hits[1].x0, hits[1].x1), '/n');
});

test('rejected push prompt paints f for force push', () => {
  const view = {
    pane: 'files',
    files: [{ path: 'a.js', status: 'unstaged', remaining: 1, firstIndex: 0 }],
    fileCursor: 0,
    repoName: 'demo',
    counts: { staged: 0, unstaged: 1, untracked: 0 },
    status: '',
    scroll: 0,
    mode: 'confirmPush',
  };
  const colored = render.renderFrame(view, {
    width: 80,
    height: 8,
    color: true,
  });
  const statusRow = colored.rows[colored.rows.length - 2];
  const plain = stripAnsi(statusRow);
  assert.equal(plain.startsWith(render.PUSH_PROMPT), true);
  assert.ok(plain.includes('Need force-push?'));
  assert.ok(plain.includes('force push'));
  assert.ok(statusRow.includes(fg(THEME.warnFg)));
  assert.ok(statusRow.includes(fg(THEME.mutedFg)));
  assert.ok(statusRow.includes(bg(THEME.chromeBg)));
  const warn = fg(THEME.warnFg);
  assert.equal(statusRow.split(warn).length - 1, 1);
  const hits = colored.statusHits;
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'f');
  assert.equal(hits[0].y, colored.rows.length - 1);
  assert.equal(plain.slice(hits[0].x0, hits[0].x1).trim(), 'force push');
});

test('header and file list keep a right-side gap', () => {
  const view = {
    pane: 'files',
    files: [{ path: 'a.js', status: 'unstaged', remaining: 1, firstIndex: 0 }],
    fileCursor: 0,
    repoName: 'demo',
    counts: { staged: 0, unstaged: 1, untracked: 0 },
    status: '',
    scroll: 0,
  };
  const frame = render.renderFrame(view, {
    width: 40,
    height: 8,
    color: false,
  });
  const header = stripAnsi(frame.rows[0]);
  assert.equal(header.startsWith(' '), true);
  assert.equal(header.endsWith(' '), true);
  assert.match(header, /👁️ {2}reslop/);
  const row = stripAnsi(frame.rows[2]);
  assert.equal(row.endsWith(' '), true);
  assert.match(row, /▶ a\.js/);
});

test('file list keeps a blank line before and after', () => {
  const files = [
    { path: 'a.js', status: 'unstaged', remaining: 1, firstIndex: 0 },
    { path: 'b.js', status: 'staged', remaining: 1, firstIndex: 1 },
  ];
  const view = {
    pane: 'files',
    files,
    fileCursor: 0,
    repoName: 'demo',
    counts: { staged: 1, unstaged: 1, untracked: 0 },
    status: '',
    scroll: 0,
  };
  const frame = render.renderFrame(view, {
    width: 40,
    height: 8,
    color: true,
  });
  assert.equal(stripAnsi(frame.rows[1]).trim(), '');
  assert.ok(frame.rows[1].includes(bg(THEME.ctxBg)));
  assert.match(stripAnsi(frame.rows[2]), /a\.js/);
  assert.match(stripAnsi(frame.rows[3]), /b\.js/);
  assert.equal(stripAnsi(frame.rows[4]).trim(), '');
  assert.ok(frame.rows[4].includes(bg(THEME.ctxBg)));
  assert.equal(frame.fileHits[0].y, 3);
  assert.equal(frame.fileHits[1].y, 4);
});

test('file list up moves the cursor before scrolling', () => {
  const files = [];
  for (let i = 0; i < 20; i++) {
    files.push({
      path: `f${i}.js`,
      status: 'unstaged',
      remaining: 1,
      firstIndex: i,
    });
  }
  const view = {
    pane: 'files',
    files,
    repoName: 'demo',
    counts: { staged: 0, unstaged: 20, untracked: 0 },
    status: '',
    scroll: 0,
  };
  const opt = { width: 40, height: 8, color: false };
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
  const last = files.length - 1;
  const bottom = render.renderFrame(
    { ...view, fileCursor: last, listScroll: 0 },
    opt,
  );
  const up = render.renderFrame(
    { ...view, fileCursor: last - 1, listScroll: bottom.listScroll },
    opt,
  );
  assert.ok(listNames(bottom).length > 1);
  assert.deepEqual(listNames(up), listNames(bottom));
  assert.equal(markRow(up), markRow(bottom) - 1);
});

test('header last column uses the light grey bar background', () => {
  const view = {
    pane: 'files',
    files: [{ path: 'a.js', status: 'unstaged', remaining: 1, firstIndex: 0 }],
    fileCursor: 0,
    repoName: 'demo',
    counts: { staged: 0, unstaged: 1, untracked: 0 },
    status: '',
    scroll: 0,
  };
  const width = 40;
  const frame = render.renderFrame(view, { width, height: 8, color: true });
  const row = frame.rows[0];
  const plain = stripAnsi(row);
  assert.equal(visibleWidth(plain), width);
  assert.equal(plain.endsWith(' '), true);
  assert.ok(row.includes(bg(THEME.headerBg)));
  assert.ok(row.includes(`${bg(THEME.headerBg)}${EL}`));
  const body = row.endsWith(RESET) ? row.slice(0, -RESET.length) : row;
  assert.ok(!body.includes(RESET));
  assert.ok(!body.includes(`${ESC}[2J`));
});

test('file list leads with repository TODOs and a count', () => {
  const files = [
    {
      path: 'Repository TODOs and Issues',
      kind: 'todos',
      status: 'todos',
      remaining: 3,
      staged: 1,
      firstIndex: 0,
    },
    { path: 'a.js', status: 'unstaged', remaining: 1, firstIndex: 0 },
  ];
  const frame = render.renderFrame(
    {
      pane: 'files',
      files,
      fileCursor: 0,
      repoName: 'demo',
      counts: { staged: 0, unstaged: 1, untracked: 0, todo: 3 },
      status: '',
      scroll: 0,
    },
    { width: 64, height: 8, color: false },
  );
  const lead = stripAnsi(frame.rows[2]);
  const file = stripAnsi(frame.rows[3]);
  assert.match(lead, /▶ Repository TODOs and Issues/);
  assert.match(lead, /1\/3\s*$/);
  assert.match(file, /a\.js/);
  assert.ok(!file.includes('Repository'));
  assert.ok(!lead.includes('demo'));
  assert.equal(frame.fileHits[0].y, 3);
  const header = render.headerText({
    pane: 'files',
    files,
    fileCursor: 0,
    repoName: 'demo',
  });
  assert.match(header, /demo: TODOs\s*$/);
  assert.ok(!header.includes('todo '));
  assert.ok(!/\d+\/\d+/.test(header));
  assert.ok(!header.includes('demo/'));
  const colored = render.renderFrame(
    {
      pane: 'files',
      files,
      fileCursor: 0,
      repoName: 'demo',
      counts: { staged: 0, unstaged: 1, untracked: 0, todo: 3 },
      status: '',
      scroll: 0,
    },
    { width: 64, height: 8, color: true },
  );
  const title = colored.rows[2];
  assert.ok(title.includes(BOLD));
  assert.ok(title.includes(fg(THEME.buttonHotFg)));
});

test('file list marks only the cursor row', () => {
  const files = [
    { path: 'a.js', status: 'unstaged', remaining: 1, firstIndex: 0 },
    { path: 'b.js', status: 'staged', remaining: 1, firstIndex: 1 },
  ];
  const frame = render.renderFrame(
    {
      pane: 'files',
      files,
      fileCursor: 0,
      reviewPath: 'b.js',
      repoName: 'demo',
      counts: { staged: 1, unstaged: 1, untracked: 0 },
      status: '',
      scroll: 0,
    },
    { width: 40, height: 8, color: false },
  );
  assert.match(stripAnsi(frame.rows[2]), /▶ a\.js/);
  assert.match(stripAnsi(frame.rows[3]), / {2}b\.js/);
  assert.ok(!stripAnsi(frame.rows[3]).includes('▶'));
});

test('AC10 footer words highlight the bound letter', () => {
  const view = {
    pane: 'files',
    files: [{ path: 'a.js', status: 'unstaged', remaining: 1, firstIndex: 0 }],
    fileCursor: 0,
    repoName: 'demo',
    counts: { staged: 0, unstaged: 1, untracked: 0 },
    status: '',
    scroll: 0,
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 8,
    color: true,
  });
  const row = frame.rows[frame.rows.length - 1];
  const plain = stripAnsi(row);
  assert.match(
    plain,
    /add {2}unstage {2}drop {2}todo {2}branch {2}npm {2}file /,
  );
  assert.match(plain, /commit {2}pull {2}push/);
  assert.match(plain, /^ add {2}/);
  assert.ok(!plain.includes('q'));
  assert.ok(!plain.includes('prev'));
  assert.ok(!plain.includes('next'));
  assert.ok(!plain.includes('quit'));
  assert.ok(!plain.includes('files'));
  assert.ok(!plain.includes('mode'));
  assert.ok(!plain.includes('feedback'));
  assert.ok(!plain.includes('code'));
  assert.ok(!plain.includes('['));
  assert.ok(!plain.includes('←'));
  assert.ok(!plain.includes('→'));
  assert.ok(row.includes(fg(THEME.buttonHotFg)));
  assert.ok(row.includes(fg(THEME.buttonFg)));
  assert.ok(row.includes(BOLD));
  const dim = render.renderFrame(view, {
    width: 80,
    height: 8,
    color: false,
  });
  const dimRow = dim.rows[dim.rows.length - 1];
  assert.match(
    dimRow,
    /add {2}unstage {2}drop {2}todo {2}branch {2}npm {2}file /,
  );
  assert.match(dimRow, /commit {2}pull {2}push/);
  assert.ok(!dimRow.includes('q'));
  assert.ok(!dimRow.includes('['));
  const mode = frame.buttons.find((hit) => hit.id === 'layout');
  const feedback = frame.buttons.find((hit) => hit.id === 'feedback');
  const code = frame.buttons.find((hit) => hit.id === 'code');
  assert.equal(mode, undefined);
  assert.equal(feedback, undefined);
  assert.equal(code, undefined);
  assert.ok(frame.buttons.find((hit) => hit.id === 'add'));
  assert.ok(frame.buttons.find((hit) => hit.id === 'unstage'));
  assert.ok(frame.buttons.find((hit) => hit.id === 'file'));
  assert.equal(
    frame.buttons.find((hit) => hit.id === 'diff'),
    undefined,
  );
  assert.equal(
    frame.buttons.find((hit) => hit.id === 'reload'),
    undefined,
  );
  assert.equal(
    frame.buttons.find((hit) => hit.id === 'files'),
    undefined,
  );
  assert.ok(frame.buttons.find((hit) => hit.id === 'pull'));
  assert.ok(frame.buttons.find((hit) => hit.id === 'push'));
  view.fileScope = 'file';
  const fileScope = render.renderFrame(view, {
    width: 80,
    height: 8,
    color: false,
  });
  const fileScopeRow = fileScope.rows[fileScope.rows.length - 1];
  assert.match(fileScopeRow, /todo {2}branch {2}npm {2}diff {2}commit {2}pull/);
  assert.ok(fileScope.buttons.find((hit) => hit.id === 'diff'));
  assert.equal(
    fileScope.buttons.find((hit) => hit.id === 'file'),
    undefined,
  );
});

test('files pane todos row dims add unstage drop', () => {
  const view = {
    pane: 'files',
    files: [
      {
        path: 'Repository TODOs and Issues',
        kind: 'todos',
        status: 'todos',
        remaining: 1,
        staged: 0,
        firstIndex: 0,
      },
      { path: 'a.js', status: 'unstaged', remaining: 1, firstIndex: 0 },
    ],
    fileCursor: 0,
    repoName: 'demo',
    counts: { staged: 0, unstaged: 1, untracked: 0, todo: 1 },
    status: '',
    scroll: 0,
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 8,
    color: false,
  });
  const footer = frame.rows[frame.rows.length - 1];
  assert.match(
    footer,
    /add {2}unstage {2}drop {2}todo {2}branch {2}npm {2}file /,
  );
  assert.match(footer, /commit {2}pull {2}push/);
  assert.ok(!footer.includes('q'));
  assert.ok(!footer.includes('←'));
  assert.ok(!footer.includes('→'));
  assert.equal(
    frame.buttons.find((hit) => hit.id === 'add'),
    undefined,
  );
  assert.equal(
    frame.buttons.find((hit) => hit.id === 'unstage'),
    undefined,
  );
  assert.equal(
    frame.buttons.find((hit) => hit.id === 'revert'),
    undefined,
  );
  assert.ok(frame.buttons.find((hit) => hit.id === 'commit'));
  const colored = render.renderFrame(view, {
    width: 80,
    height: 8,
    color: true,
  });
  const row = colored.rows[colored.rows.length - 1];
  const rest = seq(THEME.buttonFg, THEME.buttonBg);
  const hot = seq(THEME.buttonHotFg, THEME.buttonBg);
  assert.ok(row.includes(`${rest}add`));
  assert.ok(!row.includes(`${BOLD}${hot}a`));
  assert.ok(row.includes(`${BOLD}${hot}c`));
  view.fileCursor = 1;
  const file = render.renderFrame(view, {
    width: 80,
    height: 8,
    color: false,
  });
  const fileFooter = file.rows[file.rows.length - 1];
  assert.match(
    fileFooter,
    /add {2}unstage {2}drop {2}todo {2}branch {2}npm {2}file/,
  );
  assert.ok(file.buttons.find((hit) => hit.id === 'add'));
});

test('diff pane dims add on staged and unstage on unstaged', () => {
  const hunk = sampleHunk([
    { type: 'add', text: 'x', noNl: false, blockId: 0 },
  ]);
  const item = {
    origin: 'staged',
    file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
    hunk,
    blockId: 0,
  };
  const view = {
    pane: 'diff',
    item,
    index: 0,
    total: 1,
    scroll: 0,
    status: '',
    counts: { staged: 1, unstaged: 0, untracked: 0 },
    repoName: 'demo',
  };
  const staged = render.renderFrame(view, {
    width: 80,
    height: 8,
    color: true,
  });
  const stagedRow = staged.rows[staged.rows.length - 1];
  const rest = seq(THEME.buttonFg, THEME.buttonBg);
  const hot = seq(THEME.buttonHotFg, THEME.buttonBg);
  assert.match(stripAnsi(stagedRow), /add {2}unstage {2}drop/);
  assert.equal(
    staged.buttons.find((hit) => hit.id === 'add'),
    undefined,
  );
  assert.ok(staged.buttons.find((hit) => hit.id === 'unstage'));
  assert.ok(stagedRow.includes(`${rest}add`));
  assert.ok(!stagedRow.includes(`${BOLD}${hot}a`));
  assert.ok(stagedRow.includes(`${BOLD}${hot}u`));
  view.item = { ...item, origin: 'unstaged' };
  view.counts = { staged: 0, unstaged: 1, untracked: 0 };
  const unstaged = render.renderFrame(view, {
    width: 80,
    height: 8,
    color: true,
  });
  const unstagedRow = unstaged.rows[unstaged.rows.length - 1];
  assert.ok(unstaged.buttons.find((hit) => hit.id === 'add'));
  assert.equal(
    unstaged.buttons.find((hit) => hit.id === 'unstage'),
    undefined,
  );
  assert.ok(unstagedRow.includes(`${BOLD}${hot}a`));
  assert.ok(unstagedRow.includes(`${rest}unstage`));
  assert.ok(!stripAnsi(unstagedRow).includes('commit'));
  assert.equal(
    unstaged.buttons.find((hit) => hit.id === 'commit'),
    undefined,
  );
});

test('branch pane lists names and marks the default branch', () => {
  const view = {
    pane: 'branches',
    branches: [
      {
        name: 'main',
        current: false,
        isDefault: true,
        sha: 'aaa1111',
        date: '2 days ago',
        subject: 'init',
        ahead: 1,
        behind: 0,
        gone: false,
      },
      {
        name: 'feat',
        current: true,
        isDefault: false,
        sha: 'bbb2222',
        date: '3 weeks ago',
        subject: 'wip',
        ahead: 0,
        behind: 2,
        gone: false,
      },
    ],
    branchCursor: 1,
    repoName: 'demo',
    counts: { staged: 0, unstaged: 0, untracked: 0 },
    branch: 'main',
    status: '',
    scroll: 0,
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: false,
  });
  const text = frame.rows.join('\n');
  const rows = frame.rows.map((row) => stripAnsi(row));
  const mainRow = rows.find((row) => row.includes('aaa1111'));
  const featRow = rows.find((row) => row.includes('bbb2222'));
  assert.ok(mainRow);
  assert.ok(featRow);
  assert.ok(mainRow.includes('main'));
  assert.ok(!mainRow.includes('['));
  assert.match(featRow, /feat/);
  assert.ok(!featRow.includes('['));
  assert.ok(!text.includes('* main'));
  assert.match(text, /aaa1111/);
  assert.match(text, /bbb2222/);
  assert.match(text, /⇡1/);
  assert.match(text, /⇣2/);
  assert.match(text, /2d ago/);
  assert.match(text, /3w ago/);
  assert.match(text, /init/);
  assert.match(text, /wip/);
  assert.match(render.headerText(view), /demo: branches$/);
  const footer = frame.rows[frame.rows.length - 1];
  assert.match(footer, /new/);
  assert.match(footer, /rebase/);
  assert.match(footer, /drop/);
  assert.match(footer, /pull/);
  assert.match(footer, /push/);
  assert.ok(!footer.includes('add'));
  assert.ok(!footer.includes('←'));
  assert.ok(!footer.includes('→'));
  assert.ok(frame.buttons.find((hit) => hit.id === 'newBranch'));
  assert.ok(frame.buttons.find((hit) => hit.id === 'pull'));
  assert.ok(frame.buttons.find((hit) => hit.id === 'push'));
  assert.equal(
    frame.buttons.find((hit) => hit.id === 'rebase'),
    undefined,
  );
  assert.equal(
    frame.buttons.find((hit) => hit.id === 'drop'),
    undefined,
  );
  assert.equal(mainRow.indexOf('aaa1111'), featRow.indexOf('bbb2222'));
  assert.ok(mainRow.endsWith('2d ago '));
  assert.ok(!mainRow.endsWith('2d ago  '));
  assert.ok(featRow.endsWith('3w ago '));
  assert.ok(!featRow.endsWith('3w ago  '));
  assert.equal(
    mainRow.indexOf('2d ago') + '2d ago'.length,
    featRow.indexOf('3w ago') + '3w ago'.length,
  );
  assert.match(featRow, /⇣2 {3}3w ago/);
  assert.equal(visibleWidth(featRow), 80);
  assert.equal(visibleWidth(mainRow), 80);
  const colored = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: true,
  });
  const mainPainted = colored.rows.find((row) => row.includes('aaa1111'));
  const featPainted = colored.rows.find((row) => row.includes('bbb2222'));
  const currentBg = bg(THEME.currentBg);
  const rowBg = bg(THEME.ctxBg);
  const mainName = `${BOLD}${fg(THEME.warnFg)}${rowBg}`;
  const currentName = `${fg(THEME.mutedFg)}${currentBg}`;
  assert.ok(mainPainted.includes(`${mainName}main`));
  assert.ok(!mainPainted.includes(bg(THEME.warnFg)));
  assert.ok(!mainPainted.includes(currentBg));
  const shaTone = `${fg(THEME.shaFg)}${bg(THEME.ctxBg)}`;
  assert.ok(mainPainted.includes(`${shaTone}aaa1111`));
  assert.ok(featPainted.includes(`${currentName}feat`));
  assert.ok(!featPainted.includes(`${fg(THEME.buttonHotFg)}${currentBg}`));
  assert.ok(featPainted.includes(`${fg(THEME.shaDarkFg)}${currentBg}`));
  assert.ok(!featPainted.includes(`${fg(THEME.shaFg)}${currentBg}`));
  assert.ok(featPainted.includes(`${fg(THEME.headerFg)}${currentBg}`));
  const date = ansi.paint('3w ago', THEME.headerFg, THEME.currentBg, true);
  const dateTail = ansi.paint(' ', THEME.headerFg, THEME.currentBg, true);
  const currentLead = ansi.paint(' ▶ ', THEME.headerFg, THEME.currentBg, true);
  assert.ok(featPainted.includes(currentLead));
  assert.ok(featPainted.includes(`${date}${dateTail}`));
  assert.ok(!featPainted.includes(bg(THEME.ctxBg)));
  assert.ok(featPainted.includes(`${fg(THEME.delLineFg)}${currentBg}`));
  assert.ok(!featPainted.includes(bg(THEME.buttonHotFg)));
  const rest = seq(THEME.buttonFg, THEME.buttonBg);
  const hot = seq(THEME.buttonHotFg, THEME.buttonBg);
  const currentFooter = colored.rows[colored.rows.length - 1];
  assert.ok(currentFooter.includes(`${rest}rebase`));
  assert.ok(currentFooter.includes(`${rest}drop`));
  assert.ok(!currentFooter.includes(`${BOLD}${hot}r`));
  assert.ok(!currentFooter.includes(`${BOLD}${hot}d`));
  assert.ok(currentFooter.includes(`${BOLD}${hot}p`));
  assert.ok(currentFooter.includes(`${BOLD}${hot}s`));
  view.branchCursor = 0;
  const onto = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: true,
  });
  const ontoFooter = onto.rows[onto.rows.length - 1];
  const ontoFeat = onto.rows.find((row) => row.includes('bbb2222'));
  const ontoMain = onto.rows.find((row) => row.includes('aaa1111'));
  assert.ok(ontoFeat.includes(currentBg));
  const currentPlain = ansi.paint('   ', THEME.headerFg, THEME.currentBg, true);
  assert.ok(ontoFeat.includes(currentPlain));
  assert.ok(!ontoFeat.includes(bg(THEME.ctxBg)));
  const selectDate = ansi.paint('2d ago', THEME.mutedFg, THEME.buttonBg, true);
  const selectTail = ansi.paint(' ', THEME.chromeFg, THEME.buttonBg, true);
  assert.ok(ontoMain.includes(`${selectDate}${selectTail}`));
  assert.ok(!ontoMain.includes(bg(THEME.ctxBg)));
  assert.ok(onto.buttons.find((hit) => hit.id === 'rebase'));
  assert.ok(onto.buttons.find((hit) => hit.id === 'drop'));
  assert.equal(
    onto.buttons.find((hit) => hit.id === 'pull'),
    undefined,
  );
  assert.equal(
    onto.buttons.find((hit) => hit.id === 'push'),
    undefined,
  );
  assert.ok(ontoFooter.includes(`${BOLD}${hot}r`));
  assert.ok(ontoFooter.includes(`${BOLD}${hot}d`));
  assert.ok(ontoFooter.includes(`${rest}pull`));
  assert.ok(ontoFooter.includes(`${rest}push`));
  assert.ok(!ontoFooter.includes(`${BOLD}${hot}p`));
  assert.ok(!ontoFooter.includes(`${BOLD}${hot}s`));
});

test('branch pane types a new name on a row under the list', () => {
  const view = {
    pane: 'branches',
    branches: [
      {
        name: 'main',
        current: true,
        isDefault: true,
        sha: 'aaa1111',
        date: '2 days ago',
        subject: 'init',
        ahead: 0,
        behind: 0,
        gone: false,
      },
      {
        name: 'feat',
        current: false,
        isDefault: false,
        sha: 'bbb2222',
        date: '3 weeks ago',
        subject: 'wip',
        ahead: 0,
        behind: 0,
        gone: false,
      },
    ],
    branchCursor: 0,
    compose: { kind: 'branch', text: 'topic', cursor: 5 },
    repoName: 'demo',
    counts: { staged: 0, unstaged: 0, untracked: 0 },
    branch: 'main',
    status: '',
    scroll: 0,
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: false,
  });
  const rows = frame.rows.map((row) => stripAnsi(row));
  const featAt = rows.findIndex((row) => row.includes('bbb2222'));
  const topicAt = rows.findIndex(
    (row, i) => i > featAt && row.includes('topic'),
  );
  assert.ok(featAt >= 0);
  assert.ok(topicAt > featAt);
  assert.ok(topicAt < rows.length - 2);
  const mainRow = rows.find((row) => row.includes('aaa1111'));
  assert.match(mainRow, /main/);
  assert.ok(!mainRow.includes('['));
  assert.equal(frame.cursor.y, topicAt + 1);
  assert.match(render.headerText(view), /demo: branches$/);
});

test('AC26 file list status and counts are column-aligned', () => {
  const files = [
    {
      path: 'a.js',
      status: 'unstaged',
      remaining: 4,
      staged: 0,
      added: 12,
      removed: 5,
      firstIndex: 0,
    },
    {
      path: 'b.js',
      status: 'staged',
      remaining: 1,
      staged: 1,
      added: 3,
      removed: 1,
      firstIndex: 1,
    },
    {
      path: 'README.md',
      status: 'untracked',
      remaining: 12,
      staged: 0,
      added: 20,
      removed: 0,
      firstIndex: 2,
    },
  ];
  const base = {
    pane: 'files',
    files,
    repoName: 'demo',
    counts: { staged: 1, unstaged: 1, untracked: 1 },
    status: '',
    scroll: 0,
    fileCursor: 0,
  };
  const frame = render.renderFrame(base, {
    width: 48,
    height: 10,
    color: false,
  });
  const rows = [2, 3, 4].map((i) => stripAnsi(frame.rows[i]));
  const columnMarks = (row) => {
    const t = row.trimEnd();
    const add = /\+[0-9]+/.exec(t);
    const del = /-[0-9]+/.exec(t);
    const status = /(unstaged|staged|untracked)/.exec(t);
    const ratio = /(\d+)\/(\d+)$/.exec(t);
    const addEnd = add.index + add[0].length;
    const delEnd = del.index + del[0].length;
    const statusEnd = status.index + status[0].length;
    const slashAt = ratio.index + ratio[1].length;
    return { addEnd, delEnd, statusEnd, slashAt };
  };
  const marks = rows.map(columnMarks);
  assert.equal(new Set(marks.map((m) => m.addEnd)).size, 1);
  assert.equal(new Set(marks.map((m) => m.delEnd)).size, 1);
  assert.equal(new Set(marks.map((m) => m.statusEnd)).size, 1);
  assert.equal(new Set(marks.map((m) => m.slashAt)).size, 1);
  assert.ok(marks[0].addEnd < marks[0].delEnd);
  assert.ok(marks[0].delEnd < marks[0].statusEnd);
  assert.ok(marks[0].statusEnd < marks[0].slashAt);
  assert.match(rows[0], /unstaged/);
  assert.match(rows[1], /staged/);
  assert.match(rows[2], /untracked/);
  assert.match(rows[0], /\+12 {2}-5/);
  assert.match(rows[1], /\+3 {2}-1/);
  assert.match(rows[2], /\+20 {2}-0/);
  assert.match(rows[0], /0\/4/);
  assert.match(rows[1], /1\/1/);
  assert.match(rows[2], /0\/12/);
  const slim = render.renderFrame(base, {
    width: 48,
    height: 4,
    color: false,
  });
  const first = stripAnsi(slim.rows[2]);
  assert.match(first, /unstaged {2}0\/4 {2}$/);
});

test('file list dates are right-aligned', () => {
  const files = [
    {
      path: 'a.js',
      status: 'unstaged',
      remaining: 1,
      staged: 0,
      added: 1,
      removed: 0,
      date: '2 hours ago',
      firstIndex: 0,
    },
    {
      path: 'b.js',
      status: 'staged',
      remaining: 1,
      staged: 1,
      added: 1,
      removed: 0,
      date: 'yesterday',
      firstIndex: 1,
    },
  ];
  const frame = render.renderFrame(
    {
      pane: 'files',
      files,
      fileCursor: 0,
      repoName: 'demo',
      counts: { staged: 1, unstaged: 1, untracked: 0 },
      status: '',
      scroll: 0,
    },
    { width: 80, height: 8, color: false },
  );
  const rows = [2, 3].map((i) => stripAnsi(frame.rows[i]));
  const recent = rows.find((row) => row.includes('a.js'));
  const older = rows.find((row) => row.includes('b.js'));
  assert.ok(recent.endsWith('2h ago '));
  assert.ok(older.endsWith('1d ago '));
  assert.equal(
    recent.indexOf('2h ago') + '2h ago'.length,
    older.indexOf('1d ago') + '1d ago'.length,
  );
  const colored = render.renderFrame(
    {
      pane: 'files',
      files,
      fileCursor: 0,
      repoName: 'demo',
      counts: { staged: 1, unstaged: 1, untracked: 0 },
      status: '',
      scroll: 0,
    },
    { width: 80, height: 8, color: true },
  );
  const painted = colored.rows.find((row) => row.includes('2h ago'));
  const age = ansi.paint('2h ago', THEME.mutedFg, THEME.buttonBg, true);
  assert.ok(painted.includes(age));
});

test('file list TODOs n/m aligns with file staged/remaining', () => {
  const files = [
    {
      path: 'Repository TODOs and Issues',
      kind: 'todos',
      status: 'todos',
      remaining: 5,
      staged: 2,
      firstIndex: 0,
    },
    {
      path: 'a.js',
      status: 'unstaged',
      remaining: 4,
      staged: 0,
      added: 12,
      removed: 5,
      firstIndex: 0,
    },
  ];
  const frame = render.renderFrame(
    {
      pane: 'files',
      files,
      fileCursor: 0,
      repoName: 'demo',
      counts: { staged: 0, unstaged: 1, untracked: 0, todo: 5 },
      status: '',
      scroll: 0,
    },
    { width: 48, height: 8, color: false },
  );
  const todoRow = stripAnsi(frame.rows[2]);
  const fileRow = stripAnsi(frame.rows[3]);
  assert.match(todoRow, /2\/5\s*$/);
  assert.match(fileRow, /0\/4\s*$/);
  assert.equal(todoRow.lastIndexOf('/'), fileRow.lastIndexOf('/'));
});

test('file list paints git status colors', () => {
  const files = [
    {
      path: 'a.js',
      status: 'unstaged',
      remaining: 1,
      staged: 0,
      firstIndex: 0,
    },
    { path: 'b.js', status: 'staged', remaining: 1, staged: 1, firstIndex: 1 },
    {
      path: 'c.js',
      status: 'untracked',
      remaining: 1,
      staged: 0,
      firstIndex: 2,
    },
    {
      path: 'd.js',
      status: 'partial',
      remaining: 3,
      staged: 2,
      unstaged: 1,
      firstIndex: 3,
    },
  ];
  const view = {
    pane: 'files',
    files,
    fileCursor: 0,
    repoName: 'demo',
    counts: { staged: 1, unstaged: 1, untracked: 1 },
    status: '',
    scroll: 0,
  };
  const frame = render.renderFrame(view, {
    width: 48,
    height: 10,
    color: true,
  });
  assert.ok(frame.rows[2].includes(fg(THEME.delLineFg)));
  assert.ok(frame.rows[3].includes(fg(THEME.addLineFg)));
  assert.ok(frame.rows[3].includes(fg(THEME.delLineFg)));
  assert.ok(frame.rows[4].includes(fg(THEME.mutedFg)));
  assert.ok(frame.rows[5].includes(fg(THEME.warnFg)));
  assert.ok(!frame.rows[3].includes(fg(THEME.warnFg)));
  const mixed = stripAnsi(frame.rows[5]);
  assert.match(mixed, /partial/);
  assert.match(mixed, /2\/3/);
});

test('AC25 header path roles use distinct greys', () => {
  assert.notDeepEqual(THEME.headerRepoFg, THEME.headerDirFg);
  assert.notDeepEqual(THEME.headerDirFg, THEME.headerFileFg);
  assert.notDeepEqual(THEME.headerSlashFg, THEME.headerDirFg);
  assert.notDeepEqual(THEME.headerSlashFg, THEME.headerFileFg);
  const view = {
    pane: 'diff',
    item: {
      origin: 'unstaged',
      file: {
        newPath: 'lib/database.js',
        oldPath: 'lib/database.js',
        isBinary: false,
      },
      hunk: sampleHunk([{ type: 'add', text: 'x', noNl: false, blockId: 0 }]),
      blockId: 0,
    },
    index: 0,
    total: 1,
    repoName: 'metasql',
    counts: { staged: 0, unstaged: 1, untracked: 0 },
    status: '',
    scroll: 0,
  };
  assert.match(render.headerText(view), /metasql\/lib\/database\.js/);
  const frame = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: true,
  });
  const row = frame.rows[0];
  assert.ok(row.includes(fg(THEME.headerRepoFg)));
  assert.ok(row.includes(fg(THEME.headerDirFg)));
  assert.ok(row.includes(fg(THEME.headerSlashFg)));
  assert.ok(row.includes(fg(THEME.headerFileFg)));
  const plain = stripAnsi(row);
  assert.match(plain, /metasql\/lib\/database\.js/);
});

test('presentRows overwrites in place without a leading wipe', () => {
  const out = render.presentRows(['aa', 'bb'], { clear: false });
  assert.ok(out.startsWith(`${ESC}[?25l`));
  assert.ok(out.includes(`${ESC}[?2026h`));
  assert.ok(!out.includes(`${ESC}[2J`));
  assert.ok(out.includes(`${ESC}[1;1H`));
  assert.ok(out.includes(`${ESC}[2;1H`));
  const hide = out.indexOf(`${ESC}[?25l`);
  const firstRow = out.indexOf(`${ESC}[1;1H`);
  const syncEnd = out.indexOf(`${ESC}[?2026l`);
  assert.ok(syncEnd >= 0);
  assert.ok(hide < firstRow);
});

test('presentRows clear stays inside the synchronized region', () => {
  const out = render.presentRows(['aa'], { clear: true });
  const sync = out.indexOf(`${ESC}[?2026h`);
  const wipe = out.indexOf(`${ESC}[2J`);
  const end = out.indexOf(`${ESC}[?2026l`);
  assert.ok(sync >= 0);
  assert.ok(wipe > sync);
  assert.ok(wipe < end);
});

test('presentRows hides the cursor before painting rows', () => {
  const out = render.presentRows(['aa'], { cursor: { x: 3, y: 2 } });
  const hide = out.indexOf(`${ESC}[?25l`);
  const sync = out.indexOf(`${ESC}[?2026h`);
  const firstRow = out.indexOf(`${ESC}[1;1H`);
  assert.ok(hide >= 0);
  assert.ok(hide < sync);
  assert.ok(sync < firstRow);
});

test('presentRows shows a blinking cursor after the sync region', () => {
  const out = render.presentRows(['aa'], { cursor: { x: 3, y: 2 } });
  const syncEnd = out.indexOf(`${ESC}[?2026l`);
  const pos = out.indexOf(`${ESC}[2;3H`);
  const style = out.indexOf(`${ESC}[1 q`);
  const blink = out.indexOf(`${ESC}[?12h`);
  const show = out.indexOf(`${ESC}[?25h`);
  assert.ok(syncEnd >= 0);
  assert.ok(pos > syncEnd);
  assert.ok(style > pos);
  assert.ok(blink > style);
  assert.ok(show > blink);
});

test('presentCursor hides or shows at the edit cell', () => {
  assert.equal(render.presentCursor(null), `${ESC}[?25l`);
  const shown = render.presentCursor({ x: 4, y: 7 });
  assert.ok(shown.startsWith(`${ESC}[7;4H`));
  assert.ok(shown.includes(`${ESC}[?25h`));
  assert.ok(!shown.includes(`${ESC}[?2026h`));
});

test('commit review header and counts use short sha', () => {
  const hunk = sampleHunk([
    { type: 'add', text: 'x', noNl: false, blockId: 0 },
  ]);
  const view = {
    item: {
      origin: 'commit',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk,
      blockId: 0,
    },
    index: 0,
    total: 1,
    scroll: 0,
    status: '',
    revShort: '7ac260c',
    counts: { staged: 0, unstaged: 0, untracked: 0, commit: 1 },
    repoName: 'demo',
  };
  assert.match(render.headerText(view), /reslop: demo\/f\.js$/);
  const frame = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: false,
  });
  assert.match(
    frame.text,
    /commit 7ac260c {2}1 {2}feedback 0 {2}todo 0 {2}code 0/,
  );
});

test('PR review header and counts use pull request label', () => {
  const hunk = sampleHunk([
    { type: 'add', text: 'x', noNl: false, blockId: 0 },
  ]);
  const view = {
    item: {
      origin: 'pr',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk,
      blockId: 0,
    },
    index: 0,
    total: 1,
    scroll: 0,
    status: '',
    sourceKind: 'pr',
    sourceLabel: '#123',
    counts: { staged: 0, unstaged: 0, untracked: 0, commit: 0, pr: 1 },
    repoName: 'acme/app',
  };
  assert.match(render.headerText(view), /reslop: acme\/app\/f\.js$/);
  const frame = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: false,
  });
  assert.match(frame.text, /pr #123 {2}1 {2}feedback 0 {2}todo 0 {2}code 0/);
});

test('MR review header and counts use merge request label', () => {
  const hunk = sampleHunk([
    { type: 'add', text: 'x', noNl: false, blockId: 0 },
  ]);
  const view = {
    item: {
      origin: 'pr',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk,
      blockId: 0,
    },
    index: 0,
    total: 1,
    scroll: 0,
    status: '',
    sourceKind: 'mr',
    sourceLabel: '!123',
    counts: { staged: 0, unstaged: 0, untracked: 0, commit: 0, pr: 1 },
    repoName: 'acme/app',
  };
  assert.match(render.headerText(view), /reslop: acme\/app\/f\.js$/);
  const frame = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: false,
  });
  assert.match(frame.text, /mr !123 {2}1 {2}feedback 0 {2}todo 0 {2}code 0/);
});

test('compose panel sits above status and buttons', () => {
  const hunk = sampleHunk([
    { type: 'add', text: 'x', noNl: false, blockId: 0 },
  ]);
  const view = reviewView(
    {
      origin: 'unstaged',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk,
      blockId: 0,
    },
    {
      pane: 'diff',
      compose: { kind: 'feedback', text: 'extract helper', cursor: 14 },
    },
  );
  const frame = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: false,
  });
  assert.equal(frame.rows.length, 16);
  const statusRow = frame.rows[frame.rows.length - 2];
  const buttonRow = frame.rows[frame.rows.length - 1];
  assert.match(statusRow, /0\/1/);
  assert.match(buttonRow, /feedback/);
  assert.match(buttonRow, /edit/);
  assert.ok(!buttonRow.includes('code'));
  assert.ok(!buttonRow.includes('reload'));
  assert.ok(!buttonRow.includes('files'));
  const joined = frame.rows.join('\n');
  const noteAt = joined.indexOf('extract helper');
  const statusAt = joined.indexOf(statusRow);
  assert.ok(noteAt >= 0 && noteAt < statusAt);
  assert.ok(!joined.includes('1 add tests'));
  assert.ok(frame.cursor);
});

test('feedback compose paints templates above the input', () => {
  const hunk = sampleHunk([
    { type: 'add', text: 'x', noNl: false, blockId: 0 },
  ]);
  const view = reviewView(
    {
      origin: 'unstaged',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk,
      blockId: 0,
    },
    {
      pane: 'diff',
      compose: { kind: 'feedback', text: 'new note', cursor: 0 },
      templates: [
        { text: 'extract helper', count: 2 },
        { text: 'add tests', count: 1 },
      ],
      templateIndex: 0,
    },
  );
  const frame = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: true,
  });
  const joined = stripAnsi(frame.rows.join('\n'));
  const pickAt = joined.indexOf('extract helper');
  const otherAt = joined.indexOf('add tests');
  const inputAt = joined.indexOf('new note');
  assert.ok(pickAt >= 0 && pickAt < inputAt);
  assert.ok(otherAt >= 0 && otherAt < inputAt);
  const picked = frame.rows.find((row) => row.includes('extract helper'));
  const idle = frame.rows.find((row) => row.includes('add tests'));
  assert.ok(picked.includes(bg(THEME.buttonBg)));
  assert.ok(idle.includes(bg(THEME.noteBg)));
  assert.equal(frame.templateHits.length, 2);
  assert.equal(frame.templateHits[0].cursor, 0);
  assert.equal(frame.templateHits[1].cursor, 1);
  assert.equal(frame.templateHits[1].y, frame.templateHits[0].y + 1);
  assert.ok(frame.cursor.y > frame.templateHits[1].y);
});

test('todo compose does not paint feedback templates', () => {
  const view = {
    pane: 'diff',
    item: {
      origin: 'todo',
      todoId: 1,
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk: null,
      blockId: 'todo-1',
    },
    index: 0,
    total: 1,
    scroll: 0,
    status: '',
    counts: { staged: 0, unstaged: 0, untracked: 0, todo: 1 },
    repoName: 'demo',
    todos: ['[ ] rewrite this'],
    todoFocus: 0,
    todoEdit: { cursor: 0 },
    templates: [{ text: 'extract helper', count: 1 }],
    templateIndex: 0,
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: false,
  });
  const body = stripAnsi(frame.rows.join('\n'));
  assert.match(body, /rewrite this/);
  assert.ok(!body.includes('extract helper'));
  assert.equal(frame.templateHits.length, 0);
});

test('compose and idle notes keep one-char side margins', () => {
  const hunk = sampleHunk([
    { type: 'add', text: 'x', noNl: false, blockId: 0 },
  ]);
  const base = reviewView(
    {
      origin: 'unstaged',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk,
      blockId: 0,
    },
    { pane: 'diff' },
  );
  const opt = { width: 80, height: 16, color: false };
  const compose = render.renderFrame(
    { ...base, compose: { kind: 'feedback', text: 'hi', cursor: 0 } },
    opt,
  );
  const composeRow = compose.rows.find((row) => row.includes('hi'));
  assert.match(stripAnsi(composeRow), /^ hi /);
  assert.equal(compose.cursor.x, 2);
  const idle = render.renderFrame({ ...base, noteText: 'hi' }, opt);
  const idleRow = idle.rows.find((row) => row.includes('feedback: hi'));
  assert.match(stripAnsi(idleRow), /^ feedback: hi /);
});

test('idle feedback note sits above the footer', () => {
  const hunk = sampleHunk([
    { type: 'add', text: 'x', noNl: false, blockId: 0 },
  ]);
  const view = {
    pane: 'diff',
    item: {
      origin: 'unstaged',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk,
      blockId: 0,
    },
    index: 0,
    total: 1,
    scroll: 0,
    status: 'copied',
    counts: { staged: 0, unstaged: 1, untracked: 0 },
    repoName: 'demo',
    noteText: '[ ] extract helper',
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: false,
  });
  const statusRow = frame.rows[frame.rows.length - 2];
  assert.match(statusRow, /copied /);
  const joined = frame.rows.join('\n');
  assert.match(joined, /feedback: \[ \] extract helper/);
  const noteAt = joined.indexOf('feedback: [ ] extract helper');
  assert.ok(noteAt >= 0 && noteAt < joined.indexOf(statusRow));
});

test('note panel is lighter than the status line', () => {
  const hunk = sampleHunk([
    { type: 'add', text: 'x', noNl: false, blockId: 0 },
  ]);
  const base = reviewView(
    {
      origin: 'unstaged',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk,
      blockId: 0,
    },
    { pane: 'diff' },
  );
  const opt = { width: 80, height: 16, color: true };
  const idle = render.renderFrame({ ...base, noteText: 'extract helper' }, opt);
  const compose = render.renderFrame(
    {
      ...base,
      compose: { kind: 'feedback', text: 'rewrite loop', cursor: 0 },
    },
    opt,
  );
  const idleNote = idle.rows.find((row) => row.includes('extract helper'));
  const composeNote = compose.rows.find((row) => row.includes('rewrite loop'));
  const statusRow = idle.rows[idle.rows.length - 2];
  const noteBg = bg(THEME.noteBg);
  const chromeBg = bg(THEME.chromeBg);
  assert.notDeepEqual(THEME.noteBg, THEME.chromeBg);
  assert.ok(idleNote.includes(noteBg));
  assert.ok(composeNote.includes(noteBg));
  assert.ok(!idleNote.includes(chromeBg));
  assert.ok(statusRow.includes(chromeBg));
  assert.ok(!statusRow.includes(noteBg));
});

test('todo view paints file todo text not a diff hunk', () => {
  const view = {
    pane: 'diff',
    item: {
      origin: 'todo',
      todoId: 1,
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk: null,
      blockId: 'todo-1',
    },
    index: 0,
    total: 1,
    scroll: 0,
    status: '',
    counts: { staged: 0, unstaged: 0, untracked: 0, todo: 1 },
    repoName: 'demo',
    todos: ['[ ] rewrite this', '[x] already done'],
    todoFocus: 0,
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: false,
  });
  const body = stripAnsi(frame.rows.join('\n'));
  const captionAt = body.indexOf('Repository TODOs and Issues');
  const firstAt = body.indexOf('[ ] rewrite this');
  assert.ok(captionAt >= 0 && captionAt < firstAt);
  assert.match(body, /\[ \] rewrite this/);
  assert.match(body, /\[x\] already done/);
  assert.ok(!stripAnsi(frame.rows[2]).startsWith('+'));
  assert.ok(!stripAnsi(frame.rows[2]).startsWith('-'));
  assert.match(body, /demo: TODOs/);
  assert.ok(!body.includes('todo 1/1'));
  assert.ok(!body.includes('demo/TODOs'));
  const footer = frame.rows[frame.rows.length - 1];
  assert.match(footer, /← {2}→ {2}x/);
  assert.ok(!footer.includes('q'));
  assert.ok(!footer.includes('prev'));
  assert.ok(!footer.includes('next'));
  assert.ok(!footer.includes('quit'));
  assert.ok(!footer.includes('files'));
  assert.ok(!footer.includes('reload'));
  assert.ok(!footer.includes('add'));
  assert.ok(!footer.includes('drop'));
  assert.ok(!footer.includes('mode'));
  assert.ok(!footer.includes('feedback'));
  assert.ok(!footer.includes('code'));
  assert.ok(!footer.includes('todo'));
  assert.ok(!footer.includes('commit'));
  assert.ok(!footer.includes('del'));
  assert.ok(!footer.includes('edit'));
  assert.ok(!footer.includes('⏎'));
  const colored = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: true,
  });
  const caption = colored.rows[2];
  assert.match(stripAnsi(caption), /Repository TODOs and Issues/);
  assert.ok(!stripAnsi(caption).includes('demo'));
  assert.ok(caption.includes(BOLD));
  assert.ok(caption.includes(fg(THEME.buttonHotFg)));
});

test('todo list stays visible while composing', () => {
  const view = {
    pane: 'diff',
    item: {
      origin: 'todo',
      todoId: 1,
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk: null,
      blockId: 'todo-1',
    },
    index: 0,
    total: 1,
    scroll: 0,
    status: '',
    counts: { staged: 0, unstaged: 0, untracked: 0, todo: 2 },
    repoName: 'demo',
    todos: ['[ ] rewrite this', '[x] already done'],
    todoFocus: 0,
    todoEdit: { cursor: 12 },
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: false,
  });
  const body = stripAnsi(frame.rows.join('\n'));
  assert.match(body, /\[ \] rewrite this/);
  assert.match(body, /\[x\] already done/);
  const footer = frame.rows.find((row) => {
    const plain = stripAnsi(row);
    return plain.includes('rewrite this') && !plain.includes('[ ]');
  });
  assert.equal(footer, undefined);
  const hit = frame.todoHits.find((row) => row.cursor === 0);
  assert.ok(hit);
  assert.equal(frame.cursor.y, hit.y);
});

test('todo list paints the focused row on the selection bar', () => {
  const view = {
    pane: 'diff',
    item: {
      origin: 'todo',
      todoId: 1,
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk: null,
      blockId: 'todo-1',
    },
    index: 0,
    total: 1,
    scroll: 0,
    status: '',
    counts: { staged: 0, unstaged: 0, untracked: 0, todo: 2 },
    repoName: 'demo',
    todos: ['[ ] rewrite this', '[x] already done'],
    todoFocus: 1,
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: true,
  });
  const focused = frame.rows.find((row) => row.includes('already done'));
  const idle = frame.rows.find((row) => row.includes('rewrite this'));
  const selectBg = bg(THEME.buttonBg);
  const idleBg = bg(THEME.ctxBg);
  assert.ok(focused);
  assert.ok(idle);
  assert.ok(focused.includes(selectBg));
  assert.ok(!focused.includes(idleBg));
  assert.ok(idle.includes(idleBg));
  assert.ok(!idle.includes(selectBg));
});

test('checkbox marks use a contrast chip on todo and note rows', () => {
  const hunk = sampleHunk([
    { type: 'add', text: 'x', noNl: false, blockId: 0 },
  ]);
  const todoView = {
    pane: 'diff',
    item: {
      origin: 'todo',
      todoId: 1,
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk: null,
      blockId: 'todo-1',
    },
    index: 0,
    total: 1,
    scroll: 0,
    status: '',
    counts: { staged: 0, unstaged: 0, untracked: 0, todo: 2 },
    repoName: 'demo',
    todos: ['[ ] rewrite this', '[x] already done'],
    todoFocus: 0,
  };
  const noteView = reviewView(
    {
      origin: 'unstaged',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk,
      blockId: 0,
    },
    { pane: 'diff', noteText: '[x] extract helper' },
  );
  const opt = { width: 80, height: 16, color: true };
  const todos = render.renderFrame(todoView, opt);
  const note = render.renderFrame(noteView, opt);
  const openRow = todos.rows.find((row) => row.includes('rewrite this'));
  const doneRow = todos.rows.find((row) => row.includes('already done'));
  const noteRow = note.rows.find((row) => row.includes('extract helper'));
  const openBg = bg(THEME.checkBg);
  const doneBg = bg(THEME.checkDoneBg);
  assert.notDeepEqual(THEME.checkBg, THEME.ctxBg);
  assert.notDeepEqual(THEME.checkBg, THEME.buttonBg);
  assert.notDeepEqual(THEME.checkBg, THEME.noteBg);
  assert.notDeepEqual(THEME.checkDoneBg, THEME.checkBg);
  assert.ok(openRow.includes(openBg));
  assert.ok(!openRow.includes(doneBg));
  assert.ok(doneRow.includes(doneBg));
  assert.ok(!doneRow.includes(openBg));
  assert.ok(noteRow.includes(doneBg));
  assert.ok(noteRow.includes(bg(THEME.noteBg)));
});

test('todo list exposes a click hit for each todo row', () => {
  const view = {
    pane: 'diff',
    item: {
      origin: 'todo',
      todoId: 1,
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk: null,
      blockId: 'todo-1',
    },
    index: 0,
    total: 1,
    scroll: 0,
    status: '',
    counts: { staged: 0, unstaged: 0, untracked: 0, todo: 2 },
    repoName: 'demo',
    todos: ['[ ] rewrite this', '[x] already done'],
    todoFocus: 0,
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: false,
  });
  const boxes = frame.todoHits.filter((hit) => hit.check === true);
  const rows = frame.todoHits.filter((hit) => hit.check !== true);
  assert.equal(boxes.length, 2);
  assert.equal(rows.length, 2);
  assert.equal(boxes[0].cursor, 0);
  assert.equal(boxes[0].x0, 1);
  assert.equal(boxes[0].x1, 4);
  assert.equal(rows[0].cursor, 0);
  assert.equal(rows[1].cursor, 1);
  assert.equal(rows[1].y, rows[0].y + 1);
  assert.ok(rows[0].y > 1);
});

test('todo wrap hangs under the checkbox text', () => {
  const view = {
    pane: 'diff',
    item: {
      origin: 'todo',
      todoId: 1,
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk: null,
      blockId: 'todo-1',
    },
    index: 0,
    total: 1,
    scroll: 0,
    status: '',
    counts: { staged: 0, unstaged: 0, untracked: 0, todo: 1 },
    repoName: 'demo',
    todos: ['[ ] abcdefghijklmnopqrstuvwxyz12'],
    todoFocus: 0,
    todoEdit: { cursor: 14 },
  };
  const frame = render.renderFrame(view, {
    width: 20,
    height: 12,
    color: false,
  });
  const first = frame.rows.find((row) => stripAnsi(row).includes('[ ]'));
  const second = frame.rows.find((row) => {
    const plain = stripAnsi(row);
    return plain.includes('opqrstuvwxyz12') && !plain.includes('[ ]');
  });
  assert.ok(first);
  assert.ok(second);
  const firstPlain = stripAnsi(first);
  const secondPlain = stripAnsi(second);
  assert.match(firstPlain, /^ \[ \] abcdefghijklmn/);
  assert.match(secondPlain, /^ {5}opqrstuvwxyz12/);
  const lead = ' [ ] ';
  const hang = '     ';
  const chunk0 = firstPlain.trimEnd().slice(lead.length);
  const chunk1 = secondPlain.trimEnd().slice(hang.length);
  assert.equal(visibleWidth(chunk0), visibleWidth(chunk1));
  assert.equal(firstPlain.indexOf('a'), secondPlain.indexOf('o'));
  assert.equal(frame.cursor.x, 6);
  const rows = frame.todoHits.filter((hit) => hit.check !== true);
  assert.equal(frame.cursor.y, rows[1].y);
});

test('wrapPlain moves whole words to the next line', () => {
  assert.deepEqual(wrap.wrapPlain('hello world', 8), ['hello ', 'world']);
  assert.deepEqual(wrap.wrapPlain('extract helper', 10), [
    'extract ',
    'helper',
  ]);
  assert.deepEqual(wrap.wrapPlain('feedback: extract helper', 14), [
    'feedback: ',
    'extract helper',
  ]);
  const long = wrap.wrapPlain('supercalifragilistic', 8);
  assert.deepEqual(long, ['supercal', 'ifragili', 'stic']);
  assert.equal(long.join(''), 'supercalifragilistic');
  const words = wrap.wrapPlain('alpha beta gamma', 8);
  assert.deepEqual(words, ['alpha ', 'beta ', 'gamma']);
  for (const row of words) assert.ok(visibleWidth(row) <= 8);
});

test('cursorInWrap follows word wrap', () => {
  const text = 'hello world';
  assert.deepEqual(wrap.cursorInWrap(text, 0, 8), { row: 0, col: 0 });
  assert.deepEqual(wrap.cursorInWrap(text, 6, 8), { row: 1, col: 0 });
  assert.deepEqual(wrap.cursorInWrap(text, 11, 8), { row: 1, col: 5 });
  assert.deepEqual(wrap.cursorInWrap('ab\ncd', 2, 8), { row: 0, col: 2 });
  assert.deepEqual(wrap.cursorInWrap('ab\ncd', 3, 8), { row: 1, col: 0 });
});

test('wrapMove walks visual rows of one wrapped line', () => {
  const text = 'hello world';
  const down = wrap.wrapMove(text, 0, 8, 1, null);
  assert.equal(down.cursor, 6);
  assert.equal(down.col, 0);
  const up = wrap.wrapMove(text, 6, 8, -1, null);
  assert.equal(up.cursor, 0);
  const fromEnd = wrap.wrapMove(text, 11, 8, -1, null);
  assert.equal(fromEnd.cursor, 5);
  const back = wrap.wrapMove(text, fromEnd.cursor, 8, 1, fromEnd.col);
  assert.equal(back.cursor, 11);
  const edge = wrap.wrapMove(text, 0, 8, -1, null);
  assert.equal(edge.cursor, 0);
});

test('wrapMove keeps a column across a short visual row', () => {
  const text = 'abc de fghij';
  const up = wrap.wrapMove(text, 12, 5, -1, null);
  assert.equal(up.cursor, 6);
  const upAgain = wrap.wrapMove(text, up.cursor, 5, -1, up.col);
  assert.equal(upAgain.cursor, 3);
  const down = wrap.wrapMove(text, upAgain.cursor, 5, 1, upAgain.col);
  assert.equal(down.cursor, 6);
  const downAgain = wrap.wrapMove(text, down.cursor, 5, 1, down.col);
  assert.equal(downAgain.cursor, 12);
});

test('compose and idle notes wrap on word boundaries', () => {
  const hunk = sampleHunk([
    { type: 'add', text: 'x', noNl: false, blockId: 0 },
  ]);
  const base = reviewView(
    {
      origin: 'unstaged',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk,
      blockId: 0,
    },
    { pane: 'diff' },
  );
  const opt = { width: 20, height: 16, color: false };
  const compose = render.renderFrame(
    {
      ...base,
      compose: {
        kind: 'feedback',
        text: 'outstanding example',
        cursor: 12,
      },
    },
    opt,
  );
  const composeNote = compose.rows
    .map(stripAnsi)
    .filter((row) => row.includes('outstanding') || row.includes('example'));
  assert.ok(
    composeNote.some(
      (row) => row.includes('outstanding') && !row.includes('example'),
    ),
  );
  assert.ok(
    composeNote.some(
      (row) => row.includes('example') && !row.includes('outstanding'),
    ),
  );
  const idle = render.renderFrame({ ...base, noteText: 'outstanding' }, opt);
  const idleNote = idle.rows
    .map(stripAnsi)
    .filter((row) => row.includes('feedback') || row.includes('outstanding'));
  assert.ok(
    idleNote.some(
      (row) => row.includes('feedback') && !row.includes('outstanding'),
    ),
  );
  assert.ok(
    idleNote.some(
      (row) => row.includes('outstanding') && !row.includes('feedback:'),
    ),
  );
  const todo = render.renderFrame(
    {
      ...base,
      item: {
        origin: 'todo',
        todoId: 1,
        file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
        hunk: null,
        blockId: 'todo-1',
      },
      noteText: 'outstanding example',
    },
    opt,
  );
  const todoNote = todo.rows
    .map(stripAnsi)
    .filter((row) => row.includes('outstanding') || row.includes('example'));
  assert.ok(
    todoNote.some(
      (row) => row.includes('outstanding') && !row.includes('example'),
    ),
  );
  assert.ok(
    todoNote.some(
      (row) => row.includes('example') && !row.includes('outstanding'),
    ),
  );
});

test('code overlay paints proposed adds and an in-place cursor', () => {
  const hunk = sampleHunk([
    { type: 'del', text: 'a', noNl: false, blockId: 0 },
    { type: 'add', text: 'b', noNl: false, blockId: 0 },
  ]);
  const view = reviewView(
    {
      origin: 'unstaged',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk,
      blockId: 0,
    },
    {
      pane: 'diff',
      codeOverlay: { text: 'hello', keepEmpty: true, cursor: 0 },
    },
  );
  const frame = render.renderFrame(view, {
    width: 80,
    height: 16,
    color: false,
  });
  const body = stripAnsi(frame.rows.join('\n'));
  assert.match(body, /\+ hello/);
  assert.ok(!body.includes('+ b'));
  assert.ok(frame.cursor);
  assert.equal(frame.cursor.x, 3);
});

test('diff and file view wrap a long line', () => {
  const text = 'alpha beta gamma delta';
  const hunk = sampleHunk([{ type: 'add', text, noNl: false, blockId: 0 }]);
  const diffView = reviewView(
    {
      origin: 'unstaged',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk,
      blockId: 0,
    },
    { pane: 'diff' },
  );
  const diffFrame = render.renderFrame(diffView, {
    width: 20,
    height: 12,
    color: false,
  });
  const diffRows = diffFrame.rows.map((row) => stripAnsi(row));
  const head = diffRows.find((row) => row.includes('alpha beta'));
  const tail = diffRows.find(
    (row) => row.includes('delta') && !row.includes('alpha'),
  );
  assert.ok(head);
  assert.ok(tail);
  const fileView = {
    pane: 'unit',
    item: null,
    reviewPath: 'a.js',
    unitLine: 0,
    unitLines: [{ type: 'ctx', text, blockId: null, item: null, origin: '' }],
    index: 0,
    total: 1,
    scroll: 0,
    status: '',
    counts: { staged: 0, unstaged: 0, untracked: 0 },
    repoName: 'demo',
  };
  const fileFrame = render.renderFrame(fileView, {
    width: 20,
    height: 8,
    color: false,
  });
  const fileRows = fileFrame.rows.map((row) => stripAnsi(row));
  assert.ok(fileRows.some((row) => row.includes('alpha beta')));
  assert.ok(
    fileRows.some((row) => row.includes('delta') && !row.includes('alpha')),
  );
});

test('editor scrolls a long line instead of wrapping it', () => {
  const text = 'abcdefghijklmnopqrstuvwxyz';
  const hunk = sampleHunk([
    { type: 'add', text: 'b', noNl: false, blockId: 0 },
  ]);
  const view = reviewView(
    {
      origin: 'unstaged',
      file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
      hunk,
      blockId: 0,
    },
    {
      pane: 'diff',
      mode: 'compose',
      codeOverlay: {
        text,
        keepEmpty: true,
        cursor: text.length,
        scrollCol: 16,
      },
    },
  );
  const frame = render.renderFrame(view, {
    width: 20,
    height: 12,
    color: false,
  });
  const rows = frame.rows.map((row) => stripAnsi(row));
  const shown = rows.filter((row) => row.includes('qrstuvwxyz'));
  assert.equal(shown.length, 1);
  assert.ok(!rows.some((row) => row.includes('abcdef')));
  assert.equal(frame.cursor.x, 13);
});

test('unit pane marks the current block and keeps other diffs', () => {
  const current = {
    origin: 'unstaged',
    file: { newPath: 'a.js', oldPath: 'a.js', isBinary: false },
    blockId: 0,
  };
  const other = {
    origin: 'unstaged',
    file: { newPath: 'a.js', oldPath: 'a.js', isBinary: false },
    blockId: 1,
  };
  const view = {
    pane: 'unit',
    item: current,
    reviewPath: 'a.js',
    unitLine: 0,
    unitLines: [
      {
        type: 'del',
        text: 'old',
        blockId: 0,
        item: current,
        origin: 'unstaged',
      },
      {
        type: 'add',
        text: 'new',
        blockId: 0,
        item: current,
        origin: 'unstaged',
      },
      { type: 'ctx', text: 'keep', blockId: null, item: null, origin: '' },
      {
        type: 'add',
        text: 'later',
        blockId: 1,
        item: other,
        origin: 'unstaged',
      },
    ],
    index: 0,
    total: 2,
    scroll: 0,
    status: '',
    counts: { staged: 0, unstaged: 2, untracked: 0 },
    repoName: 'demo',
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: false,
  });
  const body = frame.rows.join('\n');
  assert.match(body, /- old/);
  assert.match(body, /\+ new/);
  assert.match(body, / {2}later/);
  assert.ok(!body.includes('+ later'));
  assert.match(render.headerText(view), /reslop: demo\/a\.js$/);
  const footer = frame.rows[frame.rows.length - 1];
  assert.match(footer, /add {2}unstage {2}drop/);
  assert.ok(!footer.includes('mode'));
  assert.ok(frame.buttons.find((hit) => hit.id === 'add'));
  assert.ok(frame.buttons.find((hit) => hit.id === 'code'));
  assert.equal(
    frame.buttons.find((hit) => hit.id === 'layout'),
    undefined,
  );
  assert.equal(
    frame.buttons.find((hit) => hit.id === 'file'),
    undefined,
  );
  assert.equal(frame.cursor, null);
});

test('unit pane marks every change in the current hunk', () => {
  const hunk = {
    oldStart: 1,
    oldCount: 3,
    newStart: 1,
    newCount: 3,
    header: '@@ -1,3 +1,3 @@',
  };
  const current = {
    origin: 'unstaged',
    file: { newPath: 'a.js', oldPath: 'a.js', isBinary: false },
    hunk,
    blockId: 0,
  };
  const other = {
    origin: 'unstaged',
    file: { newPath: 'a.js', oldPath: 'a.js', isBinary: false },
    hunk,
    blockId: 1,
  };
  const view = {
    pane: 'unit',
    item: current,
    reviewPath: 'a.js',
    unitLine: 0,
    unitLines: [
      {
        type: 'del',
        text: 'old',
        blockId: 0,
        item: current,
        origin: 'unstaged',
      },
      {
        type: 'add',
        text: 'new',
        blockId: 0,
        item: current,
        origin: 'unstaged',
      },
      { type: 'ctx', text: 'keep', blockId: null, item: null, origin: '' },
      {
        type: 'del',
        text: 'later',
        blockId: 1,
        item: other,
        origin: 'unstaged',
      },
      {
        type: 'add',
        text: 'next',
        blockId: 1,
        item: other,
        origin: 'unstaged',
      },
    ],
    index: 0,
    total: 2,
    scroll: 0,
    status: '',
    counts: { staged: 0, unstaged: 2, untracked: 0 },
    repoName: 'demo',
  };
  const frame = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: false,
  });
  const body = frame.rows.join('\n');
  assert.match(body, /- old/);
  assert.match(body, /\+ new/);
  assert.match(body, /- later/);
  assert.match(body, /\+ next/);
});

test('unit edit hides plus minus marks and keeps the line-end cursor', () => {
  const current = {
    origin: 'unstaged',
    file: { newPath: 'a.js', oldPath: 'a.js', isBinary: false },
    blockId: 0,
  };
  const view = reviewView(current, {
    pane: 'unit',
    mode: 'compose',
    reviewPath: 'a.js',
    unitLine: 0,
    unitLines: [
      {
        type: 'del',
        text: 'old',
        blockId: 0,
        item: current,
        origin: 'unstaged',
      },
      {
        type: 'add',
        text: 'hello',
        blockId: 0,
        item: current,
        origin: 'unstaged',
        wrap: true,
        editStart: 0,
        editEnd: 5,
        editLast: false,
      },
      {
        type: 'ctx',
        text: 'z',
        blockId: null,
        item: null,
        origin: '',
        wrap: true,
        editStart: 6,
        editEnd: 7,
        editLast: true,
      },
    ],
    codeOverlay: { text: 'hello\nz', keepEmpty: true, cursor: 5 },
  });
  const frame = render.renderFrame(view, {
    width: 80,
    height: 12,
    color: false,
  });
  const body = stripAnsi(frame.rows.join('\n'));
  assert.ok(!body.includes('+ hello'));
  assert.ok(!body.includes('- old'));
  assert.match(body, /hello/);
  assert.ok(frame.cursor);
});

test('diff and chrome pick up a theme switched after load', () => {
  const hunk = sampleHunk([
    { type: 'del', text: 'a', noNl: false, blockId: 0 },
    { type: 'add', text: 'b', noNl: false, blockId: 0 },
  ]);
  const view = reviewView({
    origin: 'unstaged',
    file: { newPath: 'f.js', oldPath: 'f.js', isBinary: false },
    hunk,
    blockId: 0,
  });
  try {
    ansi.setTheme('light');
    const frame = render.renderFrame(view, {
      width: 80,
      height: 16,
      color: true,
    });
    assert.ok(frame.text.includes(bg(ansi.PALETTES.light.ui.addLineBg)));
    assert.ok(frame.text.includes(bg(ansi.PALETTES.light.ui.headerBg)));
    assert.ok(frame.text.includes(bg(ansi.PALETTES.light.ui.buttonBg)));
    assert.ok(!frame.text.includes(bg(ansi.PALETTES.dark.ui.addLineBg)));
  } finally {
    ansi.setTheme('dark');
  }
});

test('npm output keeps a line margin and a two-space gutter', () => {
  const lines = [];
  for (let i = 0; i < 30; i++) lines.push(`line-${i}-${'x'.repeat(80)}`);
  const view = {
    pane: 'npm',
    npmView: true,
    npmOutput: `${lines.join('\n')}\n`,
    npmFollow: false,
    npmScroll: 2,
    npmCommands: [],
    repoName: 'demo',
    status: '',
    counts: {},
  };
  const frame = render.renderFrame(view, {
    width: 40,
    height: 12,
    color: false,
  });
  const bodyH = frame.bodyH;
  const body = frame.rows.slice(1, 1 + bodyH).map((row) => stripAnsi(row));
  assert.equal(body[0].trim(), '');
  assert.equal(body[body.length - 1].trim(), '');
  assert.equal(body[1].slice(0, 8), '  line-2');
  assert.ok(body[1].endsWith('  '));
  assert.equal(body[1].length, 40);
  assert.ok(!body[1].includes('x'.repeat(40)));
});

test('npm output paints a moving bar while a command runs', () => {
  const view = {
    pane: 'npm',
    npmView: true,
    npmRunning: true,
    npmOutput: 'hello\n',
    npmFollow: true,
    progressFrame: 0,
    npmCommands: [],
    repoName: 'demo',
    status: '',
    counts: {},
  };
  const opt = { width: 40, height: 12, color: false };
  const frame = render.renderFrame(view, opt);
  const bodyH = frame.bodyH;
  const body = frame.rows.slice(1, 1 + bodyH).map((row) => stripAnsi(row));
  assert.equal(body[0].trim(), '');
  assert.equal(body[body.length - 1].trim(), '');
  const hello = body.findIndex((row) => row.includes('hello'));
  assert.ok(hello > 0);
  assert.match(body[hello + 1], /^ {2}running {2}·•●•·/);
  assert.ok(hello + 1 < body.length - 2);
  view.progressFrame = 1;
  const next = render.renderFrame(view, opt);
  const moved = next.rows.slice(1, 1 + bodyH).map((row) => stripAnsi(row));
  assert.match(moved[hello + 1], /^ {2}running {2}··•●•/);
  const many = [];
  for (let i = 0; i < 40; i++) many.push(`line-${i}`);
  view.npmOutput = `${many.join('\n')}\n`;
  view.progressFrame = 0;
  const full = render.renderFrame(view, opt);
  const fullBody = full.rows.slice(1, 1 + bodyH).map((row) => stripAnsi(row));
  assert.match(fullBody[fullBody.length - 3], /line-39/);
  assert.match(fullBody[fullBody.length - 2], /^ {2}running {2}·•●•·/);
  view.npmFollow = false;
  view.npmScroll = 0;
  const top = render.renderFrame(view, opt);
  const topBody = top.rows.slice(1, 1 + bodyH).map((row) => stripAnsi(row));
  assert.match(topBody[1], /line-0/);
  assert.ok(!topBody.join('\n').includes('running'));
});

test('npm bin names are blue and package scripts stay white', () => {
  const view = {
    pane: 'npm',
    npmCommands: [
      { name: 'test', command: 'node --test', kind: 'script' },
      { name: 'eslint', command: 'eslint', kind: 'bin' },
    ],
    npmCursor: 0,
    repoName: 'demo',
    status: '',
    counts: {},
  };
  const frame = render.renderFrame(view, {
    width: 60,
    height: 10,
    color: true,
  });
  const rows = frame.rows.map((row) => stripAnsi(row));
  const script = frame.rows[rows.findIndex((row) => row.includes('test'))];
  const bin = frame.rows[rows.findIndex((row) => row.includes('eslint'))];
  const blue = seq(THEME.shaFg, THEME.ctxBg);
  const white = `${BOLD}${seq(THEME.buttonHotFg, THEME.buttonBg)}`;
  assert.ok(script.includes(`${white}test`));
  assert.ok(!script.includes(fg(THEME.shaFg)));
  assert.ok(bin.includes(`${blue}eslint`));
  assert.ok(!bin.includes(`${fg(THEME.buttonHotFg)}eslint`));
});

test('npm list aligns names and commands on the left', () => {
  const view = {
    pane: 'npm',
    npmCommands: [
      { name: 'test', command: 'node --test', kind: 'script' },
      { name: 'eslint', command: 'eslint .', kind: 'script' },
      { name: 'leftpad', command: 'leftpad', kind: 'bin' },
    ],
    npmCursor: 1,
    repoName: 'demo',
    status: '',
    counts: {},
  };
  const frame = render.renderFrame(view, {
    width: 60,
    height: 12,
    color: false,
  });
  const rows = frame.rows.map((row) => stripAnsi(row));
  const test = rows.find((row) => row.includes('node --test'));
  const lint = rows.find((row) => row.includes('eslint .'));
  const bin = rows.find((row) => row.includes('leftpad'));
  const nameAt = test.indexOf('test');
  const cmdAt = test.indexOf('node --test');
  assert.equal(lint.indexOf('eslint'), nameAt);
  assert.equal(bin.indexOf('leftpad'), nameAt);
  assert.equal(lint.indexOf('eslint .'), cmdAt);
  assert.equal(bin.indexOf('bin'), cmdAt);
  assert.equal(cmdAt, nameAt + 'leftpad'.length + 2);
});

test('npm output keeps the colors the command printed', () => {
  const red = '\x1b[31m';
  const reset = '\x1b[0m';
  const view = {
    pane: 'npm',
    npmView: true,
    npmOutput: `${red}Error: boom${reset}\n`,
    npmFollow: true,
    npmCommands: [],
    repoName: 'demo',
    status: '',
    counts: {},
  };
  const frame = render.renderFrame(view, {
    width: 40,
    height: 12,
    color: true,
  });
  assert.ok(frame.text.includes(`${red}Error: boom`));
  assert.ok(frame.text.includes(bg(THEME.ctxBg)));
  const plain = stripAnsi(frame.rows.join('\n'));
  assert.match(plain, / {2}Error: boom/);
});

test('npm output drops the command background', () => {
  const view = {
    pane: 'npm',
    npmView: true,
    npmOutput: '\x1b[31;41mError\x1b[0m\n',
    npmFollow: true,
    npmCommands: [],
    repoName: 'demo',
    status: '',
    counts: {},
  };
  const frame = render.renderFrame(view, {
    width: 40,
    height: 12,
    color: true,
  });
  assert.ok(frame.text.includes('\x1b[31mError'));
  assert.ok(frame.text.includes(bg(THEME.ctxBg)));
  assert.ok(!frame.text.includes('\x1b[41m'));
  assert.ok(!frame.text.includes('31;41'));
});

test('npm output paints assertion fields as a colored table', () => {
  const npmCommands = require('../lib/npm-commands.js');
  const { reduceOutput } = npmCommands;
  const mark = String.fromCharCode(39);
  const field = (name, value) => `  ${name}: ${mark}${value}${mark}`;
  const raw = [
    '    at Test.runInAsyncScope (node:async_hooks:227:14) {',
    field('code', 'ERR_ASSERTION'),
    field('actual', 'local+'),
    '}',
  ].join('\n');
  const view = {
    pane: 'npm',
    npmView: true,
    npmOutput: reduceOutput(raw, '/repo', 1),
    npmFollow: true,
    npmCommands: [],
    repoName: 'demo',
    status: '',
    counts: {},
  };
  const frame = render.renderFrame(view, {
    width: 40,
    height: 12,
    color: true,
  });
  const plain = stripAnsi(frame.rows.join('\n'));
  const codeRow = frame.rows.find((row) =>
    stripAnsi(row).includes('ERR_ASSERTION'),
  );
  const actualRow = frame.rows.find((row) => stripAnsi(row).includes('local+'));
  const bgMark = `${ESC}[48;2;`;
  const backgrounds = (row) => {
    const found = [];
    let at = 0;
    while (at < row.length) {
      const start = row.indexOf(bgMark, at);
      if (start < 0) break;
      const end = row.indexOf('m', start);
      found.push(row.slice(start, end + 1));
      at = end + 1;
    }
    return found;
  };
  assert.match(plain, /code {4}ERR_ASSERTION/);
  assert.match(plain, /actual {4}local\+/);
  const codeBgs = backgrounds(codeRow);
  const actualBgs = backgrounds(actualRow);
  assert.notDeepEqual(codeBgs, actualBgs);
  assert.ok(!codeBgs.includes(bg(THEME.checkBg)));
  assert.ok(!codeBgs.includes(bg(THEME.buttonBg)));
  assert.ok(!codeBgs.includes(bg(THEME.ctxBg)));
  assert.ok(!actualBgs.includes(bg(THEME.ctxBg)));
  assert.ok(codeRow.includes(fg(THEME.ctxFg)));
  assert.ok(!plain.includes('┌'));
  assert.ok(!plain.includes('│'));
  assert.ok(!plain.includes('─'));
});
