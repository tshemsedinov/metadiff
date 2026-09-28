'use strict';

const nodeTest = require('node:test');
const { test } = nodeTest;
const assert = require('node:assert/strict');

const clipboard = require('../lib/clipboard.js');
const { osc52 } = clipboard;
const ansi = require('../lib/ansi.js');
const { ESC } = ansi;

test('osc52 encodes UTF-8 as base64', () => {
  assert.equal(osc52('hé'), `${ESC}]52;c;aMOp\x07`);
});
