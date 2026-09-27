'use strict';

const nodeTest = require('node:test');
const { test } = nodeTest;
const assert = require('node:assert/strict');

const select = require('../lib/select.js');
const ansi = require('../lib/ansi.js');
const { ESC, stripAnsi, paint, THEME, fg, bg, seq } = ansi;

test('extractText copies a same-row range', () => {
  const rows = ['abcdef', 'ghijkl'];
  const text = select.extractText(rows, {
    start: { x: 2, y: 1 },
    end: { x: 4, y: 1 },
  });
  assert.equal(text, 'bcd');
});

test('extractText joins multiple rows', () => {
  const rows = ['abcdef', 'ghijkl'];
  const text = select.extractText(rows, {
    start: { x: 4, y: 1 },
    end: { x: 3, y: 2 },
  });
  assert.equal(text, 'def\nghi');
});

test('overlayRange paints selected cells with inverted colors', () => {
  const out = select.overlayRange('abcdef', 2, 4);
  const invert = seq(THEME.ctxBg, THEME.ctxFg);
  assert.equal(stripAnsi(out), 'abcdef');
  assert.ok(out.includes(`${invert}cd`));
  assert.ok(!out.includes(`${ESC}[7m`));
});

test('overlayRange highlights across color resets', () => {
  const left = paint('aaa', THEME.addLineFg, THEME.addLineBg, true);
  const right = paint('bbb', THEME.delLineFg, THEME.delLineBg, true);
  const out = select.overlayRange(left + right, 1, 5);
  const addInvert = seq(THEME.addLineBg, THEME.addLineFg);
  const delInvert = seq(THEME.delLineBg, THEME.delLineFg);
  assert.equal(stripAnsi(out), 'aaabbb');
  assert.ok(out.includes(`${addInvert}aa`));
  assert.ok(out.includes(`${delInvert}bb`));
  assert.ok(out.includes(fg(THEME.addLineBg)));
  assert.ok(out.includes(bg(THEME.addLineFg)));
  assert.ok(out.includes(fg(THEME.delLineBg)));
  assert.ok(out.includes(bg(THEME.delLineFg)));
  assert.ok(!out.includes(`${ESC}[7m`));
});

test('extractText reads overlay rows', () => {
  const line = paint('abcdef', THEME.ctxFg, THEME.ctxBg, true);
  const over = select.overlayRange(line, 2, 4);
  const text = select.extractText([over], {
    start: { x: 3, y: 1 },
    end: { x: 4, y: 1 },
  });
  assert.equal(text, 'cd');
});
