'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { osc52 } = require('../lib/term/clipboard.js');
const { ESC } = require('../lib/term/ansi.js');

test('osc52 encodes UTF-8 as base64', () => {
  assert.equal(osc52('hé'), `${ESC}]52;c;aMOp\x07`);
});
