'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildDocument } = require('../lib/report-parse.js');
const render = require('../lib/report-render.js');

const { renderMarkdown, NOTICE } = render;
const { run } = require('../lib/cli.js');
const { winCommand } = require('../lib/report-run.js');
const { sink, tempDir } = require('./helpers.js');

const ROOT = '/repo';

const rendered = (stdout, stderr, exit) => {
  const doc = buildDocument(stdout, stderr, ROOT, exit, '');
  return {
    doc,
    md: renderMarkdown(doc),
  };
};

const tap = [
  'TAP version 13',
  'ok 1 - passes',
  '  ---',
  '  duration_ms: 1',
  '  ...',
  'not ok 2 - adds numbers',
  '  ---',
  '  duration_ms: 12',
  '  error: expected 3, got 4',
  '  code: ERR_ASSERTION',
  '  operator: strictEqual',
  '  expected: 3',
  '  actual: 4',
  '  stack: |-',
  '    at add (/repo/lib/add.js:2:10)',
  '    at Test.run (node:internal/test_runner/test:1:1)',
  '  ...',
  '# tests 2',
  '# pass 1',
  '# fail 1',
  '# skipped 0',
  '# duration_ms 12.5',
  '1..2',
].join('\n');

test('TAP keeps failures, fields, and a user trace', () => {
  const view = rendered(tap, '', 1);
  assert.match(view.md, /adds numbers/);
  assert.match(view.md, /operator: strictEqual/);
  assert.match(view.md, /code: ERR_ASSERTION/);
  assert.match(view.md, /expected: 3/);
  assert.match(view.md, /actual: 4/);
  assert.match(view.md, /duration: 12/);
  assert.match(view.md, /lib\/add\.js:2:10/);
  assert.ok(!view.md.includes('passes'));
  assert.ok(!view.md.includes('node:internal'));
  assert.ok(!view.md.includes(ROOT));
  assert.match(view.md, /exit: 1/);
  assert.ok(view.md.startsWith(NOTICE));
});

test('node:test spec drops passes and keeps stats', () => {
  const raw = [
    '✔ hidden',
    '✖ adds numbers',
    '  AssertionError [ERR_ASSERTION]: expected 3, got 4',
    '      at add (/repo/lib/add.js:2:10)',
    '      at Test.run (node:internal/test_runner/test:1:1)',
    '  {',
    '    code: ERR_ASSERTION,',
    '    operator: strictEqual,',
    '    expected: 3,',
    '    actual: 4',
    '  }',
    'ℹ tests 2',
    'ℹ pass 1',
    'ℹ fail 1',
    'ℹ skipped 0',
    'ℹ duration_ms 12',
  ].join('\n');
  const view = rendered(raw, '', 1);
  assert.ok(!view.md.includes('hidden'));
  assert.ok(!view.md.includes('node:internal'));
  assert.match(view.md, /passed: 1/);
  assert.match(view.md, /failed: 1/);
  assert.match(view.md, /operator: strictEqual/);
  assert.match(view.md, /lib\/add\.js:2:10/);
});

test('node:test spec reads the object on the last frame', () => {
  const quote = String.fromCharCode(39);
  const raw = [
    '✖ adds',
    'ℹ tests 1',
    'ℹ pass 0',
    'ℹ fail 1',
    '✖ failing tests:',
    'test at test/highlight.test.js:14:1',
    '✖ adds',
    '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
    '  ',
    '  1 !== 2',
    '      at TestContext.<anonymous> (test/highlight.test.js:15:10)',
    '      at Test.run (node:internal/test_runner/test:1:1) {',
    '    generatedMessage: true,',
    `    code: ${quote}ERR_ASSERTION${quote},`,
    '    actual: 1,',
    '    expected: 2,',
    '    operator: strictEqual,',
    `    diff: ${quote}simple${quote}`,
    '  }',
  ].join('\n');
  const view = rendered(raw, '', 1);
  assert.equal(view.doc.reports[0].problems.length, 1);
  assert.ok(!view.md.includes('failing tests'));
  assert.ok(!view.md.includes('\n{'));
  assert.ok(!view.md.includes('node:internal'));
  assert.match(view.md, /code: ERR_ASSERTION/);
  assert.match(view.md, /operator: strictEqual/);
  assert.match(view.md, /expected: 2/);
  assert.match(view.md, /actual: 1/);
  assert.match(view.md, /test\/highlight\.test\.js:15:10/);
});

test('jest JSON keeps failed tests only', () => {
  const raw = JSON.stringify({
    success: false,
    numPassedTests: 1,
    numFailedTests: 1,
    numPendingTests: 0,
    testResults: [
      {
        name: '/repo/a.test.js',
        assertionResults: [
          { status: 'passed', fullName: 'ok test', failureMessages: [] },
          {
            status: 'failed',
            fullName: 'adds numbers',
            failureMessages: [
              'Expected: 3\nReceived: 4\n    at add (/repo/lib/add.js:2:10)',
            ],
          },
        ],
      },
    ],
  });
  const view = rendered(raw, 'npm warn noise\n', 1);
  assert.ok(!view.md.includes('ok test'));
  assert.ok(!view.md.includes('numFailedTests'));
  assert.match(view.md, /adds numbers/);
  assert.match(view.md, /expected: 3/);
  assert.match(view.md, /actual: 4/);
  assert.match(view.md, /# stderr/);
  assert.match(view.md, /npm warn noise/);
  assert.match(view.md, /passed: 1/);
});

test('tsc, eslint stylish, and prettier stay separate', () => {
  const raw = [
    'lib/a.ts(1,2): error TS2322: bad type',
    '/repo/lib/a.js',
    '  1:1  warning  unused  no-unused-vars',
    'Checking formatting...',
    '[warn] lib/b.js',
    'Code style issues found in the above file.',
  ].join('\n');
  const view = rendered(raw, '', 1);
  assert.match(view.md, /# tsc/);
  assert.match(view.md, /TS2322/);
  assert.match(view.md, /lib\/a\.ts:1:2/);
  assert.match(view.md, /# eslint/);
  assert.match(view.md, /no-unused-vars/);
  assert.match(view.md, /warning/);
  assert.match(view.md, /# prettier/);
  assert.match(view.md, /lib\/b\.js/);
  assert.ok(!view.md.includes('unix'));
});

test('eslint JSON warnings keep exit 0', () => {
  const raw = JSON.stringify([
    {
      filePath: '/repo/lib/a.js',
      messages: [
        {
          ruleId: 'no-unused-vars',
          severity: 1,
          message: 'unused',
          line: 3,
          column: 1,
        },
      ],
      errorCount: 0,
      warningCount: 1,
    },
  ]);
  const view = rendered(raw, '', 0);
  assert.equal(view.doc.ok, true);
  assert.equal(view.doc.exit, 0);
  assert.match(view.md, /ok: true/);
  assert.match(view.md, /warnings: 1/);
  assert.match(view.md, /no-unused-vars/);
  assert.match(view.md, /lib\/a\.js:3:1/);
});

test('similar eslint problems are grouped', () => {
  const lines = ['/repo/lib/a.js'];
  for (let index = 1; index <= 4; index++) {
    lines.push(`  ${index}:1  error  nope  no-unused-vars`);
  }
  lines.push('  5:1  error  other  no-undef');
  const view = rendered(lines.join('\n'), '', 1);
  assert.match(view.md, /errors: 5/);
  assert.match(view.md, /count: 4/);
  assert.match(view.md, /omitted: 1/);
  assert.equal(view.doc.reports[0].problems.length, 2);
  const traces = view.md.split('trace:').length - 1;
  assert.equal(traces, 4);
});

test('audit, outdated, and ls JSON omit trees', () => {
  const audit = JSON.stringify({
    vulnerabilities: {
      leftpad: {
        name: 'leftpad',
        severity: 'high',
        via: [{ title: 'bad title' }],
        range: '<1.2.0',
        fixAvailable: { name: 'leftpad', version: '1.2.0' },
      },
    },
  });
  const auditView = rendered(audit, '', 1);
  assert.match(auditView.md, /leftpad/);
  assert.match(auditView.md, /high/);
  assert.match(auditView.md, /fix: 1.2.0/);
  assert.ok(!auditView.md.includes('vulnerabilities'));
  const outdated = JSON.stringify({
    leftpad: { current: '1.0.0', wanted: '1.1.0', latest: '1.2.0' },
    same: { current: '1.0.0', wanted: '1.0.0', latest: '1.0.0' },
  });
  const oldView = rendered(outdated, '', 1);
  assert.match(oldView.md, /leftpad/);
  assert.ok(!oldView.md.includes('\nsame'));
  const tree = JSON.stringify({
    name: 'app',
    problems: ['missing: foo@1'],
    dependencies: {
      bar: { version: '1.0.0', dependencies: { baz: { version: '2.0.0' } } },
    },
  });
  const lsView = rendered(tree, '', 1);
  assert.match(lsView.md, /missing: foo@1/);
  assert.ok(!lsView.md.includes('baz'));
});

test('windows command line keeps a quoted eval script', () => {
  const script = 'console.log("✔ hidden")';
  const line = winCommand('node', ['-e', script]);
  assert.equal(line, `"node -e "console.log(""✔ hidden"")""`);
});

const fakeProc = (cwd, extra = {}) => {
  const stdout = sink();
  const stderr = sink();
  const env = { ...process.env };
  delete env.RESLOP_CAPTURE;
  delete env.RESLOP_OUTPUT;
  const overlay = extra.env ?? {};
  for (const key of Object.keys(overlay)) env[key] = overlay[key];
  return {
    argv: extra.argv ?? ['node', 'reslop'],
    cwd: () => cwd,
    stdin: { isTTY: extra.tty ?? false },
    stdout,
    stderr,
    env,
    stdoutText: () => stdout.dump(),
    stderrText: () => stderr.dump(),
  };
};

test('a pipe prints markdown and writes a log', async () => {
  const dir = tempDir('reslop-report-');
  const script = [
    'console.log("✔ hidden")',
    'console.log("ℹ tests 1")',
    'console.log("ℹ pass 1")',
    'console.log("ℹ fail 0")',
  ].join(';');
  try {
    const proc = fakeProc(dir, {
      argv: ['node', 'reslop', 't', '--', 'node', '-e', script],
    });
    const code = await run(proc);
    assert.equal(code, 0);
    const text = proc.stdoutText();
    assert.ok(text.startsWith(NOTICE));
    assert.match(text, /passed: 1/);
    assert.ok(!text.includes('hidden'));
    const logs = fs.readdirSync(path.join(dir, '.log'));
    assert.equal(logs.length, 1);
    const saved = fs.readFileSync(path.join(dir, '.log', logs[0]), 'utf8');
    assert.equal(saved, text);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a terminal prints markdown by default', async () => {
  const dir = tempDir('reslop-report-');
  const script = [
    'console.log("ℹ tests 1")',
    'console.log("ℹ pass 1")',
    'console.log("ℹ fail 0")',
  ].join(';');
  try {
    const proc = fakeProc(dir, {
      tty: true,
      argv: ['node', 'reslop', 't', '--', 'node', '-e', script],
    });
    proc.stdout.isTTY = true;
    const code = await run(proc);
    assert.equal(code, 0);
    const text = proc.stdoutText();
    assert.match(text, /# test/);
    assert.match(text, /passed: 1/);
    assert.ok(!text.includes('\x1b['));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RESLOP_OUTPUT selects raw and rejects unknown', async () => {
  const dir = tempDir('reslop-report-');
  const out = path.join(dir, 'out.txt');
  const script = 'require("fs").writeFileSync(process.argv.at(-1), "✔ hidden")';
  try {
    const raw = fakeProc(dir, {
      argv: ['node', 'reslop', 't', '--', 'node', '-e', script, out],
      env: { RESLOP_OUTPUT: 'raw' },
    });
    assert.equal(await run(raw), 0);
    assert.equal(fs.readFileSync(out, 'utf8'), '✔ hidden');
    assert.equal(raw.stdoutText(), '');
    assert.ok(!fs.existsSync(path.join(dir, '.log')));
    const pretty = fakeProc(dir, {
      argv: ['node', 'reslop', 't', '--', 'node', '-e', 'process.exit(0)'],
      env: { RESLOP_OUTPUT: 'pretty' },
    });
    assert.equal(await run(pretty), 1);
    assert.match(pretty.stderrText(), /unknown RESLOP_OUTPUT pretty/);
    assert.equal(pretty.stdoutText(), '');
    const bad = fakeProc(dir, {
      argv: ['node', 'reslop', 't', '--', 'node', '-e', 'process.exit(0)'],
      env: { RESLOP_OUTPUT: 'xml' },
    });
    assert.equal(await run(bad), 1);
    assert.match(bad.stderrText(), /unknown RESLOP_OUTPUT xml/);
    assert.equal(bad.stdoutText(), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('capture mode and child status pass through', async () => {
  const dir = tempDir('reslop-report-');
  try {
    const out = path.join(dir, 'inner.txt');
    const script =
      'require("fs").writeFileSync(process.argv.at(-1), "✔ hidden")';
    const inner = fakeProc(dir, {
      argv: ['node', 'reslop', 't', '--', 'node', '-e', script, out],
      env: { RESLOP_CAPTURE: '1' },
    });
    assert.equal(await run(inner), 0);
    assert.equal(fs.readFileSync(out, 'utf8'), '✔ hidden');
    assert.equal(inner.stdoutText(), '');
    const failed = fakeProc(dir, {
      argv: ['node', 'reslop', 't', '--', 'node', '-e', 'process.exit(3)'],
    });
    assert.equal(await run(failed), 3);
    assert.match(failed.stdoutText(), /exit: 3/);
    const args = fakeProc(dir, {
      argv: [
        'node',
        'reslop',
        't',
        '--',
        'node',
        '-e',
        'process.exit(process.argv.at(-1)==="hello"?0:4)',
        'hello',
      ],
    });
    assert.equal(await run(args), 0);
    const missing = fakeProc(dir, { argv: ['node', 'reslop', 't'] });
    assert.equal(await run(missing), 1);
    assert.match(missing.stderrText(), /missing command/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
