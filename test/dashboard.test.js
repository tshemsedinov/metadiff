'use strict';

const nodeTest = require('node:test');
const { test } = nodeTest;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const runs = require('../lib/runs.js');
const { createTracker, startRun, readRuns, settleRecord } = runs;
const { summarizeDocument, isRunsRel, commandLabel } = runs;
const tree = require('../lib/dashboard/tree.js');
const { FileIndex, folderOf, extOf } = tree;
const gitInfo = require('../lib/dashboard/git.js');
const { readGitSummary, parseTrack, countFixups } = gitInfo;
const dashModel = require('../lib/dashboard/model.js');
const { scriptName, runName } = dashModel;
const npmInfo = require('../lib/dashboard/npm.js');
const { readNpmSummary } = npmInfo;
const tiles = require('../lib/render/tiles.js');
const { layoutTiles, GAP_X, GAP_Y, seg } = tiles;
const dashTable = require('../lib/render/dash-table.js');
const { cell, flexCell, tableLines, stat, pairRows, ago } = dashTable;
const { labelOf, pickGroups, withTitle, titleAside } = dashTable;
const activity = require('../lib/render/dash-activity.js');
const { runMetrics, branchesBlock } = activity;
const dashBlocks = require('../lib/render/dash-blocks.js');
const { filesBlock, npmBlock } = dashBlocks;
const dashboardRender = require('../lib/render/dashboard.js');
const { TILES, paintBodyDashboard } = dashboardRender;
const dashboardSession = require('../lib/session/dashboard.js');
const { classify, ageDelay } = dashboardSession;
const watch = require('../lib/session/watch.js');
const { createDiskWatcher, UNKNOWN_PATH } = watch;
const keys = require('../lib/keys.js');
const { actionFromKey, DASH_BLOCKS } = keys;
const session = require('../lib/session.js');
const { Session } = session;
const git = require('../lib/git.js');
const { createGitRepo } = git;
const ansi = require('../lib/ansi.js');
const { stripAnsi } = ansi;
const helpers = require('./helpers.js');
const { makeRepo, tempDir } = helpers;

const wait = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const waitUntil = async (check, ms = 3000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (check()) return true;
    await wait(25);
  }
  return false;
};

const PASS = '✔ ok (1ms)';

test('the tracker counts passing and failing test lines', () => {
  const tracker = createTracker();
  tracker.feed(`${PASS}\n✖ broken (1ms)\nplain\n✔ half`);
  assert.equal(tracker.progress.done, 1);
  assert.equal(tracker.progress.failed, 1);
  assert.equal(tracker.progress.lines, 3);
  tracker.feed(' done (1ms)\n');
  assert.equal(tracker.progress.done, 2);
});

test('command labels use the program base name', () => {
  assert.equal(commandLabel('/usr/bin/node', ['--test']), 'node --test');
  assert.ok(isRunsRel('.log/.runs/1-2.json'));
  assert.ok(isRunsRel('.log/.runs'));
  assert.ok(!isRunsRel('.log/other.md'));
});

test('a run record is written, updated, finished and read back', () => {
  const dir = tempDir('reslop-runs-');
  try {
    let now = 1000;
    const clock = () => now;
    const run = startRun(dir, 'node --test', { now: clock });
    const [live] = readRuns(dir);
    assert.equal(live.status, 'running');
    assert.equal(live.command, 'node --test');
    now += 500;
    run.feed(`${PASS}\n${PASS}\n`);
    assert.equal(readRuns(dir)[0].progress.done, 2);
    now += 500;
    run.finish(0, { tests: 2 });
    const [done] = readRuns(dir);
    assert.equal(done.status, 'passed');
    assert.equal(done.exit, 0);
    assert.equal(done.result.tests, 2);
    assert.equal(done.endedAt, 2000);
    now += 1000;
    const second = startRun(dir, 'node --test', { now: clock });
    assert.ok(second.id);
    const expected = readRuns(dir).find((r) => r.status === 'running');
    assert.equal(expected.progress.expected, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a running record with a dead process is reported as aborted', () => {
  const record = { status: 'running', pid: 1 };
  assert.equal(settleRecord(record, () => false).status, 'aborted');
  assert.equal(settleRecord(record, () => true).status, 'running');
  const passed = { status: 'passed', pid: 1 };
  assert.equal(settleRecord(passed, () => false).status, 'passed');
});

const scriptEnv = (name) => {
  const env = {};
  env['npm_lifecycle_event'] = name;
  return env;
};

test('a run records the npm script that started it', () => {
  const dir = tempDir('reslop-runs-');
  try {
    const run = startRun(dir, 'node --test', { env: scriptEnv('test') });
    assert.equal(readRuns(dir)[0].script, 'test');
    run.finish(0);
    const lint = startRun(dir, 'eslint . --fix', { env: scriptEnv('fix') });
    const runs = readRuns(dir);
    const saved = runs.find((item) => item.command.startsWith('eslint'));
    assert.equal(saved.script, 'fix');
    lint.finish(0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed run keeps its exit code', () => {
  const dir = tempDir('reslop-runs-');
  try {
    const run = startRun(dir, 'eslint .');
    run.finish(2);
    const [record] = readRuns(dir);
    assert.equal(record.status, 'failed');
    assert.equal(record.exit, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('summarizeDocument sums the report summaries', () => {
  const doc = {
    reports: [
      {
        tool: 'test',
        problems: [{}, {}],
        summary: { tests: 3, passed: 2, failed: 1, duration: '4ms' },
      },
      { tool: 'eslint', problems: [], summary: { errors: 0 } },
    ],
  };
  const sum = summarizeDocument(doc);
  assert.deepEqual(sum.tools, ['test', 'eslint']);
  assert.equal(sum.tests, 3);
  assert.equal(sum.failed, 1);
  assert.equal(sum.errors, 0);
  assert.equal(sum.problems, 2);
  assert.equal(summarizeDocument(null), null);
});

test('folder and extension helpers group root files', () => {
  assert.equal(folderOf('lib/a/b.js'), 'lib');
  assert.equal(folderOf('a.js'), tree.ROOT_DIR);
  assert.equal(extOf('lib/a.test.js'), '.js');
  assert.equal(extOf('Makefile'), tree.NO_EXT);
});

test('FileIndex sizes files per folder and per extension', async () => {
  const repo = makeRepo();
  try {
    repo.write('lib/a.js', 'one\ntwo\n');
    repo.write('lib/b.md', 'x\n');
    repo.write('top.js', 'a\n');
    repo.write('.gitignore', 'skip/\n');
    repo.write('skip/c.js', 'ignored\n');
    const index = new FileIndex(repo.dir);
    await index.rescan();
    const { total, dirs, exts } = index.summary();
    assert.equal(total.files, 4);
    const lib = dirs.find((d) => d.key === 'lib');
    assert.equal(lib.files, 2);
    assert.equal(lib.lines, 3);
    const js = exts.find((e) => e.key === '.js');
    assert.equal(js.files, 2);
    assert.ok(!dirs.some((d) => d.key === 'skip'));
    assert.equal(index.sizeOf('lib/a.js'), 8);
  } finally {
    repo.cleanup();
  }
});

test('FileIndex touch applies edits, additions and removals', async () => {
  const repo = makeRepo();
  try {
    repo.write('a.js', 'one\n');
    const index = new FileIndex(repo.dir);
    await index.rescan();
    const before = index.summary().total;
    assert.equal(before.lines, 1);
    repo.write('a.js', 'one\ntwo\nthree\n');
    assert.equal(await index.touch(['a.js']), true);
    assert.equal(index.summary().total.lines, 3);
    assert.ok(index.hot(Date.now()).exts.has('.js'));
    repo.write('lib/n.js', 'x\n');
    await index.touch(['lib/n.js']);
    assert.equal(index.summary().total.files, 2);
    fs.rmSync(path.join(repo.dir, 'a.js'));
    await index.touch(['a.js']);
    assert.equal(index.summary().total.files, 1);
    assert.equal(await index.touch(['a.js']), false);
  } finally {
    repo.cleanup();
  }
});

test('FileIndex ignores node_modules and git internals on touch', async () => {
  const repo = makeRepo();
  try {
    repo.write('a.js', 'one\n');
    const index = new FileIndex(repo.dir);
    await index.rescan();
    repo.write('node_modules/x/i.js', 'z\n');
    await index.touch(['node_modules/x/i.js', '.git/HEAD']);
    assert.equal(index.summary().total.files, 1);
  } finally {
    repo.cleanup();
  }
});

test('git summary parts parse tracking and fixups', () => {
  assert.deepEqual(parseTrack('[ahead 2, behind 1]'), {
    ahead: 2,
    behind: 1,
    gone: false,
  });
  assert.equal(parseTrack('[gone]').gone, true);
  assert.equal(countFixups('fixup! a\nplain\nsquash! b\namend! c'), 3);
});

test('readGitSummary reports commits, branches and pushed state', async () => {
  const repo = makeRepo();
  try {
    repo.write('a.js', 'one\n');
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'first']);
    repo.write('a.js', 'two\n');
    repo.git(['commit', '-am', 'fixup! first']);
    repo.git(['branch', 'topic']);
    const summary = await readGitSummary(repo.dir);
    assert.equal(summary.branch, 'main');
    assert.equal(summary.commits.total, 2);
    assert.equal(summary.commits.fixups, 1);
    assert.equal(summary.commits.pushed, null);
    assert.equal(summary.commits.last.subject, 'fixup! first');
    assert.equal(summary.commits.recent[0].subject, 'fixup! first');
    assert.equal(summary.commits.recent[1].subject, 'first');
    assert.equal(summary.rebase, null);
    const names = summary.branches.map((b) => b.name).sort();
    assert.deepEqual(names, ['main', 'topic']);
    assert.ok(summary.branches.find((b) => b.name === 'main').current);
  } finally {
    repo.cleanup();
  }
});

test('readGitSummary splits pushed from unpushed commits', async () => {
  const origin = makeRepo();
  const clone = makeRepo();
  try {
    origin.write('a.js', 'one\n');
    origin.git(['add', '.']);
    origin.git(['commit', '-m', 'first']);
    clone.git(['remote', 'add', 'origin', origin.dir]);
    clone.git(['fetch', 'origin']);
    clone.git(['reset', '--hard', 'origin/main']);
    clone.git(['branch', '--set-upstream-to=origin/main', 'main']);
    clone.write('b.js', 'x\n');
    clone.git(['add', '.']);
    clone.git(['commit', '-m', 'local']);
    const summary = await readGitSummary(clone.dir);
    assert.equal(summary.commits.total, 2);
    assert.equal(summary.commits.unpushed, 1);
    assert.equal(summary.commits.pushed, 1);
    const main = summary.branches.find((b) => b.name === 'main');
    assert.equal(main.ahead, 1);
    assert.equal(main.behind, 0);
  } finally {
    origin.cleanup();
    clone.cleanup();
  }
});

test('readGitSummary survives a repository without commits', async () => {
  const repo = makeRepo();
  try {
    const summary = await readGitSummary(repo.dir);
    assert.equal(summary.commits.total, 0);
    assert.equal(summary.commits.last, null);
    assert.deepEqual(summary.commits.recent, []);
  } finally {
    repo.cleanup();
  }
});

test('readNpmSummary counts dependencies, scripts and modules', async () => {
  const dir = tempDir('reslop-npm-');
  try {
    const manifest = {
      name: 'demo',
      scripts: { test: 'node --test', lint: 'eslint .' },
      dependencies: { a: '1' },
      devDependencies: { b: '1', c: '1' },
    };
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
    const modules = path.join(dir, 'node_modules');
    fs.mkdirSync(path.join(modules, 'a'), { recursive: true });
    fs.writeFileSync(path.join(modules, 'a', 'i.js'), '12345');
    fs.mkdirSync(path.join(modules, 'big'), { recursive: true });
    fs.writeFileSync(path.join(modules, 'big', 'i.js'), '123456789');
    const scoped = path.join(modules, '@scope', 'pkg');
    fs.mkdirSync(scoped, { recursive: true });
    fs.writeFileSync(path.join(scoped, 'i.js'), '123456');
    const summary = await readNpmSummary(dir, null);
    assert.equal(summary.hasManifest, true);
    assert.equal(summary.name, 'demo');
    assert.equal(summary.deps, 1);
    assert.equal(summary.dev, 2);
    assert.ok(summary.scripts.length >= 2);
    assert.equal(summary.modules.bytes, 20);
    assert.equal(summary.modules.count, 3);
    assert.deepEqual(summary.modules.packages, [
      { name: 'big', bytes: 9 },
      { name: '@scope/pkg', bytes: 6 },
      { name: 'a', bytes: 5 },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readNpmSummary reports a project without a manifest', async () => {
  const dir = tempDir('reslop-npm-');
  try {
    const summary = await readNpmSummary(dir, null);
    assert.equal(summary.hasManifest, false);
    assert.equal(summary.deps, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('classify sorts watcher paths into refresh groups', () => {
  const found = classify([
    'lib/a.js',
    '.git/HEAD',
    '.git/objects/ab',
    '.log/.runs/1-2.json',
    'package.json',
  ]);
  assert.deepEqual(found.files, ['lib/a.js', 'package.json']);
  assert.equal(found.git, true);
  assert.equal(found.runs, true);
  assert.equal(found.npm, true);
  assert.equal(found.all, false);
  assert.equal(classify([UNKNOWN_PATH]).all, true);
});

test('the age label refreshes slower as commits get older', () => {
  assert.equal(ageDelay(1000), 1000);
  assert.equal(ageDelay(10 * 60000), 30000);
  assert.equal(ageDelay(5 * 3600000), 600000);
});

test('the disk watcher reports changed paths and run records', async () => {
  const dir = tempDir('reslop-watch-');
  await wait(20);
  const seen = new Set();
  let changes = 0;
  const watcher = createDiskWatcher({
    root: dir,
    debounceMs: 30,
    onChange: () => {
      changes += 1;
    },
    onPaths: (paths) => {
      for (const rel of paths) seen.add(rel);
    },
  });
  try {
    await wait(50);
    fs.writeFileSync(path.join(dir, 'a.js'), 'x\n');
    assert.ok(await waitUntil(() => seen.has('a.js')));
    assert.ok(changes >= 1);
    const before = changes;
    fs.mkdirSync(path.join(dir, '.log', '.runs'), { recursive: true });
    await wait(60);
    fs.writeFileSync(path.join(dir, '.log', '.runs', '1-2.json'), '{}');
    assert.ok(await waitUntil(() => seen.has('.log/.runs/1-2.json')));
    await wait(120);
    assert.equal(changes, before);
  } finally {
    watcher.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const sampleTiles = () =>
  ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id, rank) => ({
    id,
    key: id,
    title: id,
    rank,
  }));

test('layoutTiles fills the width and keeps the gaps', () => {
  const bands = layoutTiles(120, 40, sampleTiles());
  const shown = bands.flatMap((band) => band.tiles);
  assert.equal(shown.length, 7);
  assert.ok(bands.length >= 2);
  const first = bands[0];
  const last = first.tiles.at(-1);
  assert.equal(last.x + last.w, 120);
  const [left, right] = first.tiles;
  assert.equal(right.x - (left.x + left.w), GAP_X);
  assert.equal(bands[1].y - (first.y + first.h), GAP_Y);
});

test('layoutTiles drops the least important tiles when short', () => {
  const bands = layoutTiles(80, 14, sampleTiles());
  const ids = bands.flatMap((band) => band.tiles.map((tile) => tile.id));
  assert.ok(ids.length < 7);
  assert.ok(ids.includes('a'));
  assert.ok(!ids.includes('g'));
});

test('layoutTiles stacks tiles in one column on a narrow terminal', () => {
  const bands = layoutTiles(40, 60, sampleTiles());
  for (const band of bands) assert.equal(band.tiles.length, 1);
});

test('the dashboard tiles keep the canonical order and hotkeys', () => {
  const ids = TILES.map((tile) => tile.id);
  assert.deepEqual(ids, [
    'files',
    'diffs',
    'commits',
    'branches',
    'npm',
    'run',
    'tasks',
  ]);
  assert.deepEqual(
    TILES.map((tile) => tile.key),
    ['f', 'd', 'c', 'b', 'n', 'r', 't'],
  );
});

test('the dashboard pane without a model paints blank', () => {
  const result = paintBodyDashboard({ dashboard: null }, 60, false, 10, 1);
  assert.equal(result.body.length, 10);
});

test('dashboard hotkeys map to their blocks', () => {
  const pairs = { f: 'files', d: 'diffs', c: 'commits', b: 'branches' };
  for (const [key, block] of Object.entries(pairs)) {
    const action = actionFromKey(key, 'dashboard');
    assert.equal(DASH_BLOCKS[action], block);
  }
  assert.equal(DASH_BLOCKS[actionFromKey('n', 'dashboard')], 'npm');
  assert.equal(DASH_BLOCKS[actionFromKey('r', 'dashboard')], 'run');
  assert.equal(DASH_BLOCKS[actionFromKey('t', 'dashboard')], 'tasks');
});

const openDashboard = async (rows = 40, columns = 120) => {
  const repo = makeRepo();
  repo.write('lib/a.js', 'one\ntwo\n');
  repo.write('package.json', '{"name":"demo","scripts":{"test":"true"}}');
  repo.git(['add', '.']);
  repo.git(['commit', '-m', 'first commit']);
  repo.write('lib/a.js', 'one\ntwo\nthree\n');
  const stdout = {
    isTTY: false,
    columns,
    rows,
    write: () => true,
  };
  const ui = new Session({
    cwd: repo.dir,
    stdout,
    repo: createGitRepo(),
    color: false,
    startPane: 'dashboard',
  });
  ui.ensureRepo();
  await ui.loadReady();
  ui.uiOpen = true;
  ui.lifecycle.startWatch();
  ui.dashboard.start();
  const close = () => {
    ui.lifecycle.stopWatch();
    ui.dashboard.stop();
    repo.cleanup();
  };
  return { ui, repo, close };
};

const frameText = (ui) => {
  ui.draw();
  return stripAnsi(ui.lastFrame.rows.join('\n'));
};

test('a dashboard session shows every block with live data', async () => {
  const { ui, close } = await openDashboard();
  try {
    assert.equal(ui.pane, 'dashboard');
    assert.ok(await waitUntil(() => /first commit/.test(frameText(ui))));
    const text = frameText(ui);
    for (const title of ['files', 'diffs', 'commits', 'branches', 'npm']) {
      assert.match(text, new RegExp(`${title}`));
    }
    assert.match(text, /run/);
    assert.match(text, /tasks/);
    assert.match(text, /main/);
    assert.match(text, /\+0\/1/);
    assert.match(text, /📁\s+lib/);
  } finally {
    close();
  }
});

test('the dashboard follows files changing on disk', async () => {
  const { ui, repo, close } = await openDashboard();
  try {
    assert.ok(await waitUntil(() => /first commit/.test(frameText(ui))));
    const before = ui.dashboard.view().files.total.lines;
    repo.write('lib/a.js', 'one\ntwo\nthree\nfour\nfive\nsix\n');
    const grew = () => ui.dashboard.view().files.total.lines > before;
    assert.ok(await waitUntil(grew));
  } finally {
    close();
  }
});

test('the dashboard shows a run by script name', async () => {
  const { ui, repo, close } = await openDashboard();
  try {
    assert.ok(await waitUntil(() => /first commit/.test(frameText(ui))));
    const run = startRun(repo.dir, 'node --test', { env: scriptEnv('test') });
    run.feed(`${PASS}\n`);
    const seen = () => {
      const text = frameText(ui);
      const runs = ui.dashboard.view().runs;
      const listed = runs.some((item) => item.name === 'test');
      const hidden = !text.includes('node --test');
      return listed && text.includes('test') && hidden;
    };
    assert.ok(await waitUntil(seen));
    run.finish(0, null);
    const finished = () => ui.dashboard.view().runs.length > 0;
    assert.ok(await waitUntil(finished));
  } finally {
    close();
  }
});

const press = (ui, key) => ui.handleEvent({ type: 'key', key });

test('hotkeys open screens and Esc returns to the dashboard', async () => {
  const { ui, close } = await openDashboard();
  try {
    press(ui, 'c');
    assert.equal(ui.pane, 'commits');
    press(ui, 'escape');
    assert.equal(ui.pane, 'dashboard');
    press(ui, 'b');
    assert.equal(ui.pane, 'branches');
    press(ui, 'escape');
    assert.equal(ui.pane, 'dashboard');
    press(ui, 'n');
    assert.equal(ui.pane, 'npm');
    press(ui, 'escape');
    assert.equal(ui.pane, 'dashboard');
    press(ui, 'f');
    assert.equal(ui.pane, 'files');
    press(ui, 'escape');
    assert.equal(ui.pane, 'dashboard');
    press(ui, 'd');
    assert.equal(ui.pane, 'files');
    press(ui, 'escape');
    assert.equal(ui.pane, 'dashboard');
    press(ui, 't');
    assert.equal(ui.nav.tasksOpen, true);
    press(ui, 'escape');
    assert.equal(ui.pane, 'dashboard');
    assert.equal(ui.nav.tasksOpen, false);
  } finally {
    close();
  }
});

test('Esc on the dashboard quits', async () => {
  const { ui, close } = await openDashboard();
  try {
    let quit = 0;
    ui.onQuit = () => {
      quit += 1;
    };
    press(ui, 'escape');
    assert.equal(quit, 1);
  } finally {
    close();
  }
});

test('other keys do nothing on the dashboard', async () => {
  const { ui, close } = await openDashboard();
  try {
    for (const key of ['j', 'k', 'down', 'up', 's', 'u', 'x']) press(ui, key);
    assert.equal(ui.pane, 'dashboard');
  } finally {
    close();
  }
});

test('the footer offers the block buttons and opens screens', async () => {
  const { ui, close } = await openDashboard();
  try {
    ui.draw();
    const ids = ui.lastFrame.buttons.map((button) => button.id);
    for (const id of ['dashFiles', 'dashDiffs', 'dashCommits', 'dashTasks']) {
      assert.ok(ids.includes(id), id);
    }
    const hit = ui.lastFrame.buttons.find((b) => b.id === 'dashCommits');
    const y = ui.lastFrame.height;
    const at = { x: hit.x0 + 1, y, btn: 0, button: 0 };
    ui.handleEvent({ type: 'mouse', kind: 'press', press: true, ...at });
    ui.handleEvent({ type: 'mouse', kind: 'release', press: false, ...at });
    assert.equal(ui.pane, 'commits');
  } finally {
    close();
  }
});

test('a click on a tile opens its screen', async () => {
  const { ui, close } = await openDashboard();
  try {
    ui.draw();
    const hit = ui.lastFrame.fileHits.find((h) => h.cursor === 'branches');
    assert.ok(hit);
    const at = { x: hit.x0 + 2, y: hit.y, btn: 0, button: 0 };
    ui.handleEvent({ type: 'mouse', kind: 'press', press: true, ...at });
    ui.handleEvent({ type: 'mouse', kind: 'release', press: false, ...at });
    assert.equal(ui.pane, 'branches');
  } finally {
    close();
  }
});

test('the dashboard stays responsive on a tiny terminal', async () => {
  const { ui, close } = await openDashboard(8, 30);
  try {
    const text = frameText(ui);
    assert.ok(text.length > 0);
    assert.equal(ui.lastFrame.rows.length, 8);
  } finally {
    close();
  }
});

test('the dashboard paints color tiles on a black page', async () => {
  const { ui, close } = await openDashboard();
  try {
    ui.color = true;
    ui.draw();
    const raw = ui.lastFrame.rows.join('\n');
    assert.ok(raw.includes('\x1b['));
  } finally {
    close();
  }
});

test('a session started without a screen keeps the files pane', () => {
  const repo = makeRepo();
  try {
    const stdout = { isTTY: false, columns: 80, rows: 20, write: () => true };
    const ui = new Session({
      cwd: repo.dir,
      stdout,
      repo: createGitRepo(),
      color: false,
    });
    assert.equal(ui.pane, 'files');
    assert.equal(ui.dashboardHome, false);
  } finally {
    repo.cleanup();
  }
});

test('blocks are 2 columns apart and 1 row apart', () => {
  assert.equal(GAP_X, 2);
  assert.equal(GAP_Y, 1);
});

test('the dashboard pads below the header and above the footer', async () => {
  const { ui, close } = await openDashboard();
  try {
    assert.ok(await waitUntil(() => /first commit/.test(frameText(ui))));
    ui.draw();
    const rows = ui.lastFrame.rows.map((row) => stripAnsi(row));
    assert.equal(rows[1].trim(), '');
    assert.match(rows[2], /files/);
    const footer = rows.findIndex((row) => /^ files {2}diffs/.test(row));
    assert.ok(footer > 2);
    assert.equal(rows[footer - 2].trim(), '');
  } finally {
    close();
  }
});

test('block captions have no key prefix and a lighter header', async () => {
  const { ui, close } = await openDashboard();
  try {
    ui.color = true;
    ui.draw();
    const raw = ui.lastFrame.rows[2];
    const plain = stripAnsi(raw);
    assert.match(plain, /^ files/);
    assert.ok(!plain.includes('f files'));
    const head = ansi.THEME.dashHeadBg.join(';');
    assert.ok(raw.includes(`48;2;${head}m`));
  } finally {
    close();
  }
});

test('table rows alternate a darker background on even lines', async () => {
  const { ui, close } = await openDashboard();
  try {
    ui.color = true;
    ui.draw();
    const colorOf = (row) => {
      const found = ui.lastFrame.rows[row].match(/48;2;(\d+;\d+;\d+)m/g);
      return new Set(found);
    };
    const odd = ansi.THEME.dashTileBg.join(';');
    const even = ansi.THEME.dashRowBg.join(';');
    assert.ok(colorOf(3).has(`48;2;${odd}m`));
    assert.ok(colorOf(4).has(`48;2;${even}m`));
    assert.ok(colorOf(5).has(`48;2;${odd}m`));
  } finally {
    close();
  }
});

test('diff columns line up across rows', () => {
  const rows = [
    [cell('total'), cell('38', 'text', 'r'), cell('+0/3752', 'add', 'r')],
    [cell('lib/'), cell('3', 'text', 'r'), cell('+0/741', 'add', 'r')],
  ];
  const lines = tableLines(rows, 40).map((line) =>
    line.map((item) => item.text).join(''),
  );
  assert.equal(lines[0].indexOf('+0/3752') + 7, lines[1].indexOf('+0/741') + 6);
  assert.equal(lines[0].length, lines[1].length);
});

test('a flexible middle column takes the free width', () => {
  const rows = [
    [cell('a'), flexCell('long text here', 'text'), cell('1', 'text', 'r')],
    [cell('b'), flexCell('x', 'text'), cell('22', 'text', 'r')],
  ];
  const lines = tableLines(rows, 20).map((line) =>
    line.map((item) => item.text).join(''),
  );
  assert.equal(lines[0].length, 20);
  assert.equal(lines[1].length, 20);
  assert.ok(lines[0].endsWith(' 1'));
  assert.ok(lines[1].endsWith('22'));
});

test('the root folder is labeled with a slash', () => {
  assert.equal(labelOf('.', true), '/');
  assert.equal(labelOf('lib', true), 'lib');
  assert.equal(labelOf('.js', false), '*.js');
  assert.equal(labelOf('(none)', false), '(none)');
});

test('the files share bar stays on a narrow tile', () => {
  const model = {
    files: {
      ready: true,
      total: { files: 4, bytes: 80, lines: 12 },
      dirs: [{ key: 'lib', files: 2, bytes: 40, lines: 8 }],
      exts: [{ key: '.js', files: 4, bytes: 80, lines: 12 }],
      hot: { dirs: new Set(), exts: new Set() },
      delta: null,
    },
  };
  const tile = { key: 'f', title: 'files' };
  const block = filesBlock(model, 36, 8, { now: 1 }, tile);
  const text = (line) => line.map((part) => part.text).join('');
  const header = text(block.titleLine);
  const folder = text(block.lines[0]);
  const ext = text(block.lines[1]);
  assert.match(header, /size/);
  assert.match(header, /lines/);
  assert.match(folder, /📁\s+lib/);
  assert.equal(ext.indexOf('*.js'), folder.indexOf('lib'));
  assert.equal(folder.includes('📄'), false);
  assert.match(ext, /\*\.js/);
  assert.equal(ext.includes('📄'), false);
  assert.match(folder, /[█░]/);
  assert.equal(folder.length, 36);
});

test('groups list folders before extensions', () => {
  const folders = ['a', 'b', 'c'];
  const exts = ['js', 'md'];
  const picked = pickGroups(folders, exts, 2);
  assert.deepEqual(picked.dirs, ['a', 'b']);
  assert.deepEqual(picked.exts, []);
  const rest = pickGroups(folders, exts, 4);
  assert.deepEqual(rest.dirs, folders);
  assert.deepEqual(rest.exts, ['js']);
});

test('header totals share columns with the rows beneath', () => {
  const tile = { key: 'f', title: 'files' };
  const rows = [
    [cell(' lib/'), cell('3', 'text', 'r'), cell('800', 'text', 'r')],
    [cell(' .js'), cell('9', 'text', 'r'), cell('20', 'text', 'r')],
  ];
  const head = [cell('12', 'text', 'r', true), cell('820', 'text', 'r', true)];
  const block = withTitle(tile, head, rows, 32);
  const text = (line) => line.map((item) => item.text).join('');
  const header = text(block.titleLine);
  const folder = text(block.lines[0]);
  const ext = text(block.lines[1]);
  const end = (line, value) => line.indexOf(value) + value.length;
  assert.equal(header.startsWith('files'), true);
  assert.equal(end(header, '12'), end(folder, '3'));
  assert.equal(end(header, '12'), end(ext, '9'));
  assert.equal(end(header, '820'), end(folder, '800'));
});

test('the branches header shows the local count', () => {
  const tile = { key: 'b', title: 'branches' };
  const entry = (name, current) => ({
    name,
    current,
    at: 1,
    subject: name,
    ahead: 0,
    behind: 0,
    upstream: '',
    gone: false,
  });
  const model = {
    branches: {
      ready: true,
      list: [entry('main', true), entry('next', false)],
      rebase: null,
      switches: [],
      hot: new Map(),
    },
  };
  const ctx = { now: 10, frame: 0 };
  const block = branchesBlock(model, 32, 6, ctx, tile);
  const header = block.titleLine.map((part) => part.text).join('');
  assert.equal(header.startsWith('branches'), true);
  assert.equal(header.endsWith('2'), true);
});

test('the npm tile lists the largest packages under the disk size', () => {
  const tile = { key: 'n', title: 'npm' };
  const model = {
    npm: {
      ready: true,
      hasManifest: true,
      deps: 1,
      dev: 0,
      optional: 0,
      modules: {
        bytes: 20,
        count: 2,
        packages: [
          { name: 'big', bytes: 14 },
          { name: 'small', bytes: 6 },
        ],
      },
      audit: 0,
      outdated: 0,
      proposals: 0,
      running: '',
      changedAt: 0,
    },
  };
  const block = npmBlock(model, 36, 8, { now: 1, frame: 0 }, tile);
  const text = (line) => line.map((part) => part.text).join('');
  const header = text(block.titleLine);
  const body = block.lines.map(text).join('\n');
  assert.equal(header.startsWith('npm'), true);
  assert.equal(header.endsWith('20b'), true);
  assert.ok(body.indexOf('big') < body.indexOf('small'));
  assert.match(body, /14b/);
  assert.match(body, /6b/);
});

test('a title aside sits on the right of the header', () => {
  const tile = { key: 'c', title: 'commits' };
  const line = titleAside(tile, [seg('12', 'text', true)], 20);
  const text = line.map((item) => item.text).join('');
  assert.equal(text.length, 20);
  assert.equal(text.startsWith('commits'), true);
  assert.equal(text.endsWith('12'), true);
});

test('dashboard ages stay at minutes', () => {
  const now = 1_000_000;
  assert.equal(ago(now - 5000, now), '<1m ago');
  assert.equal(ago(now - 45 * 1000, now), '<1m ago');
  assert.equal(ago(now - 30 * 60 * 1000, now), '30m ago');
  assert.equal(ago(now - 3 * 3600 * 1000, now), '3h ago');
});

const metricText = (cells) =>
  cells.map((item) => item.segs.map((part) => part.text).join('')).join('|');

test('run rows show completed, passed and failed counts', () => {
  const passed = runMetrics({
    status: 'passed',
    source: 'reslop t',
    result: { tests: 10, passed: 8, failed: 2 },
  });
  assert.equal(metricText(passed), '10 done|8 ok|2 fail');
  assert.equal(passed[2].align, 'r');
  const live = runMetrics({
    status: 'running',
    source: 'reslop t',
    done: 3,
    failed: 1,
    result: null,
  });
  assert.equal(metricText(live), '4 done|3 ok|1 fail');
  const failed = runMetrics({
    status: 'failed',
    source: 'reslop t',
    exit: 1,
    result: null,
    done: 0,
    failed: 0,
  });
  assert.equal(metricText(failed).includes('exit'), false);
});

test('run names prefer the npm script over the command', () => {
  assert.equal(scriptName('npm run test'), 'test');
  assert.equal(scriptName('npm run -s lint'), 'lint');
  assert.equal(scriptName('npm test'), 'test');
  assert.equal(scriptName('/usr/bin/eslint .'), 'eslint');
  assert.equal(runName({ command: 'node --test', script: 'test' }), 'test');
  const nested = { command: 'npm run -s lint', script: 'test' };
  assert.equal(runName(nested), 'test');
  assert.equal(runName({ command: 'eslint .', script: 'lint' }), 'lint');
  assert.equal(runName({ command: 'node --test', script: '' }), 'node');
});

test('stat pairs become label and value table rows', () => {
  const rows = pairRows([stat('a', '1'), stat('bb', '2'), stat('c', '3')], 2);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].length, 4);
  assert.equal(rows[1].length, 2);
});
