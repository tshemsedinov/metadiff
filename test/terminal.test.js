'use strict';

const nodeTest = require('node:test');
const { test } = nodeTest;
const assert = require('node:assert/strict');
const events = require('node:events');
const { EventEmitter } = events;

const helpers = require('./helpers.js');
const { sink } = helpers;
const sys = require('../lib/utilities.js');
const { watchResize } = sys;
const terminal = require('../lib/session/terminal.js');
const { createTerminal, ENTER_TERM, LEAVE_TERM } = terminal;
const progress = require('../lib/session/progress.js');
const { createProgress } = progress;

const fakeStdin = () => {
  const stdin = new EventEmitter();
  stdin.raw = false;
  stdin.paused = true;
  stdin.setRawMode = (value) => {
    stdin.raw = value;
  };
  stdin.resume = () => {
    stdin.paused = false;
  };
  return stdin;
};

const openTerm = (extra = {}) => {
  const stdin = extra.stdin ?? fakeStdin();
  const stdout = extra.stdout ?? sink();
  const proc = extra.proc ?? new EventEmitter();
  const term = createTerminal({
    stdin,
    stdout,
    proc,
  });
  return { term, stdin, stdout, proc };
};
const emitSink = () => {
  const stdout = new EventEmitter();
  let text = '';
  stdout.write = (chunk) => {
    text += chunk;
    return true;
  };
  stdout.dump = () => text;
  return stdout;
};

test('watchResize removes listeners from stdout and process', () => {
  const stdout = new EventEmitter();
  const proc = new EventEmitter();
  let n = 0;
  const stop = watchResize(stdout, proc, () => {
    n += 1;
  });
  assert.equal(stdout.listenerCount('resize'), 1);
  assert.equal(proc.listenerCount('SIGWINCH'), 1);
  stdout.emit('resize');
  proc.emit('SIGWINCH');
  assert.equal(n, 2);
  stop();
  assert.equal(stdout.listenerCount('resize'), 0);
  assert.equal(proc.listenerCount('SIGWINCH'), 0);
  stdout.emit('resize');
  proc.emit('SIGWINCH');
  assert.equal(n, 2);
});

test('watchResize abort signal also removes listeners', () => {
  const stdout = new EventEmitter();
  const proc = new EventEmitter();
  const ac = new AbortController();
  watchResize(stdout, proc, () => {}, ac.signal);
  assert.equal(stdout.listenerCount('resize'), 1);
  ac.abort();
  assert.equal(stdout.listenerCount('resize'), 0);
  assert.equal(proc.listenerCount('SIGWINCH'), 0);
});

test('enter and leave restore raw mode and write term sequences', () => {
  const { term, stdin, stdout } = openTerm();
  term.enter();
  assert.equal(stdin.raw, true);
  assert.equal(stdin.paused, false);
  assert.equal(stdout.dump(), ENTER_TERM);
  term.leave();
  assert.equal(stdin.raw, false);
  assert.ok(stdout.dump().endsWith(LEAVE_TERM));
});

test('repeated listen and close restore listener and timer counts', () => {
  const stdin = fakeStdin();
  const stdout = emitSink();
  const proc = new EventEmitter();
  const term = createTerminal({ stdin, stdout, proc });
  const start = () => {
    term.startListening({
      onData: () => {},
      onResize: () => {},
    });
    term.startTimer('save', () => {}, 10);
    term.startTimer('blink', () => {}, 10);
  };
  start();
  assert.equal(stdin.listenerCount('data'), 1);
  assert.equal(stdout.listenerCount('resize'), 1);
  assert.equal(proc.listenerCount('SIGWINCH'), 1);
  assert.equal(term.hasTimer('save'), true);
  assert.equal(term.hasTimer('blink'), true);
  term.stopListening();
  term.clearTimers();
  assert.equal(stdin.listenerCount('data'), 0);
  assert.equal(stdout.listenerCount('resize'), 0);
  assert.equal(proc.listenerCount('SIGWINCH'), 0);
  assert.equal(term.hasTimer('save'), false);
  assert.equal(term.hasTimer('blink'), false);
  term.enter();
  start();
  term.close();
  assert.equal(stdin.listenerCount('data'), 0);
  assert.equal(stdout.listenerCount('resize'), 0);
  assert.equal(proc.listenerCount('SIGWINCH'), 0);
  assert.equal(term.hasTimer('save'), false);
  assert.equal(term.disposed, true);
  assert.equal(stdin.raw, false);
});

test('startup failure cleanup restores acquired terminal state', () => {
  const { term, stdin, stdout, proc } = openTerm({ stdout: emitSink() });
  const run = () => {
    term.enter();
    term.startListening({
      onData: () => {},
      onResize: () => {},
    });
    term.startTimer('save', () => {}, 10);
    throw new Error('boom');
  };
  try {
    run();
  } catch (error) {
    assert.equal(error.message, 'boom');
    term.close();
  }
  assert.equal(stdin.raw, false);
  assert.ok(stdout.dump().includes(LEAVE_TERM));
  assert.equal(stdin.listenerCount('data'), 0);
  assert.equal(proc.listenerCount('SIGWINCH'), 0);
  assert.equal(term.hasTimer('save'), false);
  assert.equal(term.disposed, true);
});

test('unchanged frames still allow a cursor-only update', () => {
  const stdout = sink();
  const { term } = openTerm({ stdout });
  const size = { width: 80, height: 24 };
  const frame = { text: 'same', rows: ['same'] };
  term.paint(frame, size, { x: 1, y: 1 });
  const first = stdout.dump();
  assert.ok(first.includes('[?2026h'));
  term.paint(frame, size, { x: 1, y: 1 });
  assert.equal(stdout.dump(), first);
  term.paint(frame, size, { x: 4, y: 2 });
  const extra = stdout.dump().slice(first.length);
  assert.ok(extra.includes('[2;4H'));
  assert.ok(!extra.includes('[?2026h'));
});

test('paint after dispose writes nothing', () => {
  const stdout = sink();
  const { term } = openTerm({ stdout });
  term.enter();
  stdout.dump();
  const before = stdout.dump();
  term.close();
  const closed = stdout.dump();
  term.paint({ text: 'x', rows: ['x'] }, { width: 8, height: 4 }, null);
  assert.equal(stdout.dump(), closed);
  assert.ok(closed.length > before.length);
});

test('stopping one progress id leaves the timer running', () => {
  let started = 0;
  let stopped = 0;
  const term = {
    startTimer: () => {
      started += 1;
    },
    stopTimer: () => {
      stopped += 1;
    },
  };
  const progress = createProgress(term, () => {}, 80);
  progress.start('busy');
  progress.start('install');
  assert.equal(started, 1);
  assert.equal(progress.size(), 2);
  progress.stop('busy');
  assert.equal(stopped, 0);
  assert.equal(progress.size(), 1);
  progress.stop('install');
  assert.equal(stopped, 1);
  assert.equal(progress.size(), 0);
});
