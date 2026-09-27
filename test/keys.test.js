'use strict';

const nodeTest = require('node:test');
const { test } = nodeTest;
const assert = require('node:assert/strict');

const keys = require('../lib/keys.js');
const { FILES_DISABLED, FILES_HIDDEN } = keys;
const { FILES_TODO_DISABLED, FILES_GIT_DISABLED } = keys;
const { DIFF_DISABLED, TODO_DISABLED, BRANCHES_DISABLED } = keys;
const { COMMITS_DISABLED, UNIT_DISABLED } = keys;
const { decodeChunk, actionFromKey, hitAction } = keys;
const { disabledActions } = keys;
const { actionLetter, buttonWord } = keys;
const render = require('../lib/render/render.js');
const { layoutButtons } = render;

test('decodeChunk maps letters and arrows', () => {
  const keys = decodeChunk('ar').events.map((event) => event.key);
  assert.deepEqual(keys, ['a', 'r']);
  const up = decodeChunk('\x1b[A').events[0];
  assert.equal(up.key, 'up');
  const pending = decodeChunk('\x1b');
  assert.equal(pending.events.length, 0);
  assert.equal(pending.carry, '\x1b');
  const completed = decodeChunk('[A', pending.carry);
  assert.equal(completed.events[0].key, 'up');
  const enter = decodeChunk('\r').events[0];
  assert.equal(enter.key, 'enter');
  const back = decodeChunk('\x7f').events[0];
  assert.equal(back.key, 'backspace');
  const tab = decodeChunk('\t').events[0];
  assert.equal(tab.key, 'tab');
  const save = decodeChunk('\x13').events[0];
  assert.equal(save.key, 'ctrl-s');
  const undo = decodeChunk('\x1a').events[0];
  assert.equal(undo.key, 'ctrl-z');
  const scrollDown = decodeChunk('\x05').events[0];
  assert.equal(scrollDown.key, 'ctrl-e');
  const pageDown = decodeChunk('\x06').events[0];
  assert.equal(pageDown.key, 'ctrl-f');
  const del = decodeChunk('\x1b[3~').events[0];
  assert.equal(del.key, 'delete');
  const pgUp = decodeChunk('\x1b[5~').events[0];
  assert.equal(pgUp.key, 'pageUp');
  const pgDown = decodeChunk('\x1b[6~').events[0];
  assert.equal(pgDown.key, 'pageDown');
  const home = decodeChunk('\x1b[H').events[0];
  assert.equal(home.key, 'home');
  const end = decodeChunk('\x1b[F').events[0];
  assert.equal(end.key, 'end');
  const homeTilde = decodeChunk('\x1b[1~').events[0];
  assert.equal(homeTilde.key, 'home');
  const ss3Home = decodeChunk('\x1bOH').events[0];
  assert.equal(ss3Home.key, 'home');
  const ctrlLeft = decodeChunk('\x1b[1;5D').events[0];
  assert.equal(ctrlLeft.key, 'ctrl-left');
  const ctrlRight = decodeChunk('\x1b[1;5C').events[0];
  assert.equal(ctrlRight.key, 'ctrl-right');
  const ctrlUp = decodeChunk('\x1b[1;5A').events[0];
  assert.equal(ctrlUp.key, 'ctrl-up');
  const ctrlDown = decodeChunk('\x1b[1;5B').events[0];
  assert.equal(ctrlDown.key, 'ctrl-down');
});

test('decodeChunk parses SGR mouse press', () => {
  const event = decodeChunk('\x1b[<0;4;12M').events[0];
  assert.equal(event.type, 'mouse');
  assert.equal(event.button, 0);
  assert.equal(event.x, 4);
  assert.equal(event.y, 12);
  assert.equal(event.press, true);
  assert.equal(event.kind, 'press');
});

test('decodeChunk parses SGR mouse drag and release', () => {
  const drag = decodeChunk('\x1b[<32;10;5M').events[0];
  assert.equal(drag.kind, 'drag');
  assert.equal(drag.btn, 0);
  const up = decodeChunk('\x1b[<0;10;5m').events[0];
  assert.equal(up.kind, 'release');
  assert.equal(up.press, false);
});

test('actionFromKey maps aliases and ignores unbound keys', () => {
  assert.equal(actionFromKey('right'), 'next');
  assert.equal(actionFromKey('j'), 'next');
  assert.equal(actionFromKey('left'), 'prev');
  assert.equal(actionFromKey('k'), 'prev');
  assert.equal(actionFromKey('up'), 'scrollUp');
  assert.equal(actionFromKey('down'), 'scrollDown');
  assert.equal(actionFromKey('ctrl-y'), 'scrollUp');
  assert.equal(actionFromKey('ctrl-e'), 'scrollDown');
  assert.equal(actionFromKey('ctrl-b'), 'pageUp');
  assert.equal(actionFromKey('ctrl-f'), 'pageDown');
  assert.equal(actionFromKey('pageUp'), 'pageUp');
  assert.equal(actionFromKey('pageDown'), 'pageDown');
  assert.equal(actionFromKey('home'), 'home');
  assert.equal(actionFromKey('end'), 'end');
  assert.equal(actionFromKey('ctrl-u'), 'halfUp');
  assert.equal(actionFromKey('ctrl-d'), 'halfDown');
  assert.equal(actionFromKey('enter'), 'open');
  assert.equal(actionFromKey('e'), 'code');
  assert.equal(actionFromKey('d'), 'revert');
  assert.equal(actionFromKey('c'), 'commit');
  assert.equal(actionFromKey('l'), 'theme');
  assert.equal(actionFromKey('x'), 'check');
  assert.equal(actionFromKey(' '), 'check');
  assert.equal(actionFromKey('g'), null);
  assert.equal(actionFromKey('r'), null);
  assert.equal(actionFromKey('backspace'), 'removeTodo');
  assert.equal(actionFromKey('delete'), 'removeTodo');
  assert.equal(actionFromKey('s'), null);
  assert.equal(actionFromKey('h'), null);
  assert.equal(actionFromKey('?'), null);
  assert.equal(actionFromKey('v'), null);
  assert.equal(actionFromKey('p'), 'prev');
  assert.equal(actionFromKey('u'), 'unstage');
  assert.equal(actionFromKey('b'), null);
  assert.equal(actionFromKey('b', 'files'), 'branch');
  assert.equal(actionFromKey('p', 'files'), 'pull');
  assert.equal(actionFromKey('u', 'files'), 'unstage');
  assert.equal(actionFromKey('u', 'unit'), 'unstage');
  assert.equal(actionFromKey('f', 'files'), 'file');
  assert.equal(actionFromKey('f', 'files', 'file'), 'feedback');
  assert.equal(actionFromKey('d', 'files'), 'revert');
  assert.equal(actionFromKey('d', 'files', 'file'), 'diff');
  assert.equal(actionFromKey('left', 'unit'), 'prev');
  assert.equal(actionFromKey('right', 'unit'), 'next');
  assert.equal(actionFromKey('s', 'files'), 'push');
  assert.equal(actionFromKey('n'), 'next');
  assert.equal(actionFromKey('n', 'branches'), 'newBranch');
  assert.equal(actionFromKey('r', 'branches'), 'rebase');
  assert.equal(actionFromKey('d', 'branches'), 'drop');
  assert.equal(actionFromKey('p', 'branches'), 'pull');
  assert.equal(actionFromKey('s', 'branches'), 'push');
  assert.equal(actionFromKey('left', 'branches'), null);
  assert.equal(actionFromKey('right', 'branches'), null);
  assert.equal(actionFromKey('j', 'branches'), 'next');
  assert.equal(actionFromKey('k', 'branches'), 'prev');
  assert.equal(actionFromKey('up', 'branches'), 'scrollUp');
  assert.equal(actionFromKey('down', 'branches'), 'scrollDown');
  assert.equal(actionFromKey('a', 'commits'), 'apply');
  assert.equal(actionFromKey('r', 'commits'), 'reword');
  assert.equal(actionFromKey('f', 'commits'), 'fixup');
  assert.equal(actionFromKey('d', 'commits'), 'drop');
  assert.equal(actionFromKey('c', 'commits'), 'commit');
  assert.equal(actionFromKey('p', 'commits'), 'pull');
  assert.equal(actionFromKey('s', 'commits'), 'push');
  assert.equal(actionFromKey('v', 'commits'), 'view');
  assert.equal(actionFromKey('m', 'commits'), 'layout');
  assert.equal(actionFromKey('m'), 'layout');
  assert.equal(actionFromKey('left', 'commits'), null);
  assert.equal(actionFromKey('right', 'commits'), null);
  assert.equal(actionFromKey('left', 'files'), null);
  assert.equal(actionFromKey('right', 'files'), null);
  assert.equal(actionFromKey('n', 'files'), 'npm');
  assert.equal(actionFromKey('j', 'files'), 'next');
  assert.equal(actionFromKey('k', 'files'), 'prev');
  assert.equal(actionFromKey('a', 'files'), 'add');
  assert.equal(actionFromKey('f', 'files'), 'file');
  assert.equal(actionFromKey('d', 'files'), 'revert');
  assert.equal(actionFromKey('d'), 'revert');
  assert.equal(actionFromKey('r', 'files'), null);
  assert.equal(actionFromKey('escape'), null);
});

test('layoutButtons hitboxes cover labels', () => {
  const layout = layoutButtons(160, false);
  assert.equal(layout.hits[0].id, 'add');
  assert.ok(!layout.parts.some((part) => part.action.id === 'reload'));
  assert.ok(!layout.parts.some((part) => part.action.id === 'newBranch'));
  assert.ok(!layout.parts.some((part) => part.action.id === 'files'));
  assert.equal(layout.parts[0].label, 'add');
  assert.equal(layout.parts[0].letter, 'a');
  assert.equal(layout.parts[0].piece, ' add');
  assert.equal(layout.parts[1].piece, '  unstage');
  assert.ok(!layout.parts[0].piece.includes('['));
  assert.equal(layout.parts[1].action.id, 'unstage');
  assert.equal(layout.parts[3].action.id, 'commit');
  assert.equal(layout.parts[4].action.id, 'prev');
  assert.equal(layout.parts[5].action.id, 'next');
  assert.equal(hitAction(layout.hits, layout.hits[0].x0), 'add');
  const diff80 = layoutButtons(80, false, DIFF_DISABLED);
  assert.equal(diff80.parts[0].label, 'add');
  assert.ok(!diff80.parts.some((part) => part.action.id === 'reload'));
  assert.ok(!diff80.parts.some((part) => part.action.id === 'commit'));
  const letters = layoutButtons(20, true);
  assert.equal(letters.parts[0].label, 'a');
  assert.equal(letters.parts[0].piece, ' a');
  assert.ok(!letters.parts[0].piece.includes('['));
  const prev = letters.parts.find((part) => part.action.id === 'prev');
  assert.equal(prev.label, '←');
  const off = layoutButtons(160, false, FILES_DISABLED);
  const hitIds = off.hits.map((hit) => hit.id);
  assert.equal(hitIds.includes('layout'), false);
  assert.equal(hitIds.includes('feedback'), false);
  assert.equal(hitIds.includes('code'), false);
  assert.equal(hitIds.includes('add'), true);
  assert.equal(hitIds.includes('reload'), false);
  assert.equal(hitIds.includes('branch'), true);
  assert.equal(hitIds.includes('pull'), false);
  assert.equal(hitIds.includes('push'), false);
  assert.equal(hitIds.includes('newBranch'), false);
  const ids = off.parts.map((part) => part.action.id);
  assert.equal(ids.includes('layout'), false);
  assert.equal(ids.includes('feedback'), false);
  assert.equal(ids.includes('code'), false);
  assert.equal(ids.includes('todo'), true);
  const filesHint = layoutButtons(160, false, FILES_HIDDEN, [
    'file',
    'commit',
    'pull',
    'push',
  ]);
  const filesIds = filesHint.parts.map((part) => part.action.id);
  assert.deepEqual(filesIds, [
    'add',
    'unstage',
    'revert',
    'todo',
    'branch',
    'file',
    'commit',
    'pull',
    'push',
  ]);
  assert.ok(!filesIds.includes('diff'));
  const diffHint = layoutButtons(160, false, FILES_HIDDEN, [
    'diff',
    'commit',
    'pull',
    'push',
  ]);
  const diffIds = diffHint.parts.map((part) => part.action.id);
  assert.ok(diffIds.includes('diff'));
  assert.ok(!diffIds.includes('file'));
  assert.ok(!filesIds.includes('prev'));
  assert.ok(!filesIds.includes('next'));
  const todo = layoutButtons(160, false, TODO_DISABLED);
  const todoIds = todo.parts.map((part) => part.action.id);
  assert.equal(todoIds.includes('commit'), false);
  assert.equal(todoIds.includes('todo'), false);
  assert.equal(todoIds.includes('open'), false);
  const dim = layoutButtons(
    160,
    false,
    FILES_HIDDEN,
    ['commit', 'pull', 'push'],
    FILES_GIT_DISABLED,
  );
  const dimAdd = dim.parts.find((part) => part.action.id === 'add');
  assert.equal(dimAdd.disabled, true);
  assert.equal(
    dim.hits.find((hit) => hit.id === 'add'),
    undefined,
  );
  assert.ok(dim.parts.some((part) => part.action.id === 'commit'));
  assert.ok(dim.hits.some((hit) => hit.id === 'commit'));
});

test('disabledActions hides add unstage drop on files todos', () => {
  const file = disabledActions('files', { path: 'a.js' });
  assert.equal(file.includes('add'), false);
  assert.equal(file.includes('unstage'), false);
  assert.equal(file.includes('revert'), false);
  assert.equal(file.includes('pull'), false);
  assert.equal(file.includes('push'), false);
  const todos = disabledActions('files', { kind: 'todos' });
  assert.deepEqual(todos, FILES_TODO_DISABLED);
  assert.equal(todos.includes('add'), true);
  assert.equal(todos.includes('commit'), false);
  const page = disabledActions('diff', { origin: 'todo' });
  assert.equal(page.includes('add'), true);
  assert.equal(page.includes('commit'), true);
  assert.equal(page.includes('todo'), true);
  const staged = disabledActions('diff', { origin: 'staged' });
  assert.equal(staged.includes('add'), true);
  assert.equal(staged.includes('unstage'), false);
  const unstaged = disabledActions('diff', { origin: 'unstaged' });
  assert.equal(unstaged.includes('add'), false);
  assert.equal(unstaged.includes('unstage'), true);
  assert.equal(unstaged.includes('commit'), true);
  const unitView = disabledActions('unit', { origin: 'unstaged' });
  assert.equal(unitView.includes('layout'), true);
  assert.equal(unitView.includes('file'), true);
  assert.equal(unitView.includes('diff'), true);
  assert.equal(unitView.includes('unstage'), true);
  assert.equal(unitView.includes('add'), false);
  assert.equal(unitView.includes('feedback'), false);
  assert.ok(UNIT_DISABLED.includes('file'));
  assert.ok(UNIT_DISABLED.includes('diff'));
  const current = disabledActions('branches', { name: 'feat', current: true });
  assert.equal(current.includes('rebase'), true);
  assert.equal(current.includes('drop'), true);
  assert.equal(current.includes('pull'), false);
  assert.equal(current.includes('push'), false);
  assert.equal(current.includes('prev'), true);
  assert.equal(current.includes('next'), true);
  const onto = disabledActions('branches', { name: 'main', current: false });
  assert.equal(onto.includes('rebase'), false);
  assert.equal(onto.includes('drop'), false);
  assert.equal(onto.includes('pull'), true);
  assert.equal(onto.includes('push'), true);
  const branchIds = ['newBranch', 'rebase', 'drop', 'pull', 'push'];
  const branchLayout = layoutButtons(160, false, BRANCHES_DISABLED, branchIds, [
    'rebase',
    'drop',
  ]);
  assert.ok(branchLayout.parts.some((part) => part.action.id === 'drop'));
  assert.ok(branchLayout.parts.some((part) => part.action.id === 'pull'));
  assert.ok(branchLayout.hits.some((hit) => hit.id === 'pull'));
  assert.ok(branchLayout.hits.some((hit) => hit.id === 'push'));
  assert.ok(!branchLayout.parts.some((part) => part.action.id === 'prev'));
  assert.ok(!branchLayout.parts.some((part) => part.action.id === 'next'));
  assert.equal(
    branchLayout.hits.find((hit) => hit.id === 'drop'),
    undefined,
  );
  const ontoLayout = layoutButtons(160, false, BRANCHES_DISABLED, branchIds, [
    'pull',
    'push',
  ]);
  assert.ok(ontoLayout.parts.some((part) => part.action.id === 'pull'));
  assert.ok(ontoLayout.parts.some((part) => part.action.id === 'push'));
  assert.equal(
    ontoLayout.hits.find((hit) => hit.id === 'pull'),
    undefined,
  );
  assert.equal(
    ontoLayout.hits.find((hit) => hit.id === 'push'),
    undefined,
  );
  assert.ok(ontoLayout.hits.some((hit) => hit.id === 'rebase'));
  assert.ok(ontoLayout.hits.some((hit) => hit.id === 'drop'));
  const commitIds = [
    'amend',
    'apply',
    'reword',
    'fixup',
    'drop',
    'view',
    'pull',
    'push',
  ];
  const head = { sha: 'aaa', canCommit: true };
  const commitOff = disabledActions('commits', head);
  assert.equal(commitOff.includes('amend'), false);
  assert.equal(commitOff.includes('apply'), false);
  assert.equal(commitOff.includes('reword'), false);
  assert.equal(commitOff.includes('commit'), false);
  assert.equal(commitOff.includes('pull'), false);
  assert.equal(commitOff.includes('push'), false);
  assert.equal(commitOff.includes('prev'), true);
  assert.equal(commitOff.includes('layout'), true);
  const emptyOff = disabledActions('commits', { canCommit: true });
  assert.equal(emptyOff.includes('amend'), true);
  assert.equal(emptyOff.includes('apply'), true);
  assert.equal(emptyOff.includes('reword'), true);
  assert.equal(emptyOff.includes('commit'), false);
  const fixup = { sha: 'aaa', subject: 'fixup! init', canCommit: true };
  const fixupDim = keys.commitGitDisabled(fixup);
  assert.equal(fixupDim.includes('apply'), false);
  const headDim = keys.commitGitDisabled(head);
  assert.equal(headDim.includes('apply'), true);
  const commitLayout = layoutButtons(160, false, COMMITS_DISABLED, commitIds, [
    'commit',
    'fixup',
    'apply',
  ]);
  assert.ok(commitLayout.parts.some((part) => part.action.id === 'commit'));
  assert.ok(commitLayout.parts.some((part) => part.action.id === 'amend'));
  assert.ok(commitLayout.parts.some((part) => part.action.id === 'apply'));
  assert.ok(commitLayout.parts.some((part) => part.action.id === 'reword'));
  assert.ok(commitLayout.parts.some((part) => part.action.id === 'drop'));
  const view = commitLayout.parts.find((part) => part.action.id === 'view');
  assert.equal(view.label, 'view');
  assert.ok(commitLayout.hits.some((hit) => hit.id === 'view'));
  assert.ok(commitLayout.parts.some((part) => part.action.id === 'pull'));
  assert.ok(commitLayout.parts.some((part) => part.action.id === 'push'));
  assert.ok(!commitLayout.parts.some((part) => part.action.id === 'prev'));
  assert.ok(!commitLayout.parts.some((part) => part.action.id === 'layout'));
  assert.equal(
    commitLayout.hits.find((hit) => hit.id === 'commit'),
    undefined,
  );
  assert.equal(
    commitLayout.hits.find((hit) => hit.id === 'apply'),
    undefined,
  );
  assert.ok(commitLayout.hits.some((hit) => hit.id === 'amend'));
  assert.ok(commitLayout.hits.some((hit) => hit.id === 'pull'));
  assert.ok(commitLayout.hits.some((hit) => hit.id === 'push'));
});

test('buttonWord is the footer hint including the bound mark', () => {
  assert.equal(actionLetter('next'), '→');
  assert.equal(actionLetter('prev'), '←');
  assert.equal(buttonWord('next'), '→');
  assert.equal(buttonWord('prev'), '←');
  assert.equal(buttonWord('quit'), 'q');
  assert.equal(buttonWord('check'), 'x');
});
