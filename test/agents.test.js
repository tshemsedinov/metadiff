'use strict';

const nodeTest = require('node:test');
const { test } = nodeTest;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const agents = require('../lib/agents.js');
const { detectAgents, findBin, splitArgs, planPrompt } = agents;
const { emptyChoice, buildLaunch, buildLogin, AGENTS, listModels } = agents;
const { mergeModels, parseCursorModels, parseNameList } = agents;
const { parseJsonModels, commandLine, needsAuth } = agents;
const session = require('../lib/session.js');
const { Session } = session;
const git = require('../lib/git.js');
const { createGitRepo } = git;
const helpers = require('./helpers.js');
const { makeRepo, uiSink } = helpers;
const render = require('../lib/render/render.js');
const { renderFrame } = render;
const ansi = require('../lib/ansi.js');
const { stripAnsi } = ansi;
const actions = require('../lib/session/actions.js');
const { actionFromKey } = actions;

const makeBin = (dir, name) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, '#!/bin/sh\n');
  fs.chmodSync(file, 0o755);
  return file;
};

const fakePath = (...names) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reslop-bins-'));
  const bins = {};
  for (const name of names) bins[name] = makeBin(dir, name);
  return { dir, bins, env: { PATH: dir } };
};

test('findBin returns the first executable on PATH', () => {
  const { dir, bins, env } = fakePath('claude');
  try {
    assert.equal(findBin('claude', env), bins.claude);
    assert.equal(findBin('missing', env), '');
    assert.equal(findBin('claude', { PATH: '' }), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectAgents finds claude opencode cursor and codex clis', () => {
  const { dir, bins, env } = fakePath(
    'claude',
    'opencode',
    'cursor-agent',
    'codex',
  );
  try {
    const list = detectAgents(env);
    assert.equal(list.length, AGENTS.length);
    assert.equal(list[0].id, 'claude');
    assert.equal(list[0].bin, bins.claude);
    assert.equal(list[1].id, 'opencode');
    assert.equal(list[1].bin, bins.opencode);
    assert.equal(list[2].id, 'cursor');
    assert.equal(list[2].bin, bins['cursor-agent']);
    assert.equal(list[3].id, 'codex');
    assert.equal(list[3].bin, bins.codex);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectAgents prefers cursor-agent over agent', () => {
  const { dir, bins, env } = fakePath('agent');
  try {
    const list = detectAgents(env);
    const cursor = list.find((row) => row.id === 'cursor');
    assert.equal(cursor.bin, bins.agent);
    const none = detectAgents({ PATH: `${dir}-missing` }).find(
      (row) => row.id === 'claude',
    );
    assert.equal(none.bin, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildLaunch passes the review plan model and extra flags', () => {
  const row = {
    id: 'claude',
    name: 'claude',
    bin: '/usr/bin/claude',
    spec: AGENTS[0],
    models: AGENTS[0].models,
  };
  const missing = buildLaunch({ ...row, bin: '' }, emptyChoice(row), '/r.md');
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'not installed');
  const noPlan = buildLaunch(row, emptyChoice(row), '');
  assert.equal(noPlan.ok, false);
  assert.equal(noPlan.error, 'no plan');
  const choice = { model: 'sonnet', extra: '--foo bar', effort: 'high' };
  const launch = buildLaunch(row, choice, '/tmp/plan.md');
  assert.equal(launch.ok, true);
  assert.equal(launch.cmd, '/usr/bin/claude');
  assert.deepEqual(launch.args.slice(0, 7), [
    '--model',
    'sonnet',
    '--effort',
    'high',
    '--foo',
    'bar',
    planPrompt('/tmp/plan.md'),
  ]);
  const plain = buildLaunch(row, emptyChoice(row), '/tmp/plan.md');
  assert.equal(plain.args[0], planPrompt('/tmp/plan.md'));
  assert.equal(plain.command, 'claude /tmp/plan.md');
  assert.equal(launch.plan, '/tmp/plan.md');
  const shown = 'claude --model sonnet --effort high --foo bar /tmp/plan.md';
  assert.equal(launch.command, shown);
  assert.deepEqual(splitArgs('  --a   b  '), ['--a', 'b']);
  assert.equal(commandLine(launch), shown);
  const rel = buildLaunch(row, choice, '/tmp/work/.review/a.md', '/tmp/work');
  assert.equal(rel.plan, '.review/a.md');
  assert.equal(rel.prompt, planPrompt('.review/a.md'));
  const relCmd = 'claude --model sonnet --effort high --foo bar .review/a.md';
  assert.equal(rel.command, relCmd);
});

const openUi = () => {
  const repo = makeRepo();
  repo.write('a.js', 'ok\n');
  repo.git(['add', '.']);
  repo.git(['commit', '-m', 'init']);
  const stdout = uiSink();
  const ui = new Session({
    cwd: repo.dir,
    stdout,
    repo: createGitRepo(),
    color: false,
    startPane: 'dashboard',
  });
  ui.ensureRepo();
  ui.load();
  return { ui, repo, stdout };
};

test('agents screen lists clis and starts with the review plan', async () => {
  const { dir, bins, env } = fakePath('claude');
  const { ui, repo } = openUi();
  try {
    ui.agents.listModels = async () => [];
    ui.agents.refresh(env);
    await ui.agents.open();
    assert.equal(ui.pane, 'agents');
    assert.equal(actionFromKey('a', 'dashboard'), 'dashAgents');
    const rows = ui.agents.rows();
    assert.equal(rows[0].bin, bins.claude);
    assert.equal(rows[1].bin, '');
    ui.draw();
    const text = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(text, /claude/);
    assert.match(text, /opencode/);
    assert.match(text, /cursor/);
    assert.match(text, /codex/);
    assert.match(text, /not installed/);
    assert.equal(text.includes(bins.claude), false);
    assert.match(text, /claude/);
    assert.match(render.headerText(ui.view()), /agents/);
    ui.handleEvent({ type: 'key', key: 'm' });
    assert.equal(ui.agents.choice('claude').model, 'sonnet');
    ui.draw();
    const after = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(after, /claude\s+sonnet\s+default\s+\.review\//);
    assert.equal(after.includes('--model'), false);
    assert.equal(after.includes('claude --'), false);
    ui.handleEvent({ type: 'key', key: 'f' });
    assert.equal(ui.agents.choice('claude').effort, 'low');
    ui.handleEvent({ type: 'key', key: 'e' });
    assert.equal(ui.composeKind, 'agent');
    ui.pushInput('--max-turns 8');
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(ui.agents.choice('claude').extra, '--max-turns 8');
    const calls = [];
    ui.agents.spawn = (cwd, launch, onData) => {
      calls.push({ cwd, launch });
      onData('hello\n');
      return { kill() {} };
    };
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].launch.cmd, bins.claude);
    assert.equal(calls[0].launch.args[0], '--model');
    assert.equal(calls[0].launch.args[1], 'sonnet');
    assert.ok(calls[0].launch.args.includes('--effort'));
    assert.ok(calls[0].launch.args.includes('low'));
    assert.ok(calls[0].launch.args.includes('--max-turns'));
    const prompt = calls[0].launch.args.at(-1);
    assert.match(prompt, /repair plan/);
    assert.match(prompt, /\.review\//);
    assert.equal(ui.agents.viewing, true);
    assert.equal(ui.agents.jobs.length, 1);
    assert.equal(ui.agents.jobs[0].status, 'running');
    assert.match(
      ui.agents.jobs[0].command,
      /^claude --model sonnet --effort low --max-turns 8 \.review\//,
    );
    const listed = ui.agents.rows().some((row) => row.kind === 'job');
    assert.equal(listed, false);
    assert.match(calls[0].launch.prompt, /\.review\//);
    ui.draw();
    const log = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(log, /hello/);
    assert.match(render.headerText(ui.view()), /agents log/);
    ui.handleEvent({ type: 'key', key: 'escape' });
    assert.equal(ui.agents.viewing, false);
    assert.equal(ui.agents.jobs[0].status, 'running');
    ui.nav.agentCursor = 1;
    ui.agents.start();
    assert.equal(ui.status, 'not installed');
    assert.equal(calls.length, 1);
    ui.nav.agentCursor = 0;
    const view = ui.view();
    const frame = renderFrame(view, { width: 80, height: 24, color: false });
    assert.ok(frame.buttons.some((hit) => hit.id === 'agentModel'));
    assert.ok(frame.buttons.some((hit) => hit.id === 'agentEffort'));
    assert.ok(frame.buttons.some((hit) => hit.id === 'agentStop'));
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agent jobs keep running after leaving the log', async () => {
  const { dir, env } = fakePath('claude', 'cursor-agent');
  const { ui, repo } = openUi();
  try {
    ui.agents.listModels = async () => [];
    ui.agents.refresh(env);
    await ui.agents.open();
    const killed = [];
    ui.agents.spawn = (cwd, launch, onData, onClose) => ({
      kill() {
        killed.push(launch.cmd);
        onClose({ status: 1, text: 'bye\n' });
      },
    });
    const clis = ui.agents.rows().length;
    ui.agents.start();
    ui.agents.start();
    assert.equal(ui.agents.jobs.length, 1);
    assert.equal(ui.agents.viewing, true);
    assert.equal(ui.agents.rows().length, clis);
    ui.handleEvent({ type: 'key', key: 'escape' });
    assert.equal(ui.agents.jobs[0].status, 'running');
    ui.agents.start();
    assert.equal(ui.agents.jobs.length, 1);
    assert.equal(ui.agents.viewing, true);
    ui.handleEvent({ type: 'key', key: 'escape' });
    ui.nav.agentCursor = 2;
    ui.agents.start();
    assert.equal(ui.agents.jobs.length, 2);
    assert.equal(ui.agents.rows().length, clis);
    assert.equal(ui.agents.runningCount(), 2);
    ui.handleEvent({ type: 'key', key: 'escape' });
    ui.handleEvent({ type: 'key', key: 's' });
    assert.equal(killed.length, 1);
    assert.equal(ui.agents.runningCount(), 1);
    const live = ui.agents.jobs.filter((job) => job.status === 'running');
    assert.equal(live.length, 1);
    assert.equal(live[0].name, 'claude');
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cursor fallback includes grok-4.6', () => {
  const cursor = AGENTS.find((row) => row.id === 'cursor');
  assert.ok(cursor.models.includes('grok-4.6'));
  const row = {
    id: cursor.id,
    name: cursor.name,
    bin: '/usr/bin/cursor-agent',
    spec: cursor,
    models: cursor.models,
  };
  const launch = buildLaunch(row, { model: 'auto', extra: '' }, '/tmp/plan.md');
  assert.equal(launch.args[0], '--print');
  assert.equal(launch.args[1], '--trust');
  const shown = 'cursor-agent --print --trust --model auto /tmp/plan.md';
  assert.equal(launch.command, shown);
  const hard = buildLaunch(
    row,
    { model: 'auto', extra: '', effort: 'xhigh' },
    '/tmp/plan.md',
  );
  const hardCmd =
    'cursor-agent --print --trust --model auto --effort xhigh /tmp/plan.md';
  assert.equal(hard.command, hardCmd);
  const codex = AGENTS.find((item) => item.id === 'codex');
  const codexRow = {
    id: codex.id,
    name: codex.name,
    bin: '/usr/bin/codex',
    spec: codex,
    models: codex.models,
  };
  const reasoned = buildLaunch(
    codexRow,
    { model: 'default', extra: '', effort: 'high' },
    '/tmp/plan.md',
  );
  assert.equal(
    reasoned.command,
    'codex -c model_reasoning_effort=high /tmp/plan.md',
  );
  const login = buildLogin(row);
  assert.deepEqual(login.args, ['login']);
  assert.equal(login.kind, 'login');
  assert.equal(login.command, 'cursor-agent login');
  assert.equal(buildLogin({ ...row, spec: AGENTS[0] }).error, 'no login');
  assert.equal(needsAuth('Error: Authentication required. Please run'), true);
});

test('parseCursorModels reads id dash name rows', () => {
  const text = [
    'Loading models...',
    'Available models',
    'auto - Auto',
    'grok-4.6 - Grok 4.6',
    'composer-2 - Composer 2',
    'Tip: use --model',
  ].join('\n');
  assert.deepEqual(parseCursorModels(text), ['auto', 'grok-4.6', 'composer-2']);
  const missing = 'No models available for this account.';
  assert.deepEqual(parseCursorModels(missing), []);
  assert.deepEqual(parseCursorModels('Available models: auto, grok-4.6'), [
    'auto',
    'grok-4.6',
  ]);
});

test('parseNameList and parseJsonModels keep model ids', () => {
  const listed = parseNameList('anthropic/claude-sonnet-4\nopenai/gpt-5\n');
  assert.deepEqual(listed, ['anthropic/claude-sonnet-4', 'openai/gpt-5']);
  assert.deepEqual(parseNameList('Usage: claude [options]\n'), []);
  const json = parseJsonModels('{"models":[{"id":"o3"},{"slug":"gpt-5"}]}');
  assert.deepEqual(json, ['o3', 'gpt-5']);
  const merged = mergeModels(['default', 'sonnet'], ['grok-4.6', 'sonnet']);
  assert.deepEqual(merged, ['default', 'grok-4.6', 'sonnet']);
});

test('listModels tries the next command after an empty list', async () => {
  const spec = AGENTS.find((row) => row.id === 'cursor');
  const calls = [];
  const run = async (bin, args) => {
    calls.push([bin, ...args]);
    if (args[0] === '--list-models') {
      return {
        status: 1,
        stdout: 'No models available for this account.\n',
        stderr: '',
      };
    }
    return {
      status: 0,
      stdout: 'Loading models...\nauto - Auto\ngrok-4.6 - Grok 4.6\n',
      stderr: '',
    };
  };
  const names = await listModels('agent', spec, { run });
  assert.deepEqual(names, ['auto', 'grok-4.6']);
  assert.deepEqual(calls, [
    ['agent', '--list-models'],
    ['agent', 'models'],
  ]);
});

test('agents screen cycles models from the cli catalog', async () => {
  const { dir, env } = fakePath('cursor-agent');
  const { ui, repo } = openUi();
  try {
    ui.agents.listModels = async (bin, spec) => {
      if (spec.id === 'cursor') return ['auto', 'grok-4.6'];
      return [];
    };
    ui.agents.refresh(env);
    await ui.agents.open();
    ui.nav.agentCursor = 2;
    const row = ui.agents.selected();
    assert.equal(row.id, 'cursor');
    assert.equal(row.name, 'cursor');
    assert.ok(row.models.includes('grok-4.6'));
    let guard = 0;
    while (ui.agents.choice('cursor').model !== 'grok-4.6') {
      ui.handleEvent({ type: 'key', key: 'm' });
      guard += 1;
      assert.ok(guard < 20);
    }
    assert.equal(ui.agents.choice('cursor').model, 'grok-4.6');
    assert.equal(ui.agents.selected().name, 'cursor');
    ui.draw();
    const text = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(text, /cursor\s+grok-4\.6\s+default\s+\.review\//);
    assert.equal(text.includes('cursor-agent'), false);
    assert.equal(text.includes('--print'), false);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('start falls back to the latest review file', async () => {
  const { dir, env } = fakePath('claude');
  const { ui, repo } = openUi();
  try {
    const reviewDir = path.join(repo.dir, '.review');
    fs.mkdirSync(reviewDir, { recursive: true });
    const name = '2020-01-01-00.md';
    fs.writeFileSync(path.join(reviewDir, name), '---\nstatus: ready\n---\n');
    ui.review.store.reviewPath = '';
    ui.agents.listModels = async () => [];
    ui.agents.refresh(env);
    await ui.agents.open();
    const calls = [];
    ui.agents.spawn = (cwd, launch) => {
      calls.push(launch);
      return { kill() {} };
    };
    ui.agents.start();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].plan, `.review/${name}`);
    assert.match(calls[0].prompt, /\.review\/2020-01-01-00\.md/);
    assert.match(calls[0].command, /\.review\/2020-01-01-00\.md$/);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agents screen runs cursor login when auth is required', async () => {
  const { dir, bins, env } = fakePath('cursor-agent');
  const { ui, repo } = openUi();
  try {
    ui.agents.listModels = async () => [];
    ui.agents.refresh(env);
    await ui.agents.open();
    ui.nav.agentCursor = 2;
    const ready = renderFrame(ui.view(), {
      width: 80,
      height: 24,
      color: false,
    });
    assert.ok(ready.buttons.some((hit) => hit.id === 'agentLogin'));
    const calls = [];
    ui.agents.spawn = (cwd, launch, onData, onClose) => {
      calls.push(launch);
      if (launch.kind === 'login') {
        onData('open a browser to finish login\n');
        return { kill() {} };
      }
      const text = 'Error: Authentication required. Please run agent login\n';
      onData(text);
      onClose({ status: 1, text });
      return { kill() {} };
    };
    ui.handleEvent({ type: 'key', key: 'l' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, bins['cursor-agent']);
    assert.deepEqual(calls[0].args, ['login']);
    assert.equal(calls[0].command, 'cursor-agent login');
    assert.equal(ui.agents.viewing, false);
    assert.equal(ui.status, 'logging in');
    assert.equal(ui.agents.jobs[0].status, 'running');
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(ui.agents.viewing, true);
    ui.handleEvent({ type: 'key', key: 'escape' });
    assert.equal(ui.agents.viewing, false);
    assert.equal(ui.agents.jobs[0].status, 'running');
    assert.equal(ui.status, 'logging in');
    ui.handleEvent({ type: 'key', key: 's' });
    ui.nav.agentCursor = 0;
    ui.handleEvent({ type: 'key', key: 'l' });
    assert.equal(ui.status, 'no login');
    assert.equal(calls.length, 1);
    ui.nav.agentCursor = 2;
    ui.agents.start();
    assert.equal(calls.length, 3);
    assert.equal(calls[2].kind, 'login');
    assert.equal(ui.agents.viewing, false);
    assert.equal(ui.status, 'logging in');
    assert.equal(ui.agents.jobs.at(-1).action, 'login');
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
