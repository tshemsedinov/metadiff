'use strict';

const nodeTest = require('node:test');
const { test } = nodeTest;
const assert = require('node:assert/strict');

const ansi = require('../lib/ansi.js');

const { visibleWidth, codeFg, CODE_FG, THEME, PALETTES, fg } = ansi;
const { setTheme, themeName, clipAnsi, stripAnsi, RESET } = ansi;
const { foregroundOn, bg } = ansi;

test('a grey level uses the same value on every channel', () => {
  assert.equal(fg(0xff), fg([0xff, 0xff, 0xff]));
  assert.equal(bg(0), bg([0, 0, 0]));
});

test('eye logo is one column, matching terminal wcwidth', () => {
  assert.equal(visibleWidth('👁️'), 1);
  assert.equal(visibleWidth('👁'), 1);
});

test('wide East Asian and wide emoji are two columns', () => {
  assert.equal(visibleWidth('中'), 2);
  assert.equal(visibleWidth('💠'), 2);
});

test('codeFg ignores non-string and prototype names', () => {
  assert.deepEqual(codeFg(null), CODE_FG.plain);
  assert.deepEqual(codeFg({}), CODE_FG.plain);
  assert.deepEqual(codeFg(Object.prototype.toString), CODE_FG.plain);
  assert.deepEqual(codeFg('constructor'), CODE_FG.plain);
  assert.deepEqual(codeFg('toString'), CODE_FG.plain);
  assert.deepEqual(codeFg('storage'), CODE_FG.storage);
});

test('light and dark palettes define the same colors', () => {
  const { dark, light } = PALETTES;
  assert.deepEqual(Object.keys(light.ui).sort(), Object.keys(dark.ui).sort());
  const codeKeys = Object.keys(dark.code).sort();
  assert.deepEqual(Object.keys(light.code).sort(), codeKeys);
  assert.equal(light.logCols.length, dark.logCols.length);
});

test('setTheme swaps colors in place and rejects unknown names', () => {
  const theme = THEME;
  const held = THEME.ctxBg;
  try {
    setTheme('light');
    assert.equal(themeName(), 'light');
    assert.equal(THEME, theme);
    assert.equal(THEME.ctxBg, held);
    assert.deepEqual(THEME.ctxBg, PALETTES.light.ui.ctxBg);
    assert.deepEqual(codeFg('logCol1'), PALETTES.light.logCols[1]);
    assert.throws(() => setTheme('blue'), /unknown theme blue/);
    setTheme('dark');
    assert.deepEqual(THEME.ctxBg, PALETTES.dark.ui.ctxBg);
    assert.deepEqual(CODE_FG.plain, PALETTES.dark.code.plain);
  } finally {
    setTheme('dark');
  }
});

test('clipAnsi keeps color codes and cuts on visible width', () => {
  const red = '\x1b[31m';
  const text = `${red}Error: boom${RESET}`;
  assert.equal(clipAnsi(text, 40), text);
  const cut = clipAnsi(text, 5);
  assert.ok(cut.startsWith(red));
  assert.equal(stripAnsi(cut), 'Error');
  assert.ok(cut.endsWith(RESET));
});

test('foregroundOn keeps text color and uses the given background', () => {
  const ground = bg(THEME.ctxBg);
  const text = '\x1b[1;31;41mError\x1b[0m plain';
  const out = foregroundOn(text, THEME.ctxBg);
  const fg = `\x1b[1;31mError${RESET}${ground} plain`;
  assert.equal(out, `${ground}${fg}`);
  assert.ok(!out.includes('\x1b[41m'));
  const rgb = '\x1b[38;2;9;8;7;48;2;1;2;3mX';
  const colored = foregroundOn(rgb, THEME.ctxBg);
  assert.ok(colored.includes('\x1b[38;2;9;8;7m'));
  assert.ok(!colored.includes('48;2;1;2;3'));
  assert.ok(colored.includes(ground));
});
