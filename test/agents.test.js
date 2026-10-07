'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const agents = require('../lib/agents.js');
const { detectAgents, findBin, splitArgs, planPrompt } = agents;
const { emptyChoice, buildLaunch, buildLogin, AGENTS, listModels } = agents;
const { mergeModels, parseCursorModels, parseNameList } = agents;
const { parseJsonModels, commandLine, needsAuth } = agents;
const { groupModels, resolveModel } = agents;
const { Session } = require('../lib/session.js');
const { createGitRepo } = require('../lib/git.js');
const { makeRepo, uiSink } = require('./helpers.js');
const render = require('../lib/render/render.js');
const { renderFrame } = render;
const { stripAnsi, THEME, bg, RESET } = require('../lib/ansi.js');
const { actionFromKey } = require('../lib/session/actions.js');

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
    assert.equal(ui.agents.pick.field, 'model');
    assert.match(render.headerText(ui.view()), /agents$/);
    ui.draw();
    const menu = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(menu, /claude/);
    assert.match(menu, /opencode/);
    assert.match(menu, /sonnet/);
    assert.equal(ui.agents.menuItems().includes('default'), false);
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(ui.agents.pick, null);
    assert.equal(ui.agents.choice('claude').model, 'sonnet');
    ui.draw();
    const after = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(after, /\d{4}-\d{2}-\d{2}-\d+\.md {2}editing {2}\d+\/\d+/);
    assert.equal(after.includes('default'), false);
    assert.equal(after.includes('--model'), false);
    assert.equal(after.includes('claude --'), false);
    ui.handleEvent({ type: 'key', key: 'f' });
    assert.equal(ui.agents.pick.field, 'effort');
    assert.equal(ui.agents.menuItems().includes('default'), false);
    ui.handleEvent({ type: 'key', key: 'enter' });
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

test('agents screen picks a model from the list', async () => {
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
    ui.handleEvent({ type: 'key', key: 'm' });
    ui.handleEvent({ type: 'key', key: 'g' });
    ui.handleEvent({ type: 'key', key: 'r' });
    ui.handleEvent({ type: 'key', key: 'o' });
    ui.handleEvent({ type: 'key', key: 'k' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(ui.agents.choice('cursor').model, 'grok-4.6');
    assert.equal(ui.agents.selected().name, 'cursor');
    ui.draw();
    const text = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(text, /cursor\s+grok-4\.6\s+\d{4}-\d{2}-\d{2}-\d+\.md/);
    assert.equal(text.includes('default'), false);
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

test('agents screen runs the review file chosen in the combo', async () => {
  const { dir, env } = fakePath('claude');
  const { ui, repo } = openUi();
  try {
    const reviewDir = path.join(repo.dir, '.review');
    fs.mkdirSync(reviewDir, { recursive: true });
    const older = '2020-01-01-00.md';
    const newer = '2020-01-02-00.md';
    const olderBody = [
      '---',
      'status: ready',
      '---',
      '',
      '> a.js',
      '',
      '- [x] rewrite loop',
      '- [ ] still open',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(reviewDir, older), olderBody);
    const newerBody = '---\nstatus: partial\n---\n';
    fs.writeFileSync(path.join(reviewDir, newer), newerBody);
    ui.review.store.reviewPath = '';
    ui.agents.listModels = async () => [];
    ui.agents.refresh(env);
    await ui.agents.open();
    ui.handleEvent({ type: 'key', key: 'r' });
    assert.equal(ui.agents.pick.field, 'plan');
    assert.deepEqual(ui.agents.menuItems(), [
      `.review/${newer}`,
      `.review/${older}`,
    ]);
    ui.handleEvent({ type: 'key', key: 'down' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(ui.agents.pick, null);
    ui.draw();
    const text = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(text, new RegExp(`${older}  ready  1/2`));
    const calls = [];
    ui.agents.spawn = (cwd, launch) => {
      calls.push(launch);
      return { kill() {} };
    };
    ui.agents.start();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].plan, `.review/${older}`);
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

test('effort encoded in a model id is chosen separately', () => {
  const ids = [
    'auto',
    'composer-2.5',
    'composer-2.5-fast',
    'gpt-5.6-sol-high',
    'gpt-5.6-sol-low',
    'gpt-5.6-sol-low-fast',
    'gpt-5.6-sol-medium',
    'gpt-5.3-codex',
    'gpt-5.3-codex-fast',
    'gpt-5.3-codex-high',
    'gpt-5.3-codex-high-fast',
    'claude-opus-5-thinking-high',
    'claude-opus-5-thinking-xhigh',
    'claude-4.6-sonnet-medium-thinking',
    'gpt-5.5-extra-high',
    'gpt-5.5-extra-high-fast',
  ];
  const models = groupModels(ids);
  const names = models.map((item) => item.model);
  assert.ok(names.includes('gpt-5.6-sol'));
  assert.ok(names.includes('gpt-5.6-sol-fast'));
  assert.equal(names.includes('gpt-5.6-sol-high'), false);
  assert.equal(names.includes('gpt-5.6-sol-low'), false);
  const sol = models.find((item) => item.model === 'gpt-5.6-sol');
  assert.deepEqual(sol.levels, ['low', 'medium', 'high']);
  assert.equal(sol.ids.get('low'), 'gpt-5.6-sol-low');
  const codex = models.find((item) => item.model === 'gpt-5.3-codex');
  assert.ok(codex.levels.includes('default'));
  assert.equal(codex.ids.get('default'), 'gpt-5.3-codex');
  assert.equal(codex.ids.get('high'), 'gpt-5.3-codex-high');
  const codexFast = models.find((item) => item.model === 'gpt-5.3-codex-fast');
  assert.equal(codexFast.ids.get('default'), 'gpt-5.3-codex-fast');
  assert.equal(codexFast.ids.get('high'), 'gpt-5.3-codex-high-fast');
  const fastName = names.filter((name) => name === 'gpt-5.3-codex-fast');
  assert.equal(fastName.length, 1);
  const thinking = models.find(
    (item) => item.model === 'claude-opus-5-thinking',
  );
  assert.deepEqual(thinking.levels, ['high', 'xhigh']);
  const legacy = models.find(
    (item) => item.model === 'claude-4.6-sonnet-thinking',
  );
  assert.equal(legacy.ids.get('medium'), 'claude-4.6-sonnet-medium-thinking');
  const fast = models.find((item) => item.model === 'composer-2.5-fast');
  assert.equal(fast.encoded, false);
  const plain = models.find((item) => item.model === 'gpt-5.5');
  assert.deepEqual(plain.levels, ['extra-high']);
  const plainFast = models.find((item) => item.model === 'gpt-5.5-fast');
  assert.equal(plainFast.ids.get('extra-high'), 'gpt-5.5-extra-high-fast');
  const cursor = AGENTS.find((row) => row.id === 'cursor');
  const row = {
    id: cursor.id,
    name: cursor.name,
    bin: '/usr/bin/cursor-agent',
    spec: cursor,
    models: ids,
  };
  const low = resolveModel(row, {
    model: 'gpt-5.6-sol',
    effort: 'low',
    extra: '',
  });
  assert.equal(low.model, 'gpt-5.6-sol-low');
  assert.equal(low.encoded, true);
  const launch = buildLaunch(
    row,
    { model: 'gpt-5.6-sol-high', effort: 'low', extra: '' },
    '/tmp/plan.md',
  );
  const cmd =
    'cursor-agent --print --trust --model gpt-5.6-sol-low /tmp/plan.md';
  assert.equal(launch.command, cmd);
  assert.equal(launch.command.includes('--effort'), false);
});

test('clicking the model column opens the model list', async () => {
  const { dir, env } = fakePath('cursor-agent');
  const { ui, repo } = openUi();
  try {
    ui.agents.listModels = async () => [
      'gpt-5.6-sol-high',
      'gpt-5.6-sol-low',
      'auto',
    ];
    ui.agents.refresh(env);
    await ui.agents.open();
    ui.nav.agentCursor = 2;
    ui.draw();
    const hit = ui.lastFrame.fileHits.find((entry) => entry.field === 'model');
    assert.ok(hit);
    const click = {
      type: 'mouse',
      button: 0,
      btn: 0,
      x: hit.x0 + 1,
      y: hit.y,
    };
    ui.handleEvent({ ...click, kind: 'press', press: true });
    ui.handleEvent({ ...click, kind: 'release', press: false });
    assert.equal(ui.agents.pick.field, 'model');
    ui.draw();
    const text = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(text, /claude/);
    assert.match(text, /cursor/);
    assert.match(text, /gpt-5\.6-sol/);
    assert.equal(text.includes('gpt-5.6-sol-high'), false);
    assert.equal(text.includes('gpt-5.6-sol-low'), false);
    ui.handleEvent({ type: 'key', key: 's' });
    ui.handleEvent({ type: 'key', key: 'o' });
    ui.handleEvent({ type: 'key', key: 'l' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(ui.agents.choice('cursor').model, 'gpt-5.6-sol');
    assert.equal(ui.agents.choice('cursor').effort, 'high');
    ui.handleEvent({ type: 'key', key: 'f' });
    assert.deepEqual(ui.agents.menuItems(), ['low', 'high']);
    ui.handleEvent({ type: 'key', key: 'up' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(ui.agents.choice('cursor').effort, 'low');
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('model menu uses background and a right scroller', async () => {
  const { dir, env } = fakePath('cursor-agent');
  const repo = makeRepo();
  repo.write('a.js', 'ok\n');
  repo.git(['add', '.']);
  repo.git(['commit', '-m', 'init']);
  const ui = new Session({
    cwd: repo.dir,
    stdout: uiSink(),
    repo: createGitRepo(),
    color: true,
    startPane: 'dashboard',
  });
  ui.ensureRepo();
  ui.load();
  try {
    const models = Array.from({ length: 16 }, (_, i) => `model-${i}`);
    ui.agents.listModels = async (bin, spec) =>
      spec.id === 'cursor' ? models : [];
    ui.agents.refresh(env);
    await ui.agents.open();
    ui.nav.agentCursor = 2;
    ui.handleEvent({ type: 'key', key: 'm' });
    ui.draw();
    const plain = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.equal(plain.includes('┌'), false);
    assert.equal(plain.includes('│'), false);
    assert.equal(plain.includes('─'), false);
    assert.equal(plain.includes('▸'), false);
    const thumb = bg(THEME.taskHeadBg);
    const track = bg(THEME.buttonBg);
    const menuRows = () =>
      ui.lastFrame.rows.filter(
        (row) =>
          row.includes(bg(THEME.noteBg)) || row.includes(bg(THEME.checkBg)),
      );
    const open = menuRows();
    assert.match(plain, /model-0/);
    assert.ok(open.length > 1);
    assert.ok(open.some((row) => row.includes(bg(THEME.checkBg))));
    assert.ok(open.some((row) => row.includes(bg(THEME.noteBg))));
    assert.ok(open.some((row) => row.includes(thumb)));
    assert.ok(open.some((row) => row.includes(track)));
    const thumbAt = open.findIndex((row) => row.includes(thumb));
    ui.handleEvent({ type: 'key', key: 'end' });
    ui.draw();
    const scrolled = menuRows();
    const nextAt = scrolled.findIndex((row) => row.includes(thumb));
    assert.ok(nextAt > thumbAt);
    assert.ok(scrolled.at(-1).includes(thumb));
    assert.equal(scrolled[0].includes(thumb), false);
    const itemFace = (row) => {
      const mark = row.includes(bg(THEME.checkBg))
        ? bg(THEME.checkBg)
        : bg(THEME.noteBg);
      const at = row.indexOf(mark);
      const start = row.indexOf('m', at) + 1;
      const end = row.indexOf(RESET, start);
      return row.slice(start, end);
    };
    assert.match(itemFace(open.find((row) => row.includes(thumb))), /^ /);
    ui.handleEvent({ type: 'key', key: 'escape' });
    ui.handleEvent({ type: 'key', key: 'f' });
    ui.draw();
    const effort = menuRows();
    assert.ok(effort.length > 1);
    assert.equal(
      effort.some((row) => row.includes(thumb)),
      false,
    );
    const low = itemFace(effort.find((row) => stripAnsi(row).includes('low')));
    assert.match(low, /^ /);
    assert.match(low, / $/);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agents screen remembers model and effort in .reslop', async () => {
  const { dir, env } = fakePath('claude');
  const { ui, repo } = openUi();
  try {
    ui.agents.listModels = async () => [];
    ui.agents.refresh(env);
    await ui.agents.open();
    ui.handleEvent({ type: 'key', key: 'm' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    ui.handleEvent({ type: 'key', key: 'f' });
    ui.handleEvent({ type: 'key', key: 'down' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(ui.agents.choice('claude').model, 'sonnet');
    assert.equal(ui.agents.choice('claude').effort, 'medium');
    const file = path.join(repo.dir, '.reslop');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(saved.agents.claude, {
      model: 'sonnet',
      effort: 'medium',
    });
    ui.agents.choices = new Map();
    ui.agents.refresh(env);
    assert.equal(ui.agents.choice('claude').model, 'sonnet');
    assert.equal(ui.agents.choice('claude').effort, 'medium');
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agents screen lists runs for the selected model', async () => {
  const { dir, env } = fakePath('claude');
  const { ui, repo } = openUi();
  try {
    ui.agents.listModels = async () => [];
    ui.agents.refresh(env);
    await ui.agents.open();
    ui.agents.spawn = () => ({ kill() {} });
    ui.handleEvent({ type: 'key', key: 'm' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    ui.handleEvent({ type: 'key', key: 'escape' });
    ui.draw();
    const lines = stripAnsi(ui.lastFrame.rows.join('\n')).split('\n');
    const live = (row) => /claude/.test(row) && /running/.test(row);
    assert.ok(lines.some(live));
    assert.match(ui.agents.jobs[0].command, /claude --model sonnet/);
    ui.handleEvent({ type: 'key', key: 'm' });
    ui.handleEvent({ type: 'key', key: 'down' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    ui.draw();
    const opus = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.equal(opus.includes('running'), false);
    ui.handleEvent({ type: 'key', key: 'm' });
    ui.handleEvent({ type: 'key', key: 'up' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    ui.handleEvent({ type: 'key', key: 'right' });
    assert.equal(ui.agents.focus, 'runs');
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(ui.agents.viewing, true);
    assert.equal(ui.agents.viewId, ui.agents.jobs[0].id);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
