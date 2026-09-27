'use strict';

const nodeTest = require('node:test');
const { test } = nodeTest;
const assert = require('node:assert/strict');

const compose = require('../lib/session/compose.js');
const { createComposer } = compose;
const navigation = require('../lib/session/navigation.js');
const { createNavigation } = navigation;
const review = require('../lib/review.js');
const { createStore } = review;

const setup = (extra = {}) => {
  const notes = extra.notes ?? createStore('/tmp/review.md');
  const nav = extra.nav ?? createNavigation({ startPane: 'diff' });
  const flushed = [];
  const ui = {
    nav,
    mode: 'review',
    status: '',
    layout: 'unified',
    lastSize: null,
    lastFrame: null,
    current: () => extra.item ?? null,
    flushReview: (force) => {
      flushed.push(force === true);
      return true;
    },
    draw: () => {},
    getSize: () => ({ width: 80, height: 24 }),
    fileCursorEntry: () => null,
    clampIndex: () => {},
    syncReviewPath: () => {},
    syncFileCursor: () => {},
  };
  const composer = createComposer({
    nav,
    review: { store: notes },
    ui,
    restartBlink: () => {},
  });
  return {
    composer,
    notes,
    nav,
    flushed,
    getMode: () => ui.mode,
    getStatus: () => ui.status,
  };
};

test('commit save returns a command and does not close compose', () => {
  const { composer, flushed, getMode } = setup();
  composer.state.commitKind = 'commit';
  composer.openCompose('commit', 'land it');
  const result = composer.saveCompose();
  assert.deepEqual(result, { kind: 'commit' });
  assert.equal(composer.state.composeKind, 'commit');
  assert.equal(getMode(), 'compose');
  assert.equal(flushed.length, 0);
});

test('autosave never returns a git command for commit or branch', () => {
  const { composer, flushed } = setup();
  composer.state.commitKind = 'commit';
  composer.openCompose('commit', 'land it');
  assert.equal(composer.autosave(), undefined);
  assert.equal(composer.state.composeKind, 'commit');
  assert.equal(flushed.length, 0);
  composer.closeCompose();
  composer.openCompose('branch', 'feat');
  assert.equal(composer.autosave(), undefined);
  assert.equal(composer.state.composeKind, 'branch');
  assert.equal(flushed.length, 0);
});

test('page home and end move in a multiline compose editor', () => {
  const { composer } = setup();
  composer.openCompose('code', 'aaa\nbbb\nccc');
  assert.equal(composer.state.editor.cursor, 11);
  composer.handleKey('home');
  assert.equal(composer.state.editor.cursor, 8);
  composer.handleKey('end');
  assert.equal(composer.state.editor.cursor, 11);
  composer.handleKey('pageUp');
  assert.equal(composer.state.editor.linePos().line, 0);
  composer.handleKey('pageDown');
  assert.equal(composer.state.editor.linePos().line, 2);
});

test('ctrl arrows move by word in compose editors', () => {
  const kinds = ['feedback', 'code', 'todo', 'commit', 'branch'];
  for (const kind of kinds) {
    const { composer } = setup();
    composer.openCompose(kind, 'hello world');
    composer.state.editor.home();
    composer.handleKey('ctrl-right');
    assert.equal(composer.state.editor.cursor, 5);
    composer.handleKey('ctrl-right');
    assert.equal(composer.state.editor.cursor, 11);
    composer.handleKey('ctrl-left');
    assert.equal(composer.state.editor.cursor, 6);
    composer.handleKey('ctrl-left');
    assert.equal(composer.state.editor.cursor, 0);
  }
});

test('escape cancels branch compose without a command', () => {
  const { composer, getMode, getStatus } = setup();
  composer.openCompose('branch', 'feat');
  const result = composer.handleKey('escape');
  assert.equal(result, null);
  assert.equal(composer.state.composeKind, null);
  assert.equal(getMode(), 'review');
  assert.equal(getStatus(), '');
});
