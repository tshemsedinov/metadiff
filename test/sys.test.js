'use strict';

const nodeTest = require('node:test');
const { test } = nodeTest;
const assert = require('node:assert/strict');
const events = require('node:events');
const { EventEmitter } = events;

const sys = require('../lib/utilities.js');
const { npmBin, npmOpts, clipTools, watchResize } = sys;

test('npmBin uses npm.cmd on Windows', () => {
  assert.equal(npmBin('win32'), 'npm.cmd');
  assert.equal(npmBin('linux'), 'npm');
  assert.equal(npmBin('darwin'), 'npm');
});

test('npmOpts uses a shell only on Windows', () => {
  const win = npmOpts({ cwd: 'C:\\repo' }, 'win32');
  assert.equal(win.shell, true);
  assert.equal(win.windowsHide, true);
  assert.equal(win.cwd, 'C:\\repo');
  const unix = npmOpts({ cwd: '/tmp' }, 'linux');
  assert.equal(unix.shell, false);
  assert.equal(unix.windowsHide, true);
});

test('clipTools picks clip pbcopy and xclip by platform', () => {
  const win = clipTools('win32');
  assert.equal(win.length, 1);
  assert.equal(win[0].cmd, 'clip');
  const mac = clipTools('darwin');
  assert.equal(mac[0].cmd, 'pbcopy');
  const linux = clipTools('linux');
  assert.equal(linux[0].cmd, 'wl-copy');
  assert.equal(linux[1].cmd, 'xclip');
});

test('watchResize listens to stdout resize', () => {
  const stdout = new EventEmitter();
  const proc = new EventEmitter();
  let n = 0;
  const ac = new AbortController();
  watchResize(
    stdout,
    proc,
    () => {
      n += 1;
    },
    ac.signal,
  );
  stdout.emit('resize');
  assert.equal(n, 1);
  assert.equal(stdout.listenerCount('resize'), 1);
  ac.abort();
  assert.equal(stdout.listenerCount('resize'), 0);
  stdout.emit('resize');
  assert.equal(n, 1);
});
