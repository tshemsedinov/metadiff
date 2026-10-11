'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { npmOpts } = require('../lib/common/process.js');

test('npmOpts uses a shell only on Windows', () => {
  const win = npmOpts({ cwd: 'C:\\repo' }, 'win32');
  assert.equal(win.shell, true);
  assert.equal(win.windowsHide, true);
  assert.equal(win.cwd, 'C:\\repo');
  const unix = npmOpts({ cwd: '/tmp' }, 'linux');
  assert.equal(unix.shell, false);
  assert.equal(unix.windowsHide, true);
});
