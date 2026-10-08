'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('./helpers.js');
const { buildDocument } = require('../lib/report-parse.js');
const { renderDocument } = require('../lib/report-render.js');

const parsed = (lines, root = '/repo') => {
  const doc = buildDocument(lines.join('\n'), '', root, 1, 'test');
  return { report: doc.reports[0], md: renderDocument(doc) };
};

const textFailure = (number, name, message, caller) => [
  `not ok ${number} ${name}`,
  `  TypeError: ${message}`,
  '      at read (/repo/lib/read.js:4:5)',
  `      at test (/repo/test/${caller}.js:10:2)`,
  '      at Test.run (node:internal/test_runner/test:1:1)',
];

test('TAP text failures group before filtering without a header', () => {
  const { report, md } = parsed([
    'ok 1 hidden pass',
    ...textFailure(2, 'first', 'missing id', 'a'),
    ...textFailure(3, 'second', 'missing id', 'b'),
    ...textFailure(4, 'third', 'missing name', 'c'),
    '1..4',
  ]);
  assert.equal(report.summary.passed, 1);
  assert.equal(report.summary.failed, 3);
  assert.equal(report.problems.length, 2);
  assert.equal(report.problems[0].count, 2);
  assert.match(md, /type: TypeError/);
  assert.match(md, /lib\/read\.js:4:5/);
  assert.ok(!md.includes('hidden pass'));
  assert.ok(!md.includes('node:'));
  assert.ok(!md.includes('/repo'));
});

test('TAP YAML, exception text, and at fields share one error identity', () => {
  const { report } = parsed([
    'not ok 1 - YAML stack',
    '  ---',
    '  error: TypeError: missing id',
    '  stack: |-',
    '    read (/repo/lib/read.js:4:5)',
    '    TestContext.<anonymous> (/repo/test/node.js:10:2)',
    '    Test.run (node:internal/test_runner/test:1:1)',
    '  ...',
    ...textFailure(2, 'exception text', 'missing id', 'mocha'),
    'not ok 3 - nested error with at',
    '  ---',
    '  error:',
    '    name: "TypeError"',
    '    message: "missing id"',
    '  at: "file:///repo/lib/read.js:4:5"',
    '  ...',
    '1..3',
  ]);
  assert.equal(report.summary.failed, 3);
  assert.equal(report.problems.length, 1);
  assert.equal(report.problems[0].count, 3);
  assert.equal(report.problems[0].traces.length, 1);
  assert.equal(report.problems[0].related.length, 2);
});

test('TAP grouped stacks keep distinct operations in compact contexts', () => {
  const failure = (number, name, operation, api, line) => [
    `not ok ${number} - ${name}`,
    '  Error: error: patch failed: f.txt:1',
    '    at requireOk (/repo/lib/git-worktree.js:46:9)',
    '    at applyPatch (/repo/lib/git-worktree.js:347:3)',
    `    at ${operation} (/repo/lib/git-worktree.js:${line}:3)`,
    `    at ${api} (/repo/lib/git.js:28:10)`,
    `    at TestContext.<anonymous> (/repo/test/git.test.js:${number}:5)`,
    '    at Test.run (node:internal/test_runner/test:1:1)',
  ];
  const { report, md } = parsed([
    ...failure(1, 'add block', 'addItem', 'addGitItem', 355),
    ...failure(2, 'revert block', 'revertItem', 'revertGitItem', 400),
    ...failure(3, 'unstage block', 'unstageItem', 'unstageGitItem', 364),
    '1..3',
  ]);
  const item = report.problems[0];
  assert.equal(report.problems.length, 1);
  assert.equal(item.count, 3);
  assert.equal(item.traces.length, 1);
  assert.equal(item.omitted, 0);
  assert.match(item.trace, /^ {2}at requireOk/);
  assert.match(item.trace, /\n {2}at applyPatch/);
  assert.match(md, /- trace:\n {2}at requireOk/);
  assert.deepEqual(item.related, [
    'revert block | revertItem (lib/git-worktree.js:400:3) | ' +
      'test/git.test.js:2:5',
    'unstage block | unstageItem (lib/git-worktree.js:364:3) | ' +
      'test/git.test.js:3:5',
  ]);
  assert.ok(!md.includes('severity:'));
  assert.match(md, /type: Error/);
  assert.match(md, /error: patch failed: f\.txt:1/);
  assert.equal(md.split('- trace:').length - 1, 1);
  assert.equal(md.split('requireOk').length - 1, 1);
  assert.equal(md.split('applyPatch').length - 1, 1);
  assert.match(md, /- related:\n {2}- revert block/);
  assert.match(md, /revertItem/);
  assert.match(md, /unstageItem/);
});

test('TAP repeated contexts remain bounded and count every failure', () => {
  const lines = [];
  for (let index = 1; index <= 10; index++) {
    lines.push(...textFailure(index, `test ${index}`, 'missing id', index));
  }
  const { report } = parsed([...lines, '1..10']);
  const item = report.problems[0];
  assert.equal(item.count, 10);
  assert.equal(item.traces.length, 1);
  assert.equal(item.related.length, 2);
  assert.equal(item.omitted, 7);
  const duplicate = textFailure(1, 'same test', 'missing id', 'a');
  const identical = parsed([...duplicate, ...duplicate, ...duplicate]);
  const repeated = identical.report.problems[0];
  assert.equal(repeated.count, 3);
  assert.equal(repeated.traces.length, 1);
  assert.equal(repeated.related.length, 0);
  assert.equal(repeated.omitted, 2);
});

const nestedFailure = (number, type, message) => [
  `    not ok ${number} - test ${number} # time=1.00ms`,
  '        ---',
  '        error:',
  `            name: ${JSON.stringify(type)}`,
  `            message: "${message}"`,
  '        at: "/repo/lib/shared.js:4:5"',
  '        ...',
];

test('TAP nested errors keep multiline messages and leaf counts', () => {
  const { report, md } = parsed([
    'TAP version 13',
    '1..1',
    'not ok 1 - file.test.js # time=1.00ms {',
    '    1..6',
    '    ok 1 - hidden pass # time=1.00ms',
    ...nestedFailure(2, 'AssertionError', 'Expected:\n\n4 !== 3\n'),
    ...nestedFailure(3, 'AssertionError', 'Expected:\n\n4 !== 3\n'),
    ...nestedFailure(4, 'AssertionError', 'Expected:\n\n10 !== 20\n'),
    ...nestedFailure(5, 'TypeError', 'same failure'),
    ...nestedFailure(6, 'RangeError', 'same failure'),
    '}',
  ]);
  assert.equal(report.summary.tests, 6);
  assert.equal(report.summary.failed, 5);
  assert.equal(report.problems.length, 4);
  assert.equal(report.problems[0].count, 2);
  assert.match(report.problems[0].message, /4 !== 3/);
  assert.match(report.problems[1].message, /10 !== 20/);
  assert.match(md, /lib\/shared\.js:4:5/);
  assert.ok(!md.includes('time=1.00ms'));
});

test('TAP assertion fields accept found and wanted without losing zero', () => {
  const { report } = parsed([
    'TAP version 14',
    'not ok 1 - compares',
    '  ---',
    '  operator: equal',
    '  wanted: 0',
    '  found: false',
    '  at: check (/repo/lib/check.js:2:3)',
    '  ...',
    '1..1',
  ]);
  assert.equal(report.problems[0].expected, '0');
  assert.equal(report.problems[0].actual, 'false');
  assert.equal(report.problems[0].trace, 'check (lib/check.js:2:3)');
});

test('TAP comment diagnostics use the same exception parser', () => {
  const lines = textFailure(1, 'first', 'missing id', 'a');
  const other = textFailure(2, 'second', 'missing id', 'b');
  const commented = (rows) =>
    rows.map((row, index) => (index ? `# ${row}` : row));
  const { report } = parsed([...commented(lines), ...commented(other), '1..2']);
  assert.equal(report.problems.length, 1);
  assert.equal(report.problems[0].count, 2);
  assert.equal(report.problems[0].message, 'missing id');
});

test('TAP missing diagnostics preserve distinct failure titles', () => {
  const { report } = parsed([
    'not ok - first',
    'not ok - second',
    'not ok - first',
    '1..3',
  ]);
  assert.equal(report.problems.length, 2);
  assert.equal(report.problems[0].message, 'first');
  assert.equal(report.problems[0].count, 2);
});

test('TAP SKIP and TODO directives do not become error groups', () => {
  const { report } = parsed([
    'TAP version 14',
    'ok 1 - later # SKIP no platform',
    'not ok 2 - future # TODO implement',
    'not ok 3 - failure',
    '1..3',
  ]);
  assert.equal(report.summary.skipped, 2);
  assert.equal(report.summary.failed, 1);
  assert.equal(report.problems.length, 1);
});

test('TAP incomplete YAML does not consume the following failure', () => {
  const { report } = parsed([
    'not ok 1 - first',
    '  ---',
    '  error: first failure',
    'not ok 2 - second',
    '  ---',
    '  error: second failure',
    '  ...',
    '1..2',
  ]);
  assert.equal(report.problems.length, 2);
  assert.equal(report.problems[1].message, 'second failure');
});

test('TAP object values remain intact for grouping and display', () => {
  const failure = (number, value) => [
    `not ok ${number} - test ${number}`,
    '  ---',
    '  error: different objects',
    '  expected:',
    '    user:',
    '      id: 1',
    '  actual:',
    '    user:',
    `      id: ${value}`,
    '  stack: |-',
    '    at check (/repo/lib/check.js:2:3)',
    '  ...',
  ];
  const { report, md } = parsed([
    ...failure(1, 2),
    ...failure(2, 2),
    ...failure(3, 3),
    '1..3',
  ]);
  assert.equal(report.problems.length, 2);
  assert.equal(report.problems[0].count, 2);
  assert.match(report.problems[0].actual, /user:\n {2}id: 2/);
  assert.match(md, /id: 3/);
});

test('TAP Node container failures do not repeat child diagnostics', () => {
  const { report } = parsed([
    ...textFailure(1, 'child', 'missing id', 'a'),
    'not ok 1 - parent',
    '  ---',
    '  failureType: subtestsFailed',
    '  error: 1 subtest failed',
    '  ...',
    '1..1',
  ]);
  assert.equal(report.problems.length, 1);
  assert.equal(report.problems[0].name, 'child');
});

test('TUI groups and saves TAP without a version header', async () => {
  const root = tempDir();
  try {
    const raw = [
      ...textFailure(1, 'first', 'missing id', 'a'),
      ...textFailure(2, 'second', 'missing id', 'b'),
      '1..2',
    ]
      .join('\n')
      .replaceAll('/repo', root);
    const { NpmController } = require('../lib/session/npm.js');
    const ui = {
      top: root,
      nav: { npmCursor: 0 },
      progress: { start() {}, stop() {} },
      paint() {},
      repo: {
        runNpmCommand(cwd, entry, onData, onClose) {
          onData(raw);
          return onClose({ text: raw, status: 1 });
        },
      },
    };
    const controller = new NpmController(ui);
    controller.commands = [{ name: 'test', kind: 'script' }];
    await controller.run();
    assert.match(controller.output, /× 2/);
    assert.ok(!controller.output.includes('## '));
    assert.ok(!controller.output.includes('node:'));
    const directory = path.join(root, '.log');
    const names = fs.readdirSync(directory);
    const reduced = names.find((name) => name.endsWith('.log'));
    const rawName = names.find((name) => name.endsWith('.raw'));
    assert.equal(names.length, 2);
    const log = fs.readFileSync(path.join(directory, reduced), 'utf8');
    assert.match(log, /count: 2/);
    assert.match(log, new RegExp(rawName.replace(/[.]/g, '\\.')));
    const savedRaw = fs.readFileSync(path.join(directory, rawName), 'utf8');
    assert.match(savedRaw, /missing id/);
    controller.toggleVerbose();
    assert.equal(controller.output.trimEnd(), raw);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
