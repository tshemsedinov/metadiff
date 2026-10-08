'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const agents = require('../lib/agents.js');
const sessions = require('../lib/agent-sessions.js');
const { detectAgents, findBin, splitArgs, planPrompt } = agents;
const { emptyChoice, buildLaunch, buildLogin, AGENTS, listModels } = agents;
const { mergeModels, parseCursorModels, parseCursorWide } = agents;
const { parseNameList, hasAgentSession } = agents;
const { parseJsonModels, commandLine, needsAuth } = agents;
const { groupModels, resolveModel } = agents;
const { claudeSession, cursorSession } = sessions;
const { Session } = require('../lib/session.js');
const { createGitRepo } = require('../lib/git.js');
const { makeRepo, uiSink } = require('./helpers.js');
const render = require('../lib/render/render.js');
const { renderFrame } = render;
const { stripAnsi, THEME, bg, RESET, BOLD } = require('../lib/ansi.js');
const { actionFromKey } = require('../lib/session/actions.js');
const { runStats } = require('../lib/session/agent-jobs.js');

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
  const rel = buildLaunch(row, choice, '/tmp/work/.plan/a.md', '/tmp/work');
  assert.equal(rel.plan, '.plan/a.md');
  assert.equal(rel.prompt, planPrompt('.plan/a.md'));
  const relCmd = 'claude --model sonnet --effort high --foo bar .plan/a.md';
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
    assert.equal(rows[0].model, 'sonnet');
    assert.equal(rows[0].effort, 'medium');
    assert.equal(rows[0].fast, 'off');
    assert.equal(ui.agents.choice('claude').model, 'default');
    assert.equal(rows[1].bin, '');
    ui.draw();
    const text = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(text, /agent\s+model\s+effort\s+fast\s+(?:context\s+)?plan/);
    assert.equal(text.includes('▶'), false);
    assert.equal(text.includes('status'), false);
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
    ui.handleEvent({ type: 'key', key: 'e' });
    assert.equal(ui.agents.pick.field, 'effort');
    assert.equal(ui.agents.menuItems().includes('default'), false);
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(ui.agents.choice('claude').effort, 'medium');
    ui.draw();
    const picked = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(picked, /claude\s+sonnet\s+medium\s+off/);
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
    assert.ok(calls[0].launch.args.includes('medium'));
    assert.equal(calls[0].launch.args.includes('--max-turns'), false);
    const prompt = calls[0].launch.args.at(-1);
    assert.match(prompt, /repair plan/);
    assert.match(prompt, /\.plan\//);
    assert.equal(ui.agents.viewing, true);
    assert.equal(ui.agents.jobs.length, 1);
    assert.equal(ui.agents.jobs[0].status, 'running');
    assert.match(
      ui.agents.jobs[0].command,
      /^claude --model sonnet --effort medium \.plan\//,
    );
    const listed = ui.agents.rows().some((row) => row.kind === 'job');
    assert.equal(listed, false);
    assert.match(calls[0].launch.prompt, /\.plan\//);
    ui.draw();
    const log = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(log, /hello/);
    assert.match(render.headerText(ui.view()), /agents log/);
    const watching = renderFrame(ui.view(), {
      width: 80,
      height: 24,
      color: false,
    });
    assert.ok(watching.buttons.some((hit) => hit.id === 'agentStop'));
    assert.match(log, /re-run/);
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
    assert.ok(frame.buttons.some((hit) => hit.id === 'agentFast'));
    assert.equal(
      frame.buttons.some((hit) => hit.id === 'agentParams'),
      false,
    );
    const footer = stripAnsi(frame.rows.at(-1));
    assert.equal(footer.includes('stop'), false);
    assert.match(footer, /plan/);
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
    const reviewDir = path.join(repo.dir, '.plan');
    fs.mkdirSync(reviewDir, { recursive: true });
    const other = '2020-01-01-00.md';
    const body = '---\nstatus: ready\n---\n';
    fs.writeFileSync(path.join(reviewDir, other), body);
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
    assert.equal(ui.agents.jobs.length, 1);
    assert.equal(ui.status, `busy ${path.basename(ui.agents.planFile())}`);
    ui.handleEvent({ type: 'key', key: 'p' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    ui.agents.start();
    assert.equal(ui.agents.jobs.length, 2);
    assert.equal(ui.agents.rows().length, clis);
    assert.equal(ui.agents.runningCount(), 2);
    ui.handleEvent({ type: 'key', key: 'escape' });
    ui.handleEvent({ type: 'key', key: 's' });
    assert.equal(killed.length, 0);
    ui.handleEvent({ type: 'key', key: 'enter' });
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

test('r in the agent log repeats the command', async () => {
  const { dir, env } = fakePath('claude');
  const { ui, repo } = openUi();
  try {
    ui.agents.listModels = async () => [];
    ui.agents.refresh(env);
    await ui.agents.open();
    const calls = [];
    let close = null;
    ui.agents.spawn = (cwd, launch, onData, onClose) => {
      calls.push(launch);
      onData('live\n');
      close = onClose;
      return {
        kill() {
          onClose({ status: 1, text: 'bye\n' });
        },
      };
    };
    ui.agents.start();
    assert.equal(ui.agents.viewing, true);
    ui.handleEvent({ type: 'key', key: 'r' });
    assert.equal(calls.length, 1);
    close({ status: 0, text: 'done\n' });
    ui.handleEvent({ type: 'key', key: 'r' });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].command, calls[0].command);
    ui.handleEvent({ type: 'key', key: 'escape' });
    ui.handleEvent({ type: 'key', key: 'r' });
    assert.equal(calls.length, 2);
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
  assert.equal(launch.args[0], '--trust');
  assert.equal(launch.pty, true);
  const shown = 'cursor-agent --trust --model auto /tmp/plan.md';
  assert.equal(launch.command, shown);
  const hard = buildLaunch(
    row,
    { model: 'auto', extra: '', effort: 'xhigh' },
    '/tmp/plan.md',
  );
  const hardCmd =
    'cursor-agent --trust --model auto[effort=xhigh] /tmp/plan.md';
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
  const saved = buildLaunch(
    row,
    { model: 'grok-4.6', extra: '', effort: 'high', fast: true },
    '/tmp/plan.md',
  );
  const savedCmd =
    'cursor-agent --trust --model grok-4.6[effort=high,fast=true] ' +
    '/tmp/plan.md';
  assert.equal(saved.command, savedCmd);
});

test('cursor grok-4.6 uses the listed effort slug', () => {
  const cursor = AGENTS.find((row) => row.id === 'cursor');
  const row = {
    id: cursor.id,
    name: cursor.name,
    bin: '/usr/bin/cursor-agent',
    spec: cursor,
    models: [
      'grok-4.6',
      'cursor-grok-4.6-low',
      'cursor-grok-4.6-high',
      'cursor-grok-4.6-high-fast',
      'cursor-grok-4.6-xhigh',
    ],
  };
  const launch = buildLaunch(
    row,
    {
      model: 'grok-4.6',
      extra: '',
      effort: 'high',
      fast: true,
      context: '256k',
    },
    '/tmp/plan.md',
  );
  const cmd =
    'cursor-agent --trust --model cursor-grok-4.6-high-fast /tmp/plan.md';
  assert.equal(launch.command, cmd);
  assert.equal(launch.args.includes('--effort'), false);
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
  const wide = [
    'grok-4.7-high - Grok 4.7 High',
    'gpt-5.6-sol-high - GPT-5.6 Sol 1M High',
  ].join('\n');
  assert.deepEqual(parseCursorWide(wide), ['gpt-5.6-sol-high']);
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
  const listed = await listModels('agent', spec, { run });
  assert.deepEqual(listed.names, ['auto', 'grok-4.6']);
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
    assert.match(text, /cursor\s+grok-4/);
    assert.match(text, /\d{4}-\d{2}-\d{2}-\d+\.md/);
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
    const reviewDir = path.join(repo.dir, '.plan');
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
    assert.equal(calls[0].plan, `.plan/${name}`);
    assert.match(calls[0].prompt, /\.plan\/2020-01-01-00\.md/);
    assert.match(calls[0].command, /\.plan\/2020-01-01-00\.md$/);
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
    const reviewDir = path.join(repo.dir, '.plan');
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
    ui.handleEvent({ type: 'key', key: 'p' });
    assert.equal(ui.agents.pick.field, 'plan');
    assert.deepEqual(ui.agents.menuItems(), [
      `${newer}  partial  0/0`,
      `${older}  ready    1/2`,
    ]);
    ui.draw();
    const menu = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(menu, /2020-01-02-00\.md {2}partial {2}0\/0/);
    assert.match(menu, /2020-01-01-00\.md {2}ready {4}1\/2/);
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
    assert.equal(calls[0].plan, `.plan/${older}`);
    assert.match(calls[0].command, /\.plan\/2020-01-01-00\.md$/);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('plan combo lists plain markdown and aligns columns', async () => {
  const { dir, env } = fakePath('claude');
  const { ui, repo } = openUi();
  try {
    const reviewDir = path.join(repo.dir, '.plan');
    fs.mkdirSync(reviewDir, { recursive: true });
    const dated = '2020-01-02-00.md';
    const note = 'note.md';
    const ideas = 'ideas.md';
    const datedBody = [
      '---',
      'status: partial',
      '---',
      '',
      '> a.js',
      '',
      '- [ ] still open',
      '',
    ].join('\n');
    const noteBody = [
      '---',
      'status: ready',
      '---',
      '',
      '> a.js',
      '',
      '- [x] one',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(reviewDir, dated), datedBody);
    fs.writeFileSync(path.join(reviewDir, note), noteBody);
    fs.writeFileSync(path.join(reviewDir, ideas), '# ideas\n\nJust a note.\n');
    fs.writeFileSync(path.join(reviewDir, '.templates'), '[]\n');
    ui.review.store.reviewPath = '';
    ui.agents.listModels = async () => [];
    ui.agents.refresh(env);
    await ui.agents.open();
    ui.handleEvent({ type: 'key', key: 'p' });
    assert.deepEqual(ui.agents.menuItems(), [
      `${dated}  partial  0/1`,
      ideas,
      `${'note.md'.padEnd(dated.length)}  ready    1/1`,
    ]);
    ui.handleEvent({ type: 'key', key: 'down' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(path.basename(ui.agents.planFile()), ideas);
    ui.draw();
    const text = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(text, /ideas\.md/);
    assert.equal(text.includes('ideas.md  editing'), false);
    ui.handleEvent({ type: 'key', key: 'p' });
    ui.handleEvent({ type: 'key', key: 'down' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(path.basename(ui.agents.planFile()), note);
    assert.equal(ui.agents.planFace(), `${note}  ready  1/1`);
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
    ui.handleEvent({ type: 'key', key: 's' });
    assert.equal(ui.agents.jobs[0].status, 'stopped');
    ui.handleEvent({ type: 'key', key: 'escape' });
    assert.equal(ui.agents.viewing, false);
    assert.equal(ui.status, '');
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
  const cmd = 'cursor-agent --trust --model gpt-5.6-sol-low /tmp/plan.md';
  assert.equal(launch.command, cmd);
  assert.equal(launch.command.includes('--effort'), false);
  const fastOn = buildLaunch(
    row,
    { model: 'gpt-5.6-sol', effort: 'low', extra: '', fast: true },
    '/tmp/plan.md',
  );
  const fastCmd =
    'cursor-agent --trust --model gpt-5.6-sol-low-fast /tmp/plan.md';
  assert.equal(fastOn.command, fastCmd);
  const sized = buildLaunch(
    row,
    { model: 'gpt-5.6-sol', effort: 'low', extra: '', context: '1m' },
    '/tmp/plan.md',
  );
  const sizedCmd =
    'cursor-agent --trust --model gpt-5.6-sol-low[context=1m] ' +
    '/tmp/plan.md';
  assert.equal(sized.command, sizedCmd);
  const normal = buildLaunch(
    row,
    { model: 'gpt-5.6-sol', effort: 'low', extra: '', context: '256k' },
    '/tmp/plan.md',
  );
  assert.equal(normal.command, cmd);
  const grok = buildLaunch(
    row,
    { model: 'grok-4.7-high', effort: 'high', extra: '', context: '256k' },
    '/tmp/plan.md',
  );
  assert.equal(grok.args.includes('grok-4.7-high[context=256k]'), false);
  assert.ok(grok.args.includes('grok-4.7-high'));
  const half = buildLaunch(
    row,
    {
      model: 'grok-4.7-high',
      effort: 'high',
      extra: '',
      fast: false,
      context: '500k',
    },
    '/tmp/plan.md',
  );
  assert.ok(half.args.includes('grok-4.7-high[context=500k]'));
});

test('model menu omits a fast name that has a plain sibling', async () => {
  const { dir, env } = fakePath('cursor-agent');
  const { ui, repo } = openUi();
  try {
    ui.agents.listModels = async () => [
      'gpt-5.6-sol-high',
      'gpt-5.6-sol-low',
      'gpt-5.6-sol-low-fast',
      'gpt-5.6-sol-high-fast',
      'composer-2.5-fast',
    ];
    ui.agents.refresh(env);
    await ui.agents.open();
    ui.nav.agentCursor = 2;
    ui.handleEvent({ type: 'key', key: 'm' });
    const items = ui.agents.menuItems();
    assert.ok(items.includes('gpt-5.6-sol'));
    assert.ok(items.includes('composer-2.5-fast'));
    assert.equal(
      items.some((name) => name === 'gpt-5.6-sol-fast'),
      false,
    );
    ui.handleEvent({ type: 'key', key: 'escape' });
    ui.draw();
    const text = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.equal(text.includes('gpt-5.6-sol-fast'), false);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
    ui.draw();
    assert.equal(ui.agents.pick.query, 'so');
    const found = ui.agents.menuItems();
    assert.ok(found.length > 0);
    assert.ok(found.every((name) => name.toLowerCase().includes('so')));
    const showsQuery = (text, q) => new RegExp(`\\s${q}(?:\\s|$)`).test(text);
    const typed = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.ok(showsQuery(typed, 'so'));
    const typedLines = typed.split('\n').map((line) => line.trim());
    assert.equal(typedLines.includes('so'), false);
    assert.ok(
      typedLines.some(
        (line) => line.includes('cursor') && /\sso(?:\s|$)/.test(line),
      ),
    );
    ui.handleEvent({ type: 'key', key: 'backspace' });
    assert.equal(ui.agents.pick.query, 's');
    ui.draw();
    const cleared = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.equal(showsQuery(cleared, 'so'), false);
    assert.ok(showsQuery(cleared, 's'));
    ui.handleEvent({ type: 'key', key: 'o' });
    ui.handleEvent({ type: 'key', key: 'l' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(ui.agents.choice('cursor').model, 'gpt-5.6-sol');
    assert.equal(ui.agents.choice('cursor').effort, 'low');
    ui.handleEvent({ type: 'key', key: 'e' });
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

test('clicking another column switches the open combo', async () => {
  const { dir, env } = fakePath('cursor-agent');
  const { ui, repo } = openUi();
  try {
    ui.agents.listModels = async () => [];
    ui.agents.refresh(env);
    await ui.agents.open();
    const at = ui.agents.rows().findIndex((row) => row.id === 'cursor');
    ui.nav.agentCursor = at;
    ui.draw();
    const clickAt = (hit) => {
      const click = {
        type: 'mouse',
        button: 0,
        btn: 0,
        x: hit.x0 + 1,
        y: hit.y,
      };
      ui.handleEvent({ ...click, kind: 'press', press: true });
      ui.handleEvent({ ...click, kind: 'release', press: false });
    };
    const model = ui.lastFrame.fileHits.find(
      (entry) => entry.field === 'model',
    );
    assert.ok(model);
    clickAt(model);
    assert.equal(ui.agents.pick.field, 'model');
    ui.handleEvent({ type: 'key', key: 'j' });
    ui.handleEvent({ type: 'key', key: 'k' });
    assert.equal(ui.agents.pick.query, 'jk');
    assert.equal(ui.agents.pick.cursor, 0);
    ui.draw();
    const effort = ui.lastFrame.fileHits.find(
      (entry) => entry.field === 'effort',
    );
    assert.ok(effort);
    clickAt(effort);
    assert.equal(ui.agents.pick.field, 'effort');
    assert.equal(ui.agents.pick.query, '');
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
    assert.equal(ui.agents.selected().id, 'cursor');
    ui.nav.agentCursor = 2;
    ui.draw();
    const head = ui.lastFrame.rows.find((row) => {
      const plain = stripAnsi(row);
      return plain.includes('model') && plain.includes('plan');
    });
    assert.ok(head);
    assert.equal(head.includes(BOLD), false);
    assert.ok(head.includes('38;2;122;122;138'));
    const claude = ui.lastFrame.rows.find((row) =>
      stripAnsi(row).includes('claude'),
    );
    const cursor = ui.lastFrame.rows.find((row) =>
      stripAnsi(row).includes('cursor'),
    );
    assert.ok(claude);
    assert.ok(cursor);
    assert.equal(claude.includes(BOLD), false);
    assert.ok(claude.includes('38;2;21;74;140'));
    assert.ok(cursor.includes(BOLD));
    assert.ok(cursor.includes('38;2;86;156;214'));
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
    ui.handleEvent({ type: 'key', key: 'e' });
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
    ui.handleEvent({ type: 'key', key: 'e' });
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

test('recorded runs stay listed for the selected cli', async () => {
  const { dir, env } = fakePath('cursor-agent', 'claude');
  const { ui, repo } = openUi();
  try {
    const plan = path.join(repo.dir, '.plan');
    fs.mkdirSync(plan, { recursive: true });
    const recorded = [
      {
        id: 1,
        cliId: 'cursor',
        name: 'cursor',
        model: 'grok-4.6',
        cmd: '/bin/cursor-agent',
        args: [],
        command: 'cursor old grok',
        plan: '.plan/a.md',
        action: 'run',
        exit: 1,
        elapsed: 4,
        startedAt: 1,
        output: '',
      },
      {
        id: 2,
        cliId: 'cursor',
        name: 'cursor',
        model: 'cursor-grok-4.6',
        cmd: '/bin/cursor-agent',
        args: [],
        command: 'cursor new grok',
        plan: '.plan/a.md',
        action: 'run',
        stopped: true,
        elapsed: 0,
        startedAt: 2,
        output: '',
      },
      {
        id: 3,
        cliId: 'claude',
        name: 'claude',
        model: 'sonnet',
        cmd: '/bin/claude',
        args: [],
        command: 'claude only',
        plan: '.plan/a.md',
        action: 'run',
        exit: 0,
        elapsed: 1,
        startedAt: 3,
        output: '',
      },
    ];
    const file = path.join(plan, '.runs');
    fs.writeFileSync(file, `${JSON.stringify(recorded, null, 2)}\n`);
    ui.agents.listModels = async () => [];
    ui.agents.refresh(env);
    ui.agents.loadRuns();
    await ui.agents.open();
    const at = ui.agents.rows().findIndex((row) => row.id === 'cursor');
    ui.nav.agentCursor = at;
    ui.agents.choice('cursor').model = 'auto';
    const cursor = ui.agents.rows().find((row) => row.id === 'cursor');
    const shown = ui.agents.runRows(cursor).map((row) => row.command);
    assert.deepEqual(shown, ['cursor new grok', 'cursor old grok']);
    ui.draw();
    const text = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(text, /stopped/);
    assert.match(text, /exit 1/);
    const claudeAt = ui.agents.rows().findIndex((row) => row.id === 'claude');
    ui.nav.agentCursor = claudeAt;
    const claude = ui.agents.rows().find((row) => row.id === 'claude');
    const claudeRuns = ui.agents.runRows(claude).map((row) => row.command);
    assert.deepEqual(claudeRuns, ['claude only']);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agents screen lists every run for the selected cli', async () => {
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
    assert.ok(lines.some((row) => /claude/.test(row)));
    assert.ok(lines.some((row) => /running/.test(row)));
    const title = lines.findIndex((line) => /agent\s+model/.test(line));
    const runHit = ui.lastFrame.fileHits.find((hit) => hit.side === 'runs');
    assert.ok(runHit);
    assert.equal(runHit.y, title + 1);
    assert.match(ui.agents.jobs[0].command, /claude --model sonnet/);
    ui.handleEvent({ type: 'key', key: 'm' });
    ui.handleEvent({ type: 'key', key: 'down' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    ui.draw();
    const opus = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(opus, /running/);
    ui.handleEvent({ type: 'key', key: 'm' });
    ui.handleEvent({ type: 'key', key: 'up' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    ui.handleEvent({ type: 'key', key: 'right' });
    assert.equal(ui.agents.focus, 'runs');
    ui.handleEvent({ type: 'key', key: 'tab' });
    assert.equal(ui.agents.focus, 'cli');
    ui.handleEvent({ type: 'key', key: 'tab' });
    assert.equal(ui.agents.focus, 'runs');
    ui.handleEvent({ type: 'key', key: 'left' });
    assert.equal(ui.agents.focus, 'cli');
    ui.handleEvent({ type: 'key', key: 'right' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(ui.agents.viewing, true);
    assert.equal(ui.agents.viewId, ui.agents.jobs[0].id);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agents panels scroll past one screen', async () => {
  const { dir, env } = fakePath('claude');
  const { ui, repo } = openUi();
  try {
    ui.agents.listModels = async () => [];
    ui.agents.refresh(env);
    await ui.agents.open();
    ui.agents.choice('claude').model = 'sonnet';
    for (let i = 0; i < 40; i++) {
      ui.agents.jobs.push({
        id: i + 1,
        cliId: 'claude',
        model: 'sonnet',
        status: 'exit 0',
        command: `run-${i}`,
      });
    }
    ui.agents.focusRuns();
    ui.draw();
    const top = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(top, /run-39/);
    assert.equal(/\brun-0\b/.test(top), false);
    ui.handleEvent({ type: 'key', key: 'end' });
    ui.draw();
    const bottom = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(bottom, /run-0/);
    assert.equal(bottom.includes('run-39'), false);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agents screen blocks a review file that is already running', async () => {
  const { dir, env } = fakePath('claude', 'cursor-agent');
  const { ui, repo } = openUi();
  try {
    const reviewDir = path.join(repo.dir, '.plan');
    fs.mkdirSync(reviewDir, { recursive: true });
    const older = '2020-01-01-00.md';
    const newer = '2020-01-02-00.md';
    const body = '---\nstatus: ready\n---\n';
    fs.writeFileSync(path.join(reviewDir, older), body);
    fs.writeFileSync(path.join(reviewDir, newer), body);
    ui.review.store.reviewPath = '';
    ui.agents.listModels = async () => [];
    ui.agents.refresh(env);
    await ui.agents.open();
    const calls = [];
    ui.agents.spawn = () => {
      calls.push(1);
      return { kill() {} };
    };
    ui.agents.start();
    assert.equal(calls.length, 1);
    assert.equal(ui.agents.jobs[0].plan, `.plan/${newer}`);
    ui.handleEvent({ type: 'key', key: 'escape' });
    ui.nav.agentCursor = 2;
    ui.agents.start();
    assert.equal(calls.length, 1);
    assert.equal(ui.status, `busy ${newer}`);
    ui.handleEvent({ type: 'key', key: 'p' });
    assert.deepEqual(ui.agents.menuItems(), [
      `${newer}  ready  0/0`,
      `${older}  ready  0/0`,
    ]);
    assert.equal(ui.agents.pick.cursor, 1);
    ui.agents.pick.cursor = 0;
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(ui.agents.pick.field, 'plan');
    assert.equal(path.basename(ui.agents.planFile()), newer);
    ui.handleEvent({ type: 'key', key: 'down' });
    assert.equal(ui.agents.pick.cursor, 1);
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(ui.agents.pick, null);
    assert.equal(path.basename(ui.agents.planFile()), older);
    ui.agents.start();
    assert.equal(calls.length, 2);
    assert.equal(ui.agents.jobs[1].plan, `.plan/${older}`);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agents screen toggles fast mode with a', async () => {
  const { dir, env } = fakePath('claude');
  const { ui, repo } = openUi();
  try {
    ui.agents.listModels = async () => [];
    ui.agents.refresh(env);
    await ui.agents.open();
    ui.handleEvent({ type: 'key', key: 'a' });
    assert.equal(ui.agents.choice('claude').fast, true);
    assert.equal(ui.agents.rows()[0].fast, 'on');
    ui.draw();
    const on = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(on, /claude\s+sonnet\s+medium\s+on/);
    const saved = JSON.parse(fs.readFileSync(path.join(repo.dir, '.reslop')));
    assert.equal(saved.agents.claude.fast, true);
    ui.handleEvent({ type: 'key', key: 'a' });
    assert.equal(ui.agents.choice('claude').fast, false);
    assert.equal(ui.agents.rows()[0].fast, 'off');
    const cleared = JSON.parse(
      fs.readFileSync(path.join(repo.dir, '.reslop'), 'utf8'),
    );
    assert.equal(cleared.agents.claude.fast, undefined);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('single click on the fast column toggles it', async () => {
  const { dir, env } = fakePath('claude');
  const { ui, repo } = openUi();
  try {
    ui.agents.listModels = async () => [];
    ui.agents.refresh(env);
    await ui.agents.open();
    ui.draw();
    const hit = ui.lastFrame.fileHits.find((entry) => entry.field === 'fast');
    assert.ok(hit);
    const click = {
      type: 'mouse',
      button: 0,
      btn: 0,
      x: hit.x0 + 1,
      y: hit.y,
    };
    const press = (kind) => {
      ui.handleEvent({ ...click, kind, press: kind === 'press' });
    };
    press('press');
    press('release');
    assert.equal(ui.agents.choice('claude').fast, true);
    assert.equal(ui.agents.rows()[0].fast, 'on');
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('selecting a model keeps only context sizes it offers', async () => {
  const { dir, env } = fakePath('cursor-agent');
  const { ui, repo } = openUi();
  try {
    ui.agents.listModels = async (bin, spec) => {
      if (spec.id !== 'cursor') return [];
      const names = [
        'grok-4.7-high',
        'gpt-5.6-sol-high',
        'gpt-5.6-sol-low',
        'gpt-5.6-sol-low-fast',
      ];
      names.wide = ['gpt-5.6-sol-high', 'gpt-5.6-sol-low'];
      return names;
    };
    ui.agents.refresh(env);
    await ui.agents.open();
    const at = ui.agents.rows().findIndex((row) => row.id === 'cursor');
    ui.nav.agentCursor = at;
    ui.handleEvent({ type: 'key', key: 'm' });
    ui.handleEvent({ type: 'key', key: 'down' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(ui.agents.choice('cursor').model, 'gpt-5.6-sol');
    assert.equal(ui.agents.choice('cursor').effort, 'high');
    ui.handleEvent({ type: 'key', key: 'a' });
    assert.equal(ui.agents.choice('cursor').fast, true);
    ui.handleEvent({ type: 'key', key: 'o' });
    assert.deepEqual(ui.agents.menuItems(), ['256k', '1m']);
    ui.handleEvent({ type: 'key', key: 'down' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(ui.agents.choice('cursor').context, '1m');
    ui.handleEvent({ type: 'key', key: 'm' });
    ui.handleEvent({ type: 'key', key: 'up' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(ui.agents.choice('cursor').model, 'grok-4.7');
    assert.equal(ui.agents.choice('cursor').context, '256k');
    assert.equal(ui.agents.choice('cursor').fast, false);
    assert.equal(ui.agents.choice('cursor').effort, 'high');
    ui.handleEvent({ type: 'key', key: 'o' });
    assert.deepEqual(ui.agents.menuItems(), ['256k', '500k']);
    ui.handleEvent({ type: 'key', key: 'down' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(ui.agents.choice('cursor').context, '500k');
    assert.equal(ui.agents.choice('cursor').effort, 'high');
    assert.equal(ui.agents.choice('cursor').fast, false);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clicking the context column drops the size list', async () => {
  const { dir, env } = fakePath('cursor-agent');
  const { ui, repo } = openUi();
  try {
    ui.agents.listModels = async () => {
      const names = ['grok-4.7-high', 'gpt-5.6-sol-high'];
      names.wide = ['gpt-5.6-sol-high'];
      return names;
    };
    ui.agents.refresh(env);
    await ui.agents.open();
    const at = ui.agents.rows().findIndex((row) => row.id === 'cursor');
    ui.nav.agentCursor = at;
    ui.agents.choice('cursor').model = 'grok-4.7';
    ui.agents.choice('cursor').effort = 'high';
    const calls = [];
    ui.agents.spawn = () => {
      calls.push('start');
      return { kill() {} };
    };
    ui.draw();
    const hit = ui.lastFrame.fileHits.find(
      (entry) => entry.field === 'context' && entry.cursor === at,
    );
    assert.ok(hit);
    const click = {
      type: 'mouse',
      button: 0,
      btn: 0,
      x: hit.x0 + 1,
      y: hit.y,
    };
    const press = (kind) => {
      ui.handleEvent({ ...click, kind, press: kind === 'press' });
    };
    press('press');
    press('release');
    assert.equal(ui.agents.pick && ui.agents.pick.field, 'context');
    assert.deepEqual(ui.agents.menuItems(), ['256k', '500k']);
    assert.equal(calls.length, 0);
    press('press');
    press('release');
    assert.equal(calls.length, 0);
    assert.equal(ui.agents.jobs.length, 0);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agents screen selects a cursor context size', async () => {
  const { dir, env } = fakePath('cursor-agent');
  const { ui, repo } = openUi();
  try {
    ui.agents.listModels = async () => [];
    ui.agents.refresh(env);
    await ui.agents.open();
    ui.nav.agentCursor = 2;
    ui.handleEvent({ type: 'key', key: 'o' });
    assert.equal(ui.agents.pick.field, 'context');
    assert.deepEqual(ui.agents.menuItems(), ['256k', '1m']);
    ui.handleEvent({ type: 'key', key: 'down' });
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(ui.agents.choice('cursor').context, '1m');
    ui.draw();
    const text = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(text, /context/);
    assert.match(text, /cursor\s+\S+\s+\S+\s+off\s+1m/);
    const file = path.join(repo.dir, '.reslop');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.agents.cursor.context, '1m');
    const calls = [];
    ui.agents.spawn = (cwd, launch) => {
      calls.push(launch);
      return { kill() {} };
    };
    ui.agents.choice('cursor').model = 'grok-4.6';
    ui.agents.start();
    assert.equal(calls.length, 1);
    assert.ok(calls[0].args.includes('grok-4.6[context=1m,effort=medium]'));
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agent columns fill the row in proportion to their content', async () => {
  const { dir, env } = fakePath('claude');
  const { ui, repo, stdout } = openUi();
  try {
    ui.agents.refresh(env);
    await ui.agents.open();
    stdout.columns = 160;
    ui.draw();
    const plain = stripAnsi(ui.lastFrame.rows.join('\n')).split('\n');
    const titleAt = plain.findIndex((line) => /agent\s+model/.test(line));
    assert.equal(titleAt, 2);
    assert.equal(plain[1].trim(), '');
    assert.match(plain[titleAt], /plan/);
    assert.match(plain[titleAt], /^ {2}agent/);
    assert.equal(/^ {3}agent/.test(plain[titleAt]), false);
    assert.equal(plain[titleAt].includes('status'), false);
    const plan = ui.lastFrame.fileHits.find((hit) => hit.field === 'plan');
    const model = ui.lastFrame.fileHits.find((hit) => hit.field === 'model');
    assert.ok(plan);
    assert.ok(model);
    const planW = plan.x1 - plan.x0;
    const modelW = model.x1 - model.x0;
    assert.ok(planW > modelW);
    assert.ok(modelW > 'sonnet'.length);
    assert.equal(plan.x1, 122);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agent history keeps the launch, output, time, and progress', async () => {
  const { dir, env } = fakePath('claude');
  const { ui, repo, stdout } = openUi();
  try {
    const reviewDir = path.join(repo.dir, '.plan');
    fs.mkdirSync(reviewDir, { recursive: true });
    const name = '2020-01-01-00.md';
    const body = [
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
    fs.writeFileSync(path.join(reviewDir, name), body);
    ui.review.store.reviewPath = '';
    ui.agents.listModels = async () => [];
    ui.agents.refresh(env);
    await ui.agents.open();
    const sessionId = '2fa698ba-9a19-4a84-8134-5a7cd9ec2c56';
    const text = [
      'hello from agent',
      'total tokens: 1,234',
      'Grok 4.7 256K High · 44.3% · 9 files edited',
      `To resume this session: agent --resume=${sessionId}`,
      '',
    ].join('\n');
    ui.agents.spawn = (cwd, launch, onData, onClose) => {
      onData(text);
      onClose({ status: 0, text });
      return { kill() {} };
    };
    ui.agents.start();
    const job = ui.agents.jobs[0];
    assert.equal(job.status, 'exit 0');
    assert.match(job.command, /claude/);
    assert.match(job.output, /hello from agent/);
    stdout.columns = 160;
    assert.equal(ui.agents.viewing, true);
    ui.draw();
    const rows = ui.lastFrame.rows.map((row) => stripAnsi(row));
    const log = rows.join('\n');
    assert.equal(rows[1].trim(), '');
    const command = rows.find((row) => row.includes('.plan/'));
    const status = rows.find((row) => row.includes('exit 0'));
    assert.match(command, /^ {2}\S/);
    assert.match(status, /^ {2}exit 0/);
    assert.equal(command.slice(-2), '  ');
    assert.equal(status.slice(-2), '  ');
    assert.match(log, /claude/);
    assert.match(log, /hello from agent/);
    assert.match(log, /exit 0/);
    assert.match(log, /\d+:\d{2}/);
    assert.match(log, /1\/2/);
    ui.handleEvent({ type: 'key', key: 'escape' });
    assert.equal(ui.agents.viewing, false);
    ui.agents.focusRuns();
    ui.draw();
    const list = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.equal(list.includes('▶'), false);
    assert.equal(list.includes('status'), false);
    assert.match(list, /exit 0/);
    assert.match(list, /\d+:\d{2}/);
    assert.match(list, /1\/2/);
    ui.handleEvent({ type: 'key', key: 'enter' });
    assert.equal(ui.agents.viewing, true);
    const runs = JSON.parse(
      fs.readFileSync(path.join(repo.dir, '.plan', '.runs'), 'utf8'),
    );
    assert.equal(runs.length, 1);
    assert.equal(runs[0].exit, 0);
    assert.equal(runs[0].status, undefined);
    assert.equal(runs[0].endedAt, undefined);
    assert.equal(typeof runs[0].elapsed, 'number');
    assert.equal(runs[0].files, 9);
    assert.equal(runs[0].session, sessionId);
    assert.match(runs[0].output, /hello from agent/);
    assert.match(runs[0].command, /claude/);
    const sessions = JSON.parse(
      fs.readFileSync(path.join(repo.dir, '.plan', '.sessions'), 'utf8'),
    );
    const session = sessions[sessionId];
    assert.equal(session.cli, 'claude');
    assert.equal(session.files, 9);
    assert.equal(session.tokens, 1234);
    assert.equal(fs.existsSync(path.join(repo.dir, '.reslop')), false);
    ui.agents.reset();
    assert.equal(ui.agents.jobs[0].status, 'exit 0');
    assert.match(ui.agents.jobs[0].output, /hello from agent/);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agent output shows a scroller when the log overflows', async () => {
  const { dir, env } = fakePath('claude');
  const repo = makeRepo();
  repo.write('a.js', 'ok\n');
  repo.git(['add', '.']);
  repo.git(['commit', '-m', 'init']);
  const stdout = uiSink();
  stdout.columns = 80;
  stdout.rows = 16;
  const ui = new Session({
    cwd: repo.dir,
    stdout,
    repo: createGitRepo(),
    color: true,
    startPane: 'dashboard',
  });
  ui.ensureRepo();
  ui.load();
  try {
    ui.agents.listModels = async () => [];
    ui.agents.refresh(env);
    await ui.agents.open();
    const text = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n');
    ui.agents.spawn = (cwd, launch, onData, onClose) => {
      onData(`${text}\n`);
      onClose({ status: 0, text: `${text}\n` });
      return { kill() {} };
    };
    ui.agents.start();
    assert.equal(ui.agents.viewing, true);
    ui.draw();
    const thumb = bg(THEME.taskHeadBg);
    const track = bg(THEME.buttonBg);
    const ground = bg(THEME.ctxBg);
    const logRows = () =>
      ui.lastFrame.rows.filter((row) => {
        if (!row.includes(ground)) return false;
        return row.includes(thumb) || row.includes(track);
      });
    const open = logRows();
    assert.ok(open.some((row) => row.includes(thumb)));
    assert.ok(open.some((row) => !row.includes(thumb)));
    const thumbAt = open.findIndex((row) => row.includes(thumb));
    assert.ok(thumbAt > 0);
    ui.handleEvent({ type: 'key', key: 'home' });
    ui.draw();
    const top = logRows();
    const nextAt = top.findIndex((row) => row.includes(thumb));
    assert.ok(nextAt < thumbAt);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dragging the agent output scroller scrolls the log', async () => {
  const { dir, env } = fakePath('claude');
  const repo = makeRepo();
  repo.write('a.js', 'ok\n');
  repo.git(['add', '.']);
  repo.git(['commit', '-m', 'init']);
  const stdout = uiSink();
  stdout.columns = 80;
  stdout.rows = 16;
  const ui = new Session({
    cwd: repo.dir,
    stdout,
    repo: createGitRepo(),
    color: true,
    startPane: 'dashboard',
  });
  ui.ensureRepo();
  ui.load();
  try {
    ui.agents.listModels = async () => [];
    ui.agents.refresh(env);
    await ui.agents.open();
    const text = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n');
    ui.agents.spawn = (cwd, launch, onData, onClose) => {
      onData(`${text}\n`);
      onClose({ status: 0, text: `${text}\n` });
      return { kill() {} };
    };
    ui.agents.start();
    ui.draw();
    const bar = ui.lastFrame.scrollBar;
    assert.ok(bar);
    const max = bar.count - bar.rows;
    assert.ok(max > 0);
    const thumb = bg(THEME.taskHeadBg);
    const thumbAt = ui.lastFrame.rows.findIndex((row) => row.includes(thumb));
    assert.ok(thumbAt > 1);
    const pointer = (kind, x, y) => {
      ui.handleEvent({
        type: 'mouse',
        button: kind === 'drag' ? 32 : 0,
        btn: 0,
        kind,
        x,
        y,
        press: kind !== 'release',
      });
    };
    pointer('press', bar.x, thumbAt + 1);
    pointer('drag', bar.x, thumbAt - 1);
    pointer('release', bar.x, thumbAt - 1);
    ui.draw();
    assert.equal(ui.nav.selection, null);
    assert.equal(ui.agents.followEnd, false);
    assert.ok(ui.agents.logScroll > 0);
    assert.ok(ui.agents.logScroll < max);
    const mid = ui.lastFrame.scrollBar;
    pointer('press', mid.x, mid.y + mid.height - 1);
    pointer('drag', mid.x, mid.y);
    pointer('release', mid.x, mid.y);
    ui.draw();
    assert.equal(ui.nav.selection, null);
    assert.equal(ui.agents.logScroll, 0);
    const shown = stripAnsi(ui.lastFrame.rows.join('\n'));
    assert.match(shown, /line 0/);
    assert.equal(shown.includes('line 79'), false);
    const line = ui.lastFrame.rows.findIndex((row) =>
      stripAnsi(row).includes('line 0'),
    );
    assert.ok(line >= 0);
    pointer('press', 4, line + 1);
    pointer('drag', 12, line + 1);
    assert.ok(ui.nav.selection);
    assert.equal(ui.agents.logScroll, 0);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildLaunch continues a previous session', () => {
  const cursor = AGENTS.find((row) => row.id === 'cursor');
  const row = {
    id: cursor.id,
    name: cursor.name,
    bin: '/usr/bin/cursor-agent',
    spec: cursor,
    models: cursor.models,
  };
  const kept = buildLaunch(row, emptyChoice(row), '/tmp/plan.md', '/tmp', true);
  assert.equal(kept.args[0], '--trust');
  assert.equal(kept.args[1], '--continue');
  assert.match(kept.command, /^cursor-agent --trust --continue /);
  const fresh = buildLaunch(row, emptyChoice(row), '/tmp/plan.md', '/tmp');
  assert.equal(fresh.args.includes('--continue'), false);
  const codex = AGENTS.find((item) => item.id === 'codex');
  const codexRow = {
    id: codex.id,
    name: codex.name,
    bin: '/usr/bin/codex',
    spec: codex,
    models: codex.models,
  };
  const resumed = buildLaunch(
    codexRow,
    { model: 'gpt-5', extra: '', effort: 'high' },
    '/tmp/plan.md',
    '/tmp',
    true,
  );
  assert.equal(resumed.args[0], 'resume');
  assert.equal(resumed.args[1], '--last');
  assert.ok(resumed.args.includes('--model'));
  assert.ok(resumed.args.includes('model_reasoning_effort=high'));
});

test('stored chats count as a previous agent session', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reslop-chats-'));
  const cwd = '/tmp/work';
  try {
    const chat = path.join(root, 'bucket', 'chat-id');
    fs.mkdirSync(chat, { recursive: true });
    const meta = { cwd, hasConversation: true };
    fs.writeFileSync(path.join(chat, 'meta.json'), JSON.stringify(meta));
    assert.equal(cursorSession(cwd, root), true);
    assert.equal(cursorSession('/tmp/other', root), false);
    const empty = path.join(root, 'bucket', 'empty');
    fs.mkdirSync(empty);
    const blank = { cwd: '/tmp/empty', hasConversation: false };
    fs.writeFileSync(path.join(empty, 'meta.json'), JSON.stringify(blank));
    assert.equal(cursorSession('/tmp/empty', root), false);
    const projects = path.join(root, 'projects');
    const dir = path.join(projects, cwd.split(path.sep).join('-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session.jsonl'), '{}\n');
    assert.equal(claudeSession(cwd, projects), true);
    assert.equal(claudeSession('/tmp/other', projects), false);
    const cursor = AGENTS.find((row) => row.id === 'cursor');
    const row = { id: 'cursor', spec: cursor };
    const jobs = [{ cliId: 'cursor', action: 'run' }];
    assert.equal(hasAgentSession(row, '/nowhere', jobs), true);
    const login = [{ cliId: 'cursor', action: 'login' }];
    assert.equal(hasAgentSession(row, '/nowhere', login), false);
    const probe = { cursor: (dirPath) => cursorSession(dirPath, root) };
    assert.equal(hasAgentSession(row, cwd, [], probe), true);
    const bare = { id: 'cursor', spec: { resume: [] } };
    assert.equal(hasAgentSession(bare, cwd, jobs, probe), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('starting an agent asks to continue or start new', async () => {
  const { dir, env } = fakePath('cursor-agent');
  const { ui, repo } = openUi();
  try {
    ui.agents.listModels = async () => [];
    ui.agents.refresh(env);
    await ui.agents.open();
    const at = ui.agents.rows().findIndex((row) => row.id === 'cursor');
    ui.nav.agentCursor = at;
    ui.agents.sessionKnown = () => true;
    const calls = [];
    ui.agents.spawn = (cwd, launch) => {
      calls.push(launch);
      return { kill() {} };
    };
    ui.agents.start();
    assert.equal(calls.length, 0);
    assert.equal(ui.mode, 'confirmSession');
    ui.draw();
    const prompt = stripAnsi(ui.lastFrame.rows.at(-2));
    assert.match(prompt, /session\? {2}continue {2}new session/);
    ui.handleEvent({ type: 'key', key: 'escape' });
    assert.equal(ui.mode, 'review');
    assert.equal(calls.length, 0);
    ui.agents.start();
    ui.handleEvent({ type: 'key', key: 'n' });
    assert.equal(ui.mode, 'review');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.includes('--continue'), false);
    ui.handleEvent({ type: 'key', key: 'escape' });
    const started = ui.agents.jobs.find((job) => job.status === 'running');
    started.status = 'exit 0';
    started.child = null;
    started.session = '2fa698ba-9a19-4a84-8134-5a7cd9ec2c56';
    ui.agents.start();
    assert.equal(ui.mode, 'confirmSession');
    ui.handleEvent({ type: 'key', key: 'c' });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].args[0], '--trust');
    assert.equal(calls[1].args[1], '--continue');
    assert.equal(calls[1].session, started.session);
    assert.match(calls[1].command, /--continue/);
    assert.match(calls[1].prompt, /repair plan/);
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run output yields the session, files, and tokens', () => {
  const sessionId = '2fa698ba-9a19-4a84-8134-5a7cd9ec2c56';
  const text = [
    'total tokens: 1,234',
    '8 files edited',
    `To resume this session: agent --resume=${sessionId}`,
  ].join('\n');
  assert.deepEqual(runStats(text), {
    session: sessionId,
    files: 8,
    tokens: 1234,
  });
  const usage = '{"input_tokens": 10, "output_tokens": 5}';
  assert.equal(runStats(usage).tokens, 15);
  assert.deepEqual(runStats('hello'), {});
});

test('legacy .reslop runs move into .plan', async () => {
  const { dir, env } = fakePath('claude');
  const { ui, repo } = openUi();
  try {
    ui.agents.listModels = async () => [];
    ui.agents.refresh(env);
    const legacy = {
      id: 4,
      cliId: 'claude',
      name: 'claude',
      model: 'sonnet',
      cmd: '/bin/claude',
      args: [],
      command: 'claude plan',
      plan: '.plan/a.md',
      action: 'run',
      status: 'exit 0',
      exit: 0,
      output: 'done\n',
      startedAt: 1000,
      endedAt: 4000,
    };
    const prefs = { agents: { claude: { model: 'sonnet' } }, runs: [legacy] };
    const file = path.join(repo.dir, '.reslop');
    fs.writeFileSync(file, `${JSON.stringify(prefs, null, 2)}\n`);
    ui.agents.loadRuns();
    assert.equal(ui.agents.jobs.length, 1);
    assert.equal(ui.agents.jobs[0].status, 'exit 0');
    assert.equal(ui.agents.jobs[0].elapsed(), '0:03');
    const runs = JSON.parse(
      fs.readFileSync(path.join(repo.dir, '.plan', '.runs'), 'utf8'),
    );
    assert.equal(runs[0].exit, 0);
    assert.equal(runs[0].status, undefined);
    assert.equal(runs[0].elapsed, 3);
    assert.equal(runs[0].endedAt, undefined);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.runs, undefined);
    assert.equal(saved.agents.claude.model, 'sonnet');
  } finally {
    ui.agents.reset();
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
