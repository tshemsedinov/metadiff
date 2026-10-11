'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('./helpers.js');
const { buildDocument } = require('../lib/report/parse.js');
const report = require('../lib/report/render.js');
const { renderDocument, renderReport } = report;

const fixture = String.raw`
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const check = (actual, expected) => assert.strictEqual(actual, expected);
const missing = (key) => undefined[key];
const typed = (Type) => { throw new Type('same failure'); };
const first = () => { throw new Error('same origin message'); };
const second = () => { throw new Error('same origin message'); };
test('hidden pass', () => assert.ok(true));
test('repeat one', () => check(4, 3));
test('repeat two', () => check(4, 3));
test('repeat three', () => check(4, 3));
test('repeat four', () => check(4, 3));
test('other values', () => check(10, 20));
test('missing id one', () => missing('id'));
test('missing id two', () => missing('id'));
test('missing name', () => missing('name'));
test('type', () => typed(TypeError));
test('range', () => typed(RangeError));
test('origin one', () => first());
test('origin two', () => second());
`;

const rawRun = (root, reporter) => {
  const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    ['--test', `--test-reporter=${reporter}`, 'failure.cjs'],
    {
      cwd: root,
      encoding: 'utf8',
      env,
    },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /node:internal\/test_runner/);
  return result;
};

for (const reporter of ['tap', 'spec']) {
  const title = `raw node:test ${reporter} groups and filters in one pipeline`;
  test(title, async () => {
    const root = tempDir();
    try {
      fs.writeFileSync(path.join(root, 'failure.cjs'), fixture);
      const result = rawRun(root, reporter);
      const doc = buildDocument(result.stdout, result.stderr, root, 1, 'test');
      const report = doc.reports[0];
      assert.equal(report.summary.passed, 1);
      assert.equal(report.summary.failed, 12);
      assert.equal(report.problems.length, 8);
      const repeated = report.problems.find((item) => item.count === 4);
      assert.ok(repeated);
      assert.equal(repeated.expected, '3');
      assert.equal(repeated.actual, '4');
      assert.match(repeated.message, /4 !== 3/);
      assert.equal(repeated.traces.length, 1);
      assert.equal(repeated.related.length, 2);
      assert.equal(repeated.omitted, 1);
      const missing = report.problems.find((item) => item.count === 2);
      assert.ok(missing);
      assert.match(missing.message, /reading 'id'/);
      assert.equal(missing.traces.length, 1);
      assert.equal(missing.related.length, 1);
      const preview = renderDocument(doc);
      assert.ok(!preview.includes('hidden pass'));
      assert.ok(!preview.includes('node:'));
      assert.ok(!preview.includes(root));
      assert.match(preview, /failure\.cjs:\d+:\d+/);
      assert.match(preview, /count: 4/);
      assert.match(preview, /omitted: 1/);
      assert.ok(!preview.includes(repeated.key));
      const npm = require('../lib/session/npm/npm.js');
      const ui = {
        top: root,
        nav: { npmCursor: 0 },
        progress: { start() {}, stop() {} },
        paint() {},
        repo: {
          runNpmCommand(cwd, entry, onData, onClose) {
            onData(result.stdout);
            return onClose({ text: result.stdout, status: result.status });
          },
        },
      };
      const controller = new npm.NpmController(ui);
      controller.commands = [{ name: 'test', kind: 'script' }];
      await controller.run();
      controller.openView(controller.runs.at(-1).id);
      const output = renderReport(doc);
      assert.equal(controller.output, output);
      assert.notEqual(controller.output, preview);
      assert.ok(!controller.output.includes('## '));
      const logDir = path.join(root, '.log');
      const logs = fs.readdirSync(logDir);
      const reduced = logs.find((name) => name.endsWith('.log'));
      const rawName = logs.find((name) => name.endsWith('.raw'));
      assert.equal(logs.length, 3);
      assert.ok(logs.some((name) => name.endsWith('.json')));
      const md = renderDocument(doc, rawName);
      const logText = md
        .split('\n')
        .map((line) => line.trimEnd())
        .join('\n');
      const saved = fs.readFileSync(path.join(logDir, reduced), 'utf8');
      assert.equal(saved, logText);
      const savedRaw = fs.readFileSync(path.join(logDir, rawName), 'utf8');
      assert.match(savedRaw, /hidden pass/);
      controller.toggleVerbose();
      assert.equal(controller.output, result.stdout);
      controller.toggleVerbose();
      assert.equal(controller.output, output);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('raw error key keeps types and exact origin coordinates', () => {
  const model = require('../lib/report/model.js');
  const { errorKey } = model;
  const first = errorKey(
    { message: 'TypeError: same failure' },
    'TypeError: same failure\n    at read (/repo/lib/a.js:10:2)',
    '/repo',
  );
  const otherLine = errorKey(
    { message: 'TypeError: same failure' },
    'TypeError: same failure\n    at read (/repo/lib/a.js:11:2)',
    '/repo',
  );
  const otherType = errorKey(
    { message: 'RangeError: same failure' },
    'RangeError: same failure\n    at read (/repo/lib/a.js:10:2)',
    '/repo',
  );
  assert.notEqual(first, otherLine);
  assert.notEqual(first, otherType);
});

test('raw error key ignores internal frames and calling tests', () => {
  const model = require('../lib/report/model.js');
  const { errorKey } = model;
  const fields = { message: 'TypeError: same failure' };
  const first = errorKey(
    fields,
    [
      'TypeError: same failure',
      '    at internal (node:internal/example:1:2)',
      '    at read (/repo/lib/a.js:10:2)',
      '    at TestContext.<anonymous> (/repo/test/a.js:1:2)',
    ].join('\n'),
    '/repo',
  );
  const second = errorKey(
    fields,
    [
      'TypeError: same failure',
      '    at internal (node:internal/example:9:9)',
      '    at read (/repo/lib/a.js:10:2)',
      '    at TestContext.<anonymous> (/repo/test/b.js:8:9)',
    ].join('\n'),
    '/repo',
  );
  assert.equal(first, second);
});
