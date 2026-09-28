'use strict';

const nodeTest = require('node:test');
const { test } = nodeTest;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const npm = require('../lib/npm-commands.js');
const ansi = require('../lib/ansi.js');
const { stripAnsi } = ansi;
const helpers = require('./helpers.js');
const { tempDir } = helpers;

const { listCommands, reduceOutput, logFileName, writeLog } = npm;
const { staleLogFiles, removeStaleLogs, formatSize } = npm;
const { parseScriptLine, saveScript, removeScript, reorderScript } = npm;
const { commandEnv, startNpm } = npm;

const writeJson = (file, body) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
};

const sampleRoot = () => {
  const root = tempDir('reslop-npm-');
  writeJson(path.join(root, 'package.json'), {
    scripts: { test: 'node --test', lint: 'eslint .' },
    dependencies: { leftpad: '1.0.0' },
    devDependencies: { metaskills: '1.0.0' },
    peerDependencies: { react: '18.0.0' },
  });
  writeJson(path.join(root, 'node_modules', 'leftpad', 'package.json'), {
    name: 'leftpad',
    bin: { leftpad: 'bin.js' },
  });
  writeJson(path.join(root, 'node_modules', 'metaskills', 'package.json'), {
    name: 'metaskills',
    bin: 'cli.js',
  });
  writeJson(path.join(root, 'node_modules', 'react', 'package.json'), {
    name: 'react',
    bin: { react: 'bin.js' },
  });
  return root;
};

test('listCommands shows scripts and installed bins', () => {
  const root = sampleRoot();
  const names = listCommands(root).map((entry) => entry.name);
  assert.deepEqual(names, ['test', 'lint', 'leftpad', 'metaskills']);
});

test('listCommands skips a bin that matches a script', () => {
  const root = sampleRoot();
  const manifest = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  pkg.scripts.leftpad = 'echo skip';
  writeJson(manifest, pkg);
  const names = listCommands(root).map((entry) => entry.name);
  assert.deepEqual(names, ['test', 'lint', 'leftpad', 'metaskills']);
  const left = listCommands(root).find((entry) => entry.name === 'leftpad');
  assert.equal(left.kind, 'script');
});

test('reduceOutput drops passes and relativizes the repo', () => {
  const root = '/repo/demo';
  const raw = [
    '✔ passes',
    'ok 1 passing',
    'PASS src/ok.test.js',
    '# pass 2',
    'ℹ pass 2',
    'ℹ tests 3',
    `${root}/lib/app.js:4`,
    '✖ fails',
    'Error: boom',
    'not ok 2',
  ].join('\n');
  const text = reduceOutput(raw, root, 1);
  assert.ok(!text.includes('✔'));
  assert.ok(!text.includes('PASS'));
  assert.match(text, /# pass 2/);
  assert.match(text, /ℹ pass 2/);
  assert.match(text, /ℹ tests 3/);
  assert.ok(!text.includes(root));
  assert.match(text, /lib\/app\.js:4/);
  assert.match(text, /✖ fails/);
  assert.match(text, /Error: boom/);
  assert.match(text, /not ok 2/);
  assert.match(text, /exit 1\n$/);
});

test('reduceOutput keeps the test statistics', () => {
  const raw = [
    '✔ hidden',
    'ℹ tests 621',
    'ℹ suites 0',
    'ℹ pass 621',
    'ℹ fail 0',
    'ℹ cancelled 0',
    'ℹ skipped 0',
    'ℹ todo 0',
    'ℹ duration_ms 6069.237689',
  ].join('\n');
  const text = reduceOutput(raw, '/repo', 0);
  assert.ok(!text.includes('✔'));
  const stats = raw.split('\n').slice(1);
  for (const line of stats) assert.ok(text.includes(line));
});

test('reduceOutput relativizes a Windows repo path', () => {
  const root = 'D:\\repo\\demo';
  const raw = [`${root}\\lib\\app.js:4`, 'D:/repo/demo/lib/app.js:5'].join(
    '\n',
  );
  const text = reduceOutput(raw, root, 1);
  assert.ok(!text.includes(root));
  assert.ok(!text.includes('D:/repo/demo'));
  assert.match(text, /lib\\app\.js:4/);
  assert.match(text, /lib\/app\.js:5/);
});

test('reduceOutput keeps the command colors', () => {
  const root = '/repo/demo';
  const red = '\x1b[31m';
  const green = '\x1b[32m';
  const reset = '\x1b[0m';
  const raw = [
    `${green}✔ passes${reset}`,
    `${red}${root}/lib/app.js:4 boom${reset}`,
    `${red}Error: boom${reset}`,
  ].join('\n');
  const text = reduceOutput(raw, root, 1);
  assert.ok(!text.includes('✔'));
  assert.ok(text.includes(`${red}lib/app.js:4 boom${reset}`));
  assert.ok(text.includes(`${red}Error: boom${reset}`));
  assert.match(text, /exit 1\n$/);
});

test('reduceOutput drops node internal stack frames', () => {
  const root = '/repo/demo';
  const raw = [
    'Error: boom',
    `    at app (${root}/lib/app.js:4:1)`,
    '    at Test.runInAsyncScope (node:async_hooks:227:14)',
    '    at Module._compile (node:internal/modules/cjs/loader:1705:14)',
    '    at TracingChannel.traceSync (node:diagnostics_channel:328:14)',
  ].join('\n');
  const text = reduceOutput(raw, root, 1);
  assert.match(text, /Error: boom/);
  assert.match(text, /^ {2}at app /m);
  assert.ok(!text.includes('    at '));
  assert.ok(!text.includes('(node:'));
  assert.ok(!text.includes('async_hooks'));
  assert.ok(!text.includes('diagnostics_channel'));
});

test('reduceOutput prints assertion details as a table', () => {
  const mark = String.fromCharCode(39);
  const field = (name, value, comma = '') =>
    `  ${name}: ${mark}${value}${mark}${comma}`;
  const raw = [
    'AssertionError: nope',
    '    at Test.runInAsyncScope (node:async_hooks:227:14) {',
    field('code', 'ERR_ASSERTION', ','),
    field('actual', 'local+', ','),
    field('expected', 'local'),
    '}',
  ].join('\n');
  const text = reduceOutput(raw, '/repo', 1);
  const plain = stripAnsi(text);
  assert.ok(!plain.includes('(node:'));
  assert.ok(!plain.includes('{'));
  const rows = plain.split('\n');
  const codeAt = rows.findIndex((line) => line.includes('ERR_ASSERTION'));
  assert.equal(rows[codeAt - 1], '');
  const code = plain.split('\n').find((line) => line.includes('ERR_ASSERTION'));
  const actual = plain.split('\n').find((line) => line.includes('local+'));
  const expected = plain
    .split('\n')
    .find((line) => line.trimEnd().endsWith('local'));
  const keyEnd = (line, key) => line.indexOf(key) + key.length;
  assert.equal(keyEnd(code, 'code'), keyEnd(actual, 'actual'));
  assert.equal(keyEnd(actual, 'actual'), keyEnd(expected, 'expected'));
  assert.ok(code.slice(keyEnd(code, 'code')).startsWith('    ERR_ASSERTION'));
  assert.ok(actual.slice(keyEnd(actual, 'actual')).startsWith('    local+'));
  const tail = expected.slice(keyEnd(expected, 'expected'));
  assert.ok(tail.startsWith('    local'));
});

test('commandEnv asks the program to print color', () => {
  const env = commandEnv({ PATH: '/bin' });
  assert.equal(env.FORCE_COLOR, '1');
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.RESLOP_OUTPUT, 'raw');
  assert.equal(commandEnv({ FORCE_COLOR: '0' }).FORCE_COLOR, '0');
  assert.equal(commandEnv({ NO_COLOR: '1' }).FORCE_COLOR, undefined);
  const kept = commandEnv({ RESLOP_OUTPUT: 'md' });
  assert.equal(kept.RESLOP_OUTPUT, 'raw');
});

test('reduceOutput omits the exit line while the process is running', () => {
  const text = reduceOutput('✔ hidden\nError: boom\n', '/repo', '');
  assert.equal(text, 'Error: boom\n');
});

test('log names are dated and numbered', () => {
  const now = new Date(2026, 8, 22);
  const expected = '2026-09-22-test-unit-01.log';
  assert.equal(logFileName('test:unit', '2026-09-22', 1), expected);
  const root = tempDir('reslop-npm-log-');
  const first = writeLog(root, 'test', 'exit 0\n', now);
  const second = writeLog(root, 'test', 'exit 1\n', now);
  assert.equal(first, '2026-09-22-test-01.log');
  assert.equal(second, '2026-09-22-test-02.log');
  const saved = path.join(root, '.log', first);
  assert.equal(fs.readFileSync(saved, 'utf8'), 'exit 0\n');
  assert.ok(!fs.existsSync(path.join(root, first)));
  const colored = '\x1b[31mError\x1b[0m\n';
  const name = writeLog(root, 'color', colored, now);
  const plain = fs.readFileSync(path.join(root, '.log', name), 'utf8');
  assert.equal(plain, 'Error\n');
  const padded = 'hello  \n  at app \n';
  const trimmed = writeLog(root, 'trim', padded, now);
  const savedTrim = path.join(root, '.log', trimmed);
  assert.equal(fs.readFileSync(savedTrim, 'utf8'), 'hello\n  at app\n');
});

test('parseScriptLine splits on the first colon', () => {
  assert.deepEqual(parseScriptLine('test: node --test'), {
    name: 'test',
    command: 'node --test',
  });
  assert.equal(parseScriptLine('nope'), null);
  assert.equal(parseScriptLine(': echo'), null);
});

test('save remove and reorder scripts', () => {
  const root = sampleRoot();
  saveScript(root, 'lint', { name: 'check', command: 'eslint lib' });
  assert.equal(reorderScript(root, 'check', -1), true);
  const file = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(pkg.scripts), ['check', 'test']);
  assert.equal(pkg.scripts.check, 'eslint lib');
  assert.equal(removeScript(root, 'check'), true);
  const next = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(next.scripts), ['test']);
});

test('stale logs are files dated more than 5 days ago', () => {
  const root = tempDir('reslop-npm-');
  const dir = path.join(root, '.log');
  fs.mkdirSync(dir);
  const now = new Date(2026, 8, 28);
  fs.writeFileSync(path.join(dir, '2026-09-22-test-01.log'), 'abcdef');
  fs.writeFileSync(path.join(dir, '2026-09-23-lint-01.log'), 'keep');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'nope');
  const found = staleLogFiles(root, now);
  assert.equal(found.bytes, 6);
  assert.equal(found.files.length, 1);
  assert.equal(formatSize(0), '0b');
  assert.equal(formatSize(6), '6b');
  assert.equal(formatSize(1536), '1.5k');
  assert.equal(formatSize(12 * 1024), '12k');
  assert.equal(formatSize(1.5 * 1024 * 1024), '1.5m');
  assert.equal(staleLogFiles(tempDir('reslop-npm-'), now).bytes, 0);
  removeStaleLogs(root, now);
  assert.equal(fs.existsSync(path.join(dir, '2026-09-22-test-01.log')), false);
  assert.equal(fs.existsSync(path.join(dir, '2026-09-23-lint-01.log')), true);
  assert.equal(staleLogFiles(root, now).bytes, 0);
});

test('startNpm drops output after the command is stopped', async () => {
  const root = tempDir();
  writeJson(path.join(root, 'package.json'), {
    scripts: { hang: 'node hang.js' },
  });
  fs.writeFileSync(
    path.join(root, 'hang.js'),
    'setInterval(() => console.log("tick"), 40);\n',
  );
  let handle = null;
  try {
    const outcome = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out')), 8000);
      let frozen = '';
      let stopped = false;
      let grew = false;
      handle = startNpm(
        root,
        { kind: 'script', name: 'hang' },
        (text) => {
          if (stopped) {
            if (text !== frozen) grew = true;
            return;
          }
          if (!text.includes('tick')) return;
          frozen = text;
          stopped = true;
          handle.kill();
        },
        (result) => {
          clearTimeout(timer);
          resolve({ result, frozen, grew });
        },
      );
    });
    assert.equal(outcome.grew, false);
    assert.equal(outcome.result.text, outcome.frozen);
  } finally {
    if (handle) handle.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
