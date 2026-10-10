'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const term = require('../lib/term/screen.js');
const { createScreen, screenWrite, styledText, pendingKind } = term;
const { pendingHint, answerBytes, requestTitle } = term;
const { permissionTokens, rememberedTokens } = term;
const allow = require('../lib/agents/allow.js');
const { PLAN_ALLOWS, ensureAllows, cursorConfigPath } = allow;
const { startAgent } = require('../lib/agents/agents.js');
const { Session } = require('../lib/session/session.js');
const { createGitRepo } = require('../lib/git/git.js');
const { makeRepo, uiSink, removeTree } = require('./helpers.js');
const { stripAnsi } = require('../lib/term/ansi.js');

test('terminal screen shows an approval request', () => {
  const screen = createScreen(48, 8);
  const frame =
    '\x1b[2J\x1b[HWrite to this file?\r\n' +
    'in .plan/2026-10-08-00.md\r\n' +
    'Add Write(.plan/2026-10-08-00.md) to allowlist?\r\n' +
    'Waiting for decision (y/n/p)...';
  const text = screenWrite(screen, frame);
  assert.match(text, /Write to this file\?/);
  assert.match(text, /\.plan\/2026-10-08-00\.md/);
  assert.equal(pendingKind(text), 'decision');
  assert.equal(pendingHint('decision'), 'y once   a always   n reject');
  assert.equal(answerBytes('y', 'decision'), 'y');
  assert.equal(answerBytes('a', 'decision'), '\t');
  assert.equal(answerBytes('n', 'decision'), 'n');
  assert.equal(answerBytes('s', 'decision'), null);
  const tokens = permissionTokens(text);
  assert.deepEqual(tokens, ['Write(.plan/2026-10-08-00.md)']);
  const remembered = rememberedTokens(tokens);
  assert.ok(remembered.includes('Write(.plan/**/*.md)'));
  assert.equal(requestTitle(text), 'Write to this file');
  const reply =
    'Tell the agent what to do instead (Enter to send, empty to skip)';
  assert.equal(pendingKind(reply), 'text');
  assert.equal(answerBytes('s', 'text'), 's');
  assert.equal(answerBytes('escape', 'text'), '\x1b');
  const idle = '→ Add a follow-up\nGrok 4.7 256K High · 8 files edited';
  const busy = `${idle}\nctrl+c to stop`;
  assert.equal(pendingKind(idle), 'idle');
  assert.equal(pendingKind(busy), '');
  assert.equal(pendingHint('idle'), '');
  assert.equal(pendingKind(`Run this command?\n${idle}`), 'decision');
});

test('styled terminal text keeps color and scrolled lines', () => {
  const screen = createScreen(8, 2);
  screenWrite(screen, '\x1b[31mred\x1b[0m\r\nmore\r\nthird');
  const styled = styledText(screen);
  assert.ok(styled.includes('\x1b[31mred'));
  assert.match(styled, /more/);
  assert.match(styled, /third/);
  const plain = screenWrite(screen, '');
  assert.equal(plain.includes('\x1b'), false);
});

test('plan edits and test commands are remembered in the cursor config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reslop-allow-'));
  const file = path.join(dir, 'cli-config.json');
  fs.writeFileSync(
    file,
    `${JSON.stringify({ permissions: { allow: ['Shell(ls)'], deny: [] } })}\n`,
  );
  assert.equal(ensureAllows(file, PLAN_ALLOWS), true);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(saved.permissions.allow.includes('Shell(ls)'));
  assert.ok(saved.permissions.allow.includes('Write(.plan/**/*.md)'));
  assert.ok(saved.permissions.allow.includes('Shell(npm)'));
  assert.ok(saved.permissions.allow.includes('Shell(reslop t)'));
  assert.equal(ensureAllows(file, PLAN_ALLOWS), true);
  const again = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(again.permissions.allow.length, saved.permissions.allow.length);
  const env = { ...process.env, RESLOP_CURSOR_CONFIG: file };
  assert.equal(cursorConfigPath(env), file);
  fs.rmSync(dir, { recursive: true, force: true });
});

const openUi = () => {
  const repo = makeRepo();
  repo.write('a.js', 'ok\n');
  repo.git(['add', '.']);
  repo.git(['commit', '-m', 'init']);
  const ui = new Session({
    cwd: repo.dir,
    stdout: uiSink(),
    repo: createGitRepo(),
    color: false,
    startPane: 'dashboard',
  });
  ui.ensureRepo();
  ui.load();
  ui.agents.authProbe = () => true;
  return { ui, repo };
};

const binDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reslop-bins-'));
  const file = path.join(dir, 'cursor-agent');
  fs.writeFileSync(file, '#!/bin/sh\n');
  fs.chmodSync(file, 0o755);
  return dir;
};

test('the agent log answers an approval and remembers it', async () => {
  const dir = binDir();
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reslop-cfg-'));
  const config = path.join(configDir, 'cli-config.json');
  const previous = process.env.RESLOP_CURSOR_CONFIG;
  process.env.RESLOP_CURSOR_CONFIG = config;
  const { ui, repo } = openUi();
  const writes = [];
  try {
    ui.agents.listModels = async () => [];
    ui.agents.refresh({ PATH: dir });
    await ui.agents.open();
    ui.nav.agentCursor = 2;
    ui.agents.spawn = (cwd, launch, onData) => {
      assert.equal(launch.pty, true);
      assert.equal(launch.args.includes('--print'), false);
      onData(
        [
          'Run this command?',
          'npm test',
          'Add Shell(npm) to allowlist?',
          'Waiting for decision (y/n/p)...',
        ].join('\n'),
      );
      return {
        kill() {},
        write(data) {
          writes.push(data);
        },
        resize() {},
      };
    };
    ui.agents.start();
    assert.equal(ui.agents.viewing, true);
    assert.equal(ui.agents.jobs[0].pending, 'decision');
    ui.draw();
    const text = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(text, /Run this command\?/);
    assert.match(text, /y once {3}a always {3}n reject/);
    ui.handleEvent({ type: 'key', key: 'y' });
    assert.deepEqual(writes, ['y']);
    ui.handleEvent({ type: 'key', key: 'a' });
    assert.deepEqual(writes, ['y', '\t']);
    const saved = JSON.parse(fs.readFileSync(config, 'utf8'));
    assert.ok(saved.permissions.allow.includes('Shell(npm)'));
    ui.handleEvent({ type: 'key', key: 'escape' });
    assert.equal(ui.agents.viewing, false);
  } finally {
    if (previous === undefined) delete process.env.RESLOP_CURSOR_CONFIG;
    else process.env.RESLOP_CURSOR_CONFIG = previous;
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('a finished cursor agent is closed', async () => {
  const dir = binDir();
  const { ui, repo } = openUi();
  const writes = [];
  let push = null;
  try {
    ui.agents.listModels = async () => [];
    ui.agents.refresh({ PATH: dir });
    await ui.agents.open();
    ui.nav.agentCursor = 2;
    ui.agents.spawn = (cwd, launch, onData) => {
      push = onData;
      onData('→ Add a follow-up\n');
      return {
        kill() {},
        write(data) {
          writes.push(data);
        },
        resize() {},
      };
    };
    ui.agents.start();
    assert.deepEqual(writes, []);
    push('working\nctrl+c to stop\n');
    assert.deepEqual(writes, []);
    push('done\n→ Add a follow-up\n');
    assert.deepEqual(writes, ['\x04']);
    push('done\n→ Add a follow-up\n');
    assert.deepEqual(writes, ['\x04']);
    assert.equal(ui.agents.jobs[0].pending, 'idle');
    const again = [];
    ui.agents.spawn = (cwd, launch, onData) => {
      onData('0 files edited\n→ Add a follow-up\n');
      return {
        kill() {},
        write(data) {
          again.push(data);
        },
      };
    };
    const finished = ui.agents.jobs[0];
    finished.status = 'exit 0';
    finished.child = null;
    ui.agents.closeView();
    ui.agents.start();
    assert.deepEqual(again, []);
    const idle = ui.agents.jobs.find((job) => job.status === 'running');
    idle.output = '';
    const summary = 'Grok 4.7 256K High · 52.8% · 17 files edited';
    ui.agents.showOutput(idle, `${summary}\n→ Add a follow-up\n`);
    assert.deepEqual(again, ['\x04']);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'cursor agent approvals stay on a tty',
  {
    skip:
      process.platform === 'win32' ? 'windows agent runner has no pty' : false,
  },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reslop-pty-'));
    const script = path.join(__dirname, 'fixtures', 'tty-agent.js');
    const config = path.join(dir, 'cli-config.json');
    const previous = process.env.RESLOP_CURSOR_CONFIG;
    process.env.RESLOP_CURSOR_CONFIG = config;
    let handle = null;
    try {
      const seen = [];
      handle = startAgent(
        dir,
        { cmd: process.execPath, args: [script], pty: true },
        (text) => seen.push(text),
        () => {},
      );
      assert.equal(typeof handle.write, 'function');
      const ready = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no tty')), 4000);
        const timerId = setInterval(() => {
          if (!seen.some((text) => text.includes('tty=true/true'))) return;
          clearInterval(timerId);
          clearTimeout(timer);
          resolve();
        }, 30);
      });
      void ready;
      handle.write('y');
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no key')), 4000);
        const timerId = setInterval(() => {
          if (!seen.some((text) => text.includes('key="y"'))) return;
          clearInterval(timerId);
          clearTimeout(timer);
          resolve();
        }, 30);
      });
      const saved = JSON.parse(fs.readFileSync(config, 'utf8'));
      assert.ok(saved.permissions.allow.includes('Write(.plan/**/*.md)'));
      assert.ok(saved.permissions.allow.includes('Shell(npm)'));
    } finally {
      if (handle) handle.kill();
      if (previous === undefined) delete process.env.RESLOP_CURSOR_CONFIG;
      else process.env.RESLOP_CURSOR_CONFIG = previous;
      await removeTree(dir);
    }
  },
);
