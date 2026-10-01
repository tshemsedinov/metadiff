'use strict';

const nodeTest = require('node:test');
const { test } = nodeTest;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const helpers = require('./helpers.js');
const { tempDir } = helpers;
const reportParse = require('../lib/report-parse.js');
const { buildDocument } = reportParse;
const reportRender = require('../lib/report-render.js');
const { renderDocument } = reportRender;
const reportView = require('../lib/render/report.js');
const { renderReport } = reportView;
const renderNpm = require('../lib/render/npm.js');
const { paintBodyNpm, logViewRows } = renderNpm;
const ansi = require('../lib/ansi.js');
const { stripAnsi, visibleWidth, fg, THEME, CODE_FG } = ansi;
const commands = require('../lib/npm-commands.js');
const { TABLE_KEY, formatTable } = commands;

const failure = (number) => [
  `not ok ${number} - comparison ${number}`,
  '  ---',
  '  name: AssertionError',
  '  error: Expected 3, got 4',
  '  code: ERR_ASSERTION',
  '  operator: strictEqual',
  '  expected: 3',
  '  actual: 4',
  '  stack: |-',
  '    check (/repo/lib/check.js:12:7)',
  `    TestContext.<anonymous> (/repo/test/check.js:${number}:5)`,
  '    Test.run (node:internal/test_runner/test:1:1)',
  '  ...',
];

const raw = [
  'TAP version 13',
  ...failure(1),
  ...failure(2),
  ...failure(3),
  '1..3',
].join('\n');

const document = () => buildDocument(raw, '', '/repo', 1, 'test');

const viewOf = (output) => ({
  npmView: true,
  npmOutput: output,
  npmFollow: false,
  npmScroll: 0,
});

test('TUI report uses tables and one stack while logs keep Markdown', () => {
  const doc = document();
  const output = renderReport(doc);
  const plain = stripAnsi(output);
  const log = renderDocument(doc);
  assert.ok(output.includes(TABLE_KEY));
  assert.match(plain, /✖ comparison 1 {2}× 3/);
  assert.match(plain, /expected\s+3/);
  assert.match(plain, /actual\s+4/);
  assert.match(plain, /count\s+3/);
  assert.ok(!plain.includes('severity'));
  assert.equal(plain.split('Stack').length - 1, 1);
  assert.equal(plain.split('at check').length - 1, 1);
  assert.match(plain, /comparison 2 \| test\/check\.js:2:5/);
  assert.match(plain, /comparison 3 \| test\/check\.js:3:5/);
  assert.ok(!plain.includes('## '));
  assert.ok(!plain.includes('RESLOP_OUTPUT'));
  assert.ok(!plain.includes('node:'));
  assert.match(log, /## comparison 1/);
  assert.match(log, /count: 3/);
  assert.ok(!log.includes('\x1b'));
});

test('TUI report colors follow the current dark or light theme', () => {
  const view = viewOf(renderReport(document()));
  try {
    for (const name of ['dark', 'light']) {
      ansi.setTheme(name);
      const pane = paintBodyNpm(view, 100, true, 60, 1);
      const rows = pane.body;
      const rowOf = (field) =>
        rows.find((row) => stripAnsi(row).trim().startsWith(field));
      assert.ok(rowOf('expected').includes(fg(THEME.addLineFg)));
      assert.ok(rowOf('actual').includes(fg(THEME.errorFg)));
      assert.ok(rowOf('type').includes(fg(CODE_FG.className)));
      const quote = rows.find((row) => stripAnsi(row).includes('│'));
      assert.ok(quote.includes(fg(THEME.shaFg)));
      const stack = rows.find((row) => stripAnsi(row).includes('at check'));
      assert.ok(stack.includes(`${fg(CODE_FG.function)}check`));
      assert.ok(stack.includes(`${fg(THEME.shaFg)}lib/check.js`));
      assert.ok(stack.includes(`${fg(THEME.mutedFg)}:12:7`));
    }
  } finally {
    ansi.setTheme('dark');
  }
});

test('TUI report fits narrow panes with and without colors', () => {
  const view = viewOf(renderReport(document()));
  for (const width of [8, 20, 40, 100]) {
    for (const color of [false, true]) {
      const pane = paintBodyNpm(view, width, color, 60, 1);
      for (const row of pane.body) {
        assert.equal(visibleWidth(row), width);
        if (!color) assert.ok(!row.includes('\x1b'));
      }
    }
  }
});

test('npm log wraps long lines instead of clipping them', () => {
  const words = 'alpha beta gamma delta epsilon zeta eta theta';
  const pathText = `lib/${'component-'.repeat(6)}check.js:12:7`;
  const table = formatTable([['actual', words]]);
  const quote = `│ ${words}`;
  const stack = `  at check (${pathText})`;
  const view = viewOf([quote, stack, ...table].join('\n'));
  const pane = paintBodyNpm(view, 24, true, 40, 1);
  const plain = pane.body.map((row) => stripAnsi(row)).join('\n');
  assert.ok(plain.includes('│ alpha beta gamma'));
  assert.ok(plain.includes('│ delta epsilon'));
  const bars = pane.body.filter((row) => stripAnsi(row).includes('│'));
  assert.ok(bars.length > 1);
  assert.ok(plain.includes('component-compo'));
  assert.ok(plain.includes('check.js:12:7'));
  assert.ok(plain.includes('actual'));
  assert.ok(plain.includes('epsilon'));
  for (const row of pane.body) assert.equal(visibleWidth(row), 24);
});

const prettyView =
  'verbose completion saves compact logs and restores a pretty view';
test(prettyView, async () => {
  const root = tempDir();
  try {
    let finish = null;
    const { NpmController } = require('../lib/session/npm.js');
    const ui = {
      top: root,
      nav: { npmCursor: 0 },
      lastFrame: { bodyH: 14 },
      progress: { start: () => {}, stop: () => {} },
      paint: () => {},
      repo: {
        runNpmCommand: (cwd, entry, onData, onClose) => {
          onData(raw);
          finish = onClose;
          return { kill: () => {} };
        },
      },
    };
    const controller = new NpmController(ui);
    controller.commands = [{ name: 'test', kind: 'script' }];
    controller.run();
    controller.toggleVerbose();
    await finish({ text: raw, status: 1 });
    assert.equal(controller.output.trimEnd(), raw);
    const directory = path.join(root, '.log');
    const names = fs.readdirSync(directory);
    const reduced = names.find((name) => !name.endsWith('.raw.log'));
    const rawName = names.find((name) => name.endsWith('.raw.log'));
    assert.equal(names.length, 2);
    const log = fs.readFileSync(path.join(directory, reduced), 'utf8');
    assert.match(log, /## comparison 1/);
    assert.match(log, new RegExp(rawName.replace(/[.]/g, '\\.')));
    assert.match(log, /count: 3/);
    assert.ok(!log.includes('\x1b'));
    controller.toggleVerbose();
    assert.ok(controller.output.includes(TABLE_KEY));
    assert.ok(!controller.output.includes('## '));
    controller.move(-2);
    const lines = controller.output.trimEnd().split('\n').length;
    assert.equal(controller.logScroll, lines - logViewRows(14) - 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('assertion tables drop the repeated comparison line', () => {
  const quote = String.fromCharCode(39);
  const compared = `${quote}two\\n${quote} !== ${quote}one\\n${quote}`;
  const raw = [
    '✖ strings',
    '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
    '  ',
    `  ${compared}`,
    '      at check (/repo/lib/check.js:4:3) {',
    '    generatedMessage: true,',
    '    code: ERR_ASSERTION,',
    `    actual: ${quote}two\\n${quote},`,
    `    expected: ${quote}one\\n${quote},`,
    '    operator: strictEqual,',
    `    diff: ${quote}simple${quote}`,
    '  }',
    'ℹ tests 1',
    'ℹ pass 0',
    'ℹ fail 1',
  ].join('\n');
  const doc = buildDocument(raw, '', '/repo', 1, 'test');
  const plain = stripAnsi(renderReport(doc));
  assert.match(plain, /expected\s+one\\n/);
  assert.match(plain, /actual\s+two\\n/);
  assert.match(plain, /Expected values to be strictly equal/);
  assert.ok(!plain.includes('equal:'));
  assert.ok(!plain.includes('!=='));
  assert.ok(!plain.includes('generatedMessage'));
  assert.ok(!plain.includes('diff'));
  assert.ok(!plain.includes('severity'));
  const rows = plain.split('\n');
  const messageAt = rows.findIndex((line) => line.includes('strictly equal'));
  assert.ok(messageAt > 0);
  const bar = '│ Expected values to be strictly equal';
  assert.equal(rows[messageAt].trim(), bar);
  assert.ok(!plain.includes('```'));
});

test('passing TAP reports keep a clean successful TUI summary', () => {
  const doc = buildDocument('ok 1 - hidden pass\n1..1', '', '/repo', 0, 'test');
  const output = stripAnsi(renderReport(doc));
  assert.match(output, /✔ test {2}· {2}exit 0/);
  assert.match(output, /passed\s+1/);
  assert.match(output, /failed\s+0/);
  assert.ok(!output.includes('hidden pass'));
  assert.ok(!output.includes('Stack'));
});
