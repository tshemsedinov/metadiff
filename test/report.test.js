'use strict';

const nodeTest = require('node:test');
const { test } = nodeTest;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const reportParse = require('../lib/report-parse.js');
const { buildDocument } = reportParse;
const render = require('../lib/report-render.js');

const { renderDocument, notice, NOTICE_HEAD, displayMessage } = render;
const cli = require('../lib/cli.js');
const { run } = cli;
const reportRun = require('../lib/report-run.js');
const { winCommand } = reportRun;
const runsLib = require('../lib/runs.js');
const { readRuns } = runsLib;
const helpers = require('./helpers.js');
const { sink, tempDir } = helpers;

const model = require('../lib/report-model.js');
const { problem, groupReport } = model;

const ROOT = '/repo';

const rendered = (stdout, stderr, exit) => {
  const doc = buildDocument(stdout, stderr, ROOT, exit, '');
  return {
    doc,
    md: renderDocument(doc),
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
  assert.match(view.md, /exit: 1\n$/);
  assert.ok(view.md.startsWith(notice()));
  assert.ok(view.md.indexOf('# ') < view.md.lastIndexOf('exit:'));
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
    '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
    '  ',
    '  1 !== 2',
    '      at TestContext.<anonymous> (test/highlight.test.js:15:10)',
    '      at Test.run (node:internal/test_runner/test:1:1) {',
    '    generatedMessage: true,',
    `    code: ${quote}ERR_ASSERTION${quote},`,
    '    actual: 1,',
    '    expected: 2,',
    '    operator: strictEqual',
    '  }',
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
  assert.equal(view.doc.reports[0].problems[0].count, 1);
  assert.ok(!view.md.includes('failing tests'));
  assert.ok(!view.md.includes('\n{'));
  assert.ok(!view.md.includes('node:internal'));
  assert.match(view.md, /code: ERR_ASSERTION/);
  assert.match(view.md, /operator: strictEqual/);
  assert.match(view.md, /expected: 2/);
  assert.match(view.md, /actual: 1/);
  assert.match(view.md, /test\/highlight\.test\.js:15:10/);
  assert.match(view.md, /> Expected values to be strictly equal\n/);
  assert.ok(!view.md.includes('```'));
  assert.ok(!view.md.includes('- message:'));
  assert.ok(!view.md.includes('severity:'));
  assert.ok(!view.md.includes('generatedMessage'));
  assert.ok(!view.md.includes('diff:'));
  assert.ok(!view.md.includes('1 !== 2'));
  assert.ok(!view.md.includes('equal:\n\n'));
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

test('message drops a parsed diff and a trailing colon', () => {
  const quote = String.fromCharCode(39);
  const actual = `${quote}error: patch failed: f.txt:1${quote}`;
  const diff = [
    'Expected values to be strictly equal:',
    '+ actual - expected',
    '',
    `+ ${actual}`,
    `- ${quote}staged${quote}`,
  ].join('\n');
  const shown = displayMessage({
    expected: 'staged',
    actual: 'error: patch failed: f.txt:1',
    message: diff,
  });
  assert.equal(shown, 'Expected values to be strictly equal');
  const colored = [
    'Expected values to be strictly equal:',
    'actual expected',
    `${quote}error: pastch failged: f.txt:1${quote}`,
  ].join('\n');
  const plain = displayMessage({
    expected: 'staged',
    actual: 'error: patch failed: f.txt:1',
    message: colored,
  });
  assert.equal(plain, 'Expected values to be strictly equal');
  const kept = displayMessage({
    expected: '',
    actual: '',
    message: 'error: patch failed: f.txt:1',
  });
  assert.equal(kept, 'error: patch failed: f.txt:1');
});

test('a passing prettier check stays out of a failed run', () => {
  const raw = [
    'Checking formatting...',
    'All matched files use Prettier code style!',
    'TAP version 13',
    'not ok 1 - adds',
    '  ---',
    '  error: boom',
    '  ...',
    '1..1',
  ].join('\n');
  const view = rendered(raw, '', 1);
  assert.equal(view.doc.ok, false);
  assert.ok(!view.md.includes('# prettier'));
  assert.ok(!view.md.includes('errors: 0'));
  assert.match(view.md, /# test/);
  assert.match(view.md, /boom/);
});

test('prettier file warnings on stderr stay in the report', () => {
  const stdout = 'Checking formatting...\n';
  const stderr = [
    '[warn] lib/b.js',
    '[warn] Code style issues found in the above file.',
  ].join('\n');
  const view = rendered(stdout, stderr, 1);
  assert.match(view.md, /# prettier/);
  assert.match(view.md, /ok: false/);
  assert.match(view.md, /errors: 1/);
  assert.match(view.md, /lib\/b\.js/);
  assert.ok(!view.md.includes('# stderr'));
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
  assert.match(view.md, /severity: warning/);
  assert.match(view.md, /no-unused-vars/);
  assert.match(view.md, /lib\/a\.js:3:1/);
});

test('cluster errors by normalized stack trace', () => {
  const problems = [
    problem({
      message: 'Cannot read property id of undefined at user.js:10:5',
      trace: 'at User.get (lib/user.js:10:5)\nat process.tick',
    }),
    problem({
      message: 'Cannot read property id of undefined at user.js:25:12',
      trace: 'at User.get (lib/user.js:25:12)\nat process.tick',
    }),
  ];
  const grouped = groupReport({ tool: 'node:test', problems }).problems;
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].count, 2);
  assert.equal(grouped[0].traces.length, 1);
  assert.equal(grouped[0].related.length, 1);
});

test('raw error identity keeps different assertion values separate', () => {
  const problems = [
    problem({
      code: 'ERR_ASSERTION',
      operator: 'strictEqual',
      expected: '3',
      actual: '4',
      message: 'expected 3, got 4',
      trace: 'at add (lib/add.js:2:10)\nat Test.run (test/add.test.js:8:3)',
      key: model.errorKey(
        { code: 'ERR_ASSERTION', expected: '3', actual: '4' },
        'at add (lib/add.js:2:10)',
        ROOT,
      ),
    }),
    problem({
      code: 'ERR_ASSERTION',
      operator: 'strictEqual',
      expected: '1',
      actual: '2',
      message: 'expected 1, got 2',
      trace: 'at add (lib/add.js:2:20)\nat Test.run (test/add.test.js:12:3)',
      key: model.errorKey(
        { code: 'ERR_ASSERTION', expected: '1', actual: '2' },
        'at add (lib/add.js:2:10)',
        ROOT,
      ),
    }),
  ];
  const grouped = groupReport({ tool: 'node:test', problems }).problems;
  assert.equal(grouped.length, 2);
});

test('keep separate clusters for different stack roots', () => {
  const problems = [
    problem({
      message: 'boom',
      trace: 'at one (lib/a.js:1:1)',
    }),
    problem({
      message: 'boom',
      trace: 'at two (lib/b.js:1:1)',
    }),
  ];
  const grouped = groupReport({ tool: 'node:test', problems }).problems;
  assert.equal(grouped.length, 2);
});

test('fall back to message when stack is empty', () => {
  const problems = [
    problem({ message: 'same failure' }),
    problem({ message: 'same failure' }),
    problem({ message: 'other failure' }),
  ];
  const grouped = groupReport({ tool: 'node:test', problems }).problems;
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].count, 2);
  assert.equal(grouped[1].count, 1);
});

test('message identity preserves numbers and quoted literals', () => {
  const quote = String.fromCharCode(39);
  const problems = [
    problem({
      message: `Cannot read property ${quote}id${quote} of undefined`,
    }),
    problem({
      message: `Cannot read property ${quote}name${quote} of undefined`,
    }),
    problem({ message: 'expected 3, got 4' }),
    problem({ message: 'expected 10, got 20' }),
  ];
  const grouped = groupReport({ tool: 'node:test', problems }).problems;
  assert.equal(grouped.length, 4);
});

test('full stack fingerprint keeps deeper frames', () => {
  const deep = (leaf) =>
    [
      `at leaf (${leaf}:1:1)`,
      'at mid (lib/mid.js:2:2)',
      'at mid2 (lib/mid.js:3:3)',
      'at mid3 (lib/mid.js:4:4)',
      'at root (lib/root.js:5:5)',
    ].join('\n');
  const problems = [
    problem({ message: 'boom', trace: deep('lib/a.js') }),
    problem({ message: 'boom', trace: deep('lib/b.js') }),
  ];
  const grouped = groupReport({ tool: 'node:test', problems }).problems;
  assert.equal(grouped.length, 2);
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
  assert.equal(traces, 2);
  assert.match(view.md, /- related:\n {2}- /);
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
  assert.match(auditView.md, /severity: high/);
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

const savedLogs = (dir) => {
  const logDir = path.join(dir, '.log');
  if (!fs.existsSync(logDir)) return [];
  return fs.readdirSync(logDir).filter((name) => !name.startsWith('.'));
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
    assert.ok(text.startsWith(NOTICE_HEAD));
    assert.match(text, /passed: 1/);
    assert.ok(!text.includes('hidden'));
    const logs = savedLogs(dir);
    const reduced = logs.find((name) => !name.endsWith('.raw.log'));
    const rawName = logs.find((name) => name.endsWith('.raw.log'));
    assert.equal(logs.length, 2);
    const saved = fs.readFileSync(path.join(dir, '.log', reduced), 'utf8');
    assert.equal(saved, text);
    assert.match(text, /read the raw log `\.log\/.+\.raw\.log`/);
    const raw = fs.readFileSync(path.join(dir, '.log', rawName), 'utf8');
    assert.match(raw, /✔ hidden/);
    assert.match(raw, /ℹ tests 1/);
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
    assert.deepEqual(savedLogs(dir), []);
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

test('raw mode records test counts and passes the output through', async () => {
  const dir = tempDir('reslop-report-');
  const script = [
    'console.log("✔ one (1ms)")',
    'console.log("ℹ tests 1")',
    'console.log("ℹ pass 1")',
    'console.log("ℹ fail 0")',
  ].join(';');
  try {
    const proc = fakeProc(dir, {
      argv: ['node', 'reslop', 't', '--', 'node', '-e', script],
      env: { RESLOP_OUTPUT: 'raw' },
    });
    assert.equal(await run(proc), 0);
    assert.match(proc.stdoutText(), /✔ one/);
    assert.equal(savedLogs(dir).length, 0);
    const [record] = readRuns(dir);
    assert.equal(record.progress.done, 1);
    assert.equal(record.result.tests, 1);
    assert.equal(record.result.passed, 1);
    assert.equal(record.result.failed, 0);
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

test('a captured run leaves a finished run record', async () => {
  const dir = tempDir('reslop-report-');
  const script = [
    'console.log("✔ one (1ms)")',
    'console.log("✔ two (1ms)")',
    'console.log("ℹ tests 2")',
    'console.log("ℹ pass 2")',
    'console.log("ℹ fail 0")',
  ].join(';');
  try {
    const proc = fakeProc(dir, {
      argv: ['node', 'reslop', 't', '--', 'node', '-e', script],
    });
    assert.equal(await run(proc), 0);
    const [record] = readRuns(dir);
    assert.equal(record.status, 'passed');
    assert.equal(record.exit, 0);
    assert.equal(record.progress.done, 2);
    assert.equal(record.result.passed, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failing command leaves a failed run record', async () => {
  const dir = tempDir('reslop-report-');
  try {
    const proc = fakeProc(dir, {
      argv: ['node', 'reslop', 't', '--', 'node', '-e', 'process.exit(3)'],
    });
    assert.equal(await run(proc), 3);
    const [record] = readRuns(dir);
    assert.equal(record.status, 'failed');
    assert.equal(record.exit, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('nested captured commands do not add run records', async () => {
  const dir = tempDir('reslop-report-');
  try {
    const proc = fakeProc(dir, {
      argv: ['node', 'reslop', 't', '--', 'node', '-e', 'process.exit(0)'],
      env: { RESLOP_CAPTURE: '1' },
    });
    assert.equal(await run(proc), 0);
    assert.deepEqual(readRuns(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
