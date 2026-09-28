'use strict';

const nodeTest = require('node:test');
const { test } = nodeTest;
const assert = require('node:assert/strict');

const sys = require('../lib/utilities.js');
const { npmOpts } = sys;

test('npmOpts uses a shell only on Windows', () => {
  const win = npmOpts({ cwd: 'C:\\repo' }, 'win32');
  assert.equal(win.shell, true);
  assert.equal(win.windowsHide, true);
  assert.equal(win.cwd, 'C:\\repo');
  const unix = npmOpts({ cwd: '/tmp' }, 'linux');
  assert.equal(unix.shell, false);
  assert.equal(unix.windowsHide, true);
});
