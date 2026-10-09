'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const runs = require('../lib/runs.js');
const { Tracker, RunRecorder, readRuns, settleRecord } = runs;
const { summarizeDocument, isRunsRel, commandLabel } = runs;
const tree = require('../lib/dashboard/tree.js');
const { FileIndex, folderOf, extOf } = tree;
const { readGitSummary, parseTrack } = require('../lib/dashboard/git.js');
const dashModel = require('../lib/dashboard/model.js');
const { scriptName, runName, buildModel, mergeRuns, groupChanges } = dashModel;
const { readNpmSummary } = require('../lib/dashboard/npm.js');
const tiles = require('../lib/render/tiles.js');
const { layoutTiles, GAP_X, GAP_Y, seg, paintTile } = tiles;
const dashTable = require('../lib/render/dash-table.js');
const { cell, flexCell, tableLines, stat, pairRows, ago } = dashTable;
const { labelOf, pickGroups, titleAside } = dashTable;
const activity = require('../lib/render/dash-activity.js');
const { runMetrics, branchesBlock, runsBlock } = activity;
const dashBlocks = require('../lib/render/dash-blocks.js');
const { filesBlock, diffsBlock, npmBlock, npmContent, tasksBlock } = dashBlocks;
const { paintBodyPackages } = require('../lib/render/packages.js');
const { TILES, paintBodyDashboard } = require('../lib/render/dashboard.js');
const dashboardSession = require('../lib/session/dashboard.js');
const { Dashboard, classify, ageDelay } = dashboardSession;
const { DiskWatcher, UNKNOWN_PATH } = require('../lib/session/watch.js');
const { actionFromKey, DASH_BLOCKS } = require('../lib/session/actions.js');
const { Session } = require('../lib/session.js');
const { createGitRepo } = require('../lib/git.js');
const ansi = require('../lib/ansi.js');
const { stripAnsi, visibleWidth } = ansi;
const { makeRepo, tempDir, removeTree } = require('./helpers.js');

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
  const tracker = new Tracker();
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
    const run = new RunRecorder(dir, 'node --test', { now: clock });
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
    const second = new RunRecorder(dir, 'node --test', { now: clock });
    assert.ok(second.record.id);
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
    const run = new RunRecorder(dir, 'node --test', { env: scriptEnv('test') });
    assert.equal(readRuns(dir)[0].script, 'test');
    run.finish(0);
    const lint = new RunRecorder(dir, 'eslint . --fix', {
      env: scriptEnv('fix'),
    });
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
    const run = new RunRecorder(dir, 'eslint .');
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
    assert.equal(index.entries.get('lib/a.js').size, 8);
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

test('git branch tracking is parsed from the upstream track', () => {
  assert.deepEqual(parseTrack('[ahead 2, behind 1]'), {
    ahead: 2,
    behind: 1,
    gone: false,
  });
  assert.equal(parseTrack('[gone]').gone, true);
});

test('readGitSummary reports commits and branches', async () => {
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

test('readGitSummary tracks branches against their upstream', async () => {
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
      devDependencies: { b: '1', c: '1', big: '1' },
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
    const lock = {
      packages: {
        'node_modules/a': { version: '1.2.3' },
        'node_modules/big': { dev: true },
        'node_modules/@scope/pkg': { dev: true },
      },
    };
    const stamp = path.join(modules, '.package-lock.json');
    fs.writeFileSync(stamp, JSON.stringify(lock));
    const summary = await readNpmSummary(dir, null);
    assert.equal(summary.hasManifest, true);
    assert.equal(summary.deps, 1);
    assert.equal(summary.dev, 3);
    const lockBytes = fs.statSync(stamp).size;
    assert.equal(summary.modules.bytes, 20 + lockBytes);
    assert.equal(summary.modules.count, 3);
    assert.deepEqual(summary.modules.packages, [
      {
        name: 'a',
        bytes: 5,
        dev: false,
        transitive: false,
        chain: '',
        version: '1.2.3',
      },
      {
        name: 'big',
        bytes: 9,
        dev: true,
        transitive: false,
        chain: '',
        version: '',
      },
      {
        name: '@scope/pkg',
        bytes: 6,
        dev: false,
        transitive: true,
        chain: '',
        version: '',
      },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readNpmSummary chains transitive packages', async () => {
  const dir = tempDir('reslop-npm-');
  try {
    const manifest = { dependencies: { one: '1' } };
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
    const modules = path.join(dir, 'node_modules');
    for (const name of ['one', 'two', 'three']) {
      fs.mkdirSync(path.join(modules, name), { recursive: true });
      fs.writeFileSync(path.join(modules, name, 'i.js'), name);
    }
    const lock = {
      packages: {
        '': { dependencies: { one: '1' } },
        'node_modules/one': { version: '1.0.0', dependencies: { two: '1' } },
        'node_modules/two': { version: '1.0.0', dependencies: { three: '1' } },
        'node_modules/three': { version: '1.0.0' },
      },
    };
    const stamp = path.join(modules, '.package-lock.json');
    fs.writeFileSync(stamp, JSON.stringify(lock));
    const summary = await readNpmSummary(dir, null);
    const byName = new Map(
      summary.modules.packages.map((row) => [row.name, row]),
    );
    assert.equal(byName.get('one').transitive, false);
    assert.equal(byName.get('one').dev, false);
    assert.equal(byName.get('two').transitive, true);
    assert.equal(byName.get('two').chain, 'one');
    assert.equal(byName.get('three').chain, 'two 🢒 one');
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

const quietDashboard = () => {
  const started = [];
  const stopped = [];
  const timers = [];
  const ui = {
    uiOpen: true,
    nav: { pane: 'dashboard' },
    npm: { lastRun: null },
    progress: {
      start: (id) => started.push(id),
      stop: (id) => stopped.push(id),
    },
    term: {
      later: (name, fn, ms) => timers.push({ name, fn, ms }),
      cancel: () => {},
    },
  };
  const dash = new Dashboard(ui);
  dash.active = true;
  return { dash, started, stopped, timers };
};

test('the current minute blinks for three seconds after activity', () => {
  const { dash } = quietDashboard();
  const now = 5_000_000;
  dash.heat(now, 4);
  assert.equal(dash.liveActivity(now + 2999), true);
  assert.equal(dash.liveActivity(now + 3000), false);
  dash.heat(now + 1000, 1);
  assert.equal(dash.liveActivity(now + 3999), true);
  assert.equal(dash.liveActivity(now + 4000), false);
  dash.mark(now + 2000, 'commit');
  dash.mark(now + 8000, 'commit');
  assert.equal(dash.liveActivity(now + 5000), false);
  dash.heat(now, 2, 9);
  const minute = dash.activityView(now).minutes[0];
  assert.equal(minute.removed > minute.added, true);
  dash.runs = [{ status: 'running', pid: process.pid }];
  assert.equal(dash.liveActivity(now + 20_000), true);
});

test('the blink timer stops the current cell after three seconds', () => {
  const { dash, started, stopped, timers } = quietDashboard();
  const now = Date.now();
  dash.activityAt = now - 1000;
  dash.afterDraw();
  const blink = timers.find((row) => row.name === 'dashboard-blink');
  assert.ok(started.includes('dashboard'));
  assert.ok(blink.ms > 1500 && blink.ms <= 2020);
  dash.activityAt = Date.now() - 4000;
  started.length = 0;
  dash.afterDraw();
  assert.ok(stopped.includes('dashboard'));
  assert.equal(started.includes('dashboard'), false);
});

test('the disk watcher reports changed paths and run records', async () => {
  const dir = tempDir('reslop-watch-');
  await wait(20);
  const seen = new Set();
  let changes = 0;
  const watcher = new DiskWatcher({
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

test('wide tiles take half a row instead of a third', () => {
  const bands = layoutTiles(120, 40, TILES);
  const byId = new Map(TILES.map((tile) => [tile.id, tile]));
  for (const band of bands) {
    if (band.tiles.length < 3) continue;
    for (const place of band.tiles) {
      assert.equal(byId.get(place.id).size, 'normal');
    }
  }
  const mid = bands.find((band) =>
    band.tiles.some((place) => place.id === 'branches'),
  );
  assert.equal(mid.tiles.length, 2);
  assert.deepEqual(
    mid.tiles.map((place) => place.id),
    ['branches', 'commits'],
  );
  const [left, right] = mid.tiles;
  assert.equal(right.x - (left.x + left.w), GAP_X);
  assert.ok(left.w >= 50);
  assert.ok(right.w >= 50);
});

test('the dashboard tiles keep the canonical order and hotkeys', () => {
  const ids = TILES.map((tile) => tile.id);
  assert.deepEqual(ids, [
    'files',
    'diffs',
    'tasks',
    'branches',
    'commits',
    'run',
    'npm',
    'agents',
  ]);
  assert.deepEqual(
    TILES.map((tile) => tile.key),
    ['f', 'd', 't', 'b', 'c', 'r', 'n', 'a'],
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
  assert.equal(DASH_BLOCKS[actionFromKey('a', 'dashboard')], 'agents');
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
  const close = async () => {
    ui.lifecycle.stopWatch();
    ui.dashboard.stop();
    await removeTree(repo.dir);
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
    for (const title of [
      'files',
      'diffs',
      'commits',
      'branches',
      'npm',
      'agents',
    ]) {
      assert.match(text, new RegExp(`${title}`));
    }
    assert.match(text, /run/);
    assert.match(text, /tasks/);
    assert.match(text, /main/);
    assert.match(text, /\+0\/1\s+-0\/0/);
    assert.match(text, /0\/1/);
    assert.match(text, /📁 lib/);
  } finally {
    await close();
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
    await close();
  }
});

test('the dashboard shows a run by script name', async () => {
  const { ui, repo, close } = await openDashboard();
  try {
    assert.ok(await waitUntil(() => /first commit/.test(frameText(ui))));
    const run = new RunRecorder(repo.dir, 'node --test', {
      env: scriptEnv('test'),
    });
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
    await close();
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
    assert.equal(ui.pane, 'packages');
    press(ui, 'escape');
    assert.equal(ui.pane, 'dashboard');
    press(ui, 'r');
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
    ui.agents.listModels = async () => [];
    press(ui, 'a');
    assert.equal(ui.pane, 'agents');
    press(ui, 'escape');
    assert.equal(ui.pane, 'dashboard');
  } finally {
    await close();
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
    await close();
  }
});

test('other keys do nothing on the dashboard', async () => {
  const { ui, close } = await openDashboard();
  try {
    for (const key of ['j', 'k', 'down', 'up', 's', 'u', 'x']) press(ui, key);
    assert.equal(ui.pane, 'dashboard');
  } finally {
    await close();
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
    await close();
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
    ui.nav.pane = 'dashboard';
    ui.draw();
    const npm = ui.lastFrame.fileHits.find((h) => h.cursor === 'npm');
    assert.ok(npm);
    const npmAt = { x: npm.x0 + 2, y: npm.y, btn: 0, button: 0 };
    ui.handleEvent({ type: 'mouse', kind: 'press', press: true, ...npmAt });
    ui.handleEvent({ type: 'mouse', kind: 'release', press: false, ...npmAt });
    assert.equal(ui.pane, 'packages');
  } finally {
    await close();
  }
});

test('the dashboard stays responsive on a tiny terminal', async () => {
  const { ui, close } = await openDashboard(8, 30);
  try {
    const text = frameText(ui);
    assert.ok(text.length > 0);
    assert.equal(ui.lastFrame.rows.length, 8);
  } finally {
    await close();
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
    await close();
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
    const footer = rows.findIndex((row) =>
      /🢐esc {2}light.*files {2}diffs/.test(row),
    );
    assert.ok(footer > 2);
    assert.equal(rows[footer - 2].trim(), '');
  } finally {
    await close();
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
    await close();
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
    await close();
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
  assert.equal(header.startsWith('files'), true);
  assert.ok(folder.indexOf('lib') > 0);
  const end = (line, value) => {
    const at = line.lastIndexOf(value);
    return visibleWidth(line.slice(0, at + value.length));
  };
  assert.equal(end(header, 'size'), end(folder, '40'));
  assert.equal(end(header, 'lines'), end(folder, '8'));
  assert.match(folder, /📁 lib/);
  assert.equal(folder.includes('📁  '), false);
  assert.equal(ext.indexOf('*.js'), folder.indexOf('lib'));
  assert.equal(folder.includes('📄'), false);
  assert.match(ext, /\*\.js/);
  assert.equal(ext.includes('📄'), false);
  assert.match(folder, /[█░]/);
  assert.equal(folder.length, 36);
});

test('diff columns keep one space after the mark and fill the row', () => {
  const group = (key) => ({
    key,
    added: 10,
    removed: 3,
    stagedAdded: 4,
    stagedRemoved: 1,
    staged: 1,
    remaining: 2,
    date: '2 days ago',
  });
  const model = {
    diffs: {
      files: 4,
      dirs: [group('lib')],
      exts: [group('.js')],
      totals: {
        added: 20,
        removed: 6,
        stagedAdded: 8,
        stagedRemoved: 2,
        staged: 2,
        remaining: 4,
      },
      activity: { minutes: [], live: false },
      delta: null,
    },
  };
  const tile = { key: 'd', title: 'diffs' };
  const block = diffsBlock(model, 40, 6, { now: 1, frame: 0 }, tile);
  const text = (line) => line.map((part) => part.text).join('');
  const lines = block.lines.map(text);
  const header = text(block.titleLine);
  const folder = lines.find((line) => line.includes('lib'));
  const ext = lines.find((line) => line.includes('*.js'));
  const end = (line, value) => {
    const at = line.lastIndexOf(value);
    return visibleWidth(line.slice(0, at + value.length));
  };
  assert.equal(header.startsWith('diffs'), true);
  assert.equal(header.includes('total'), false);
  assert.equal(end(header, '+8/20'), end(folder, '+4/10'));
  assert.equal(end(header, '-2/6'), end(folder, '-1/3'));
  assert.equal(end(header, '2/4'), end(folder, '1/2'));
  assert.equal(header.includes('3h ago'), false);
  assert.ok(folder.includes('2d ago'));
  model.diffs.delta = { added: 4, removed: 0, at: 1 };
  const live = diffsBlock(model, 40, 6, { now: 1, frame: 0 }, tile);
  const liveHeader = text(live.titleLine);
  assert.equal(liveHeader.includes('3h ago'), false);
  assert.ok(liveHeader.includes('▲+4'));
  const mark = live.titleLine.find((part) => part.text === '▲+4');
  assert.equal(mark.tone, 'add');
  assert.match(folder, /📁 lib/);
  assert.equal(folder.includes('📁  '), false);
  assert.equal(ext.indexOf('*.js'), folder.indexOf('lib'));
  assert.equal(visibleWidth(header), 40);
  assert.equal(visibleWidth(folder), 40);
  const trend = text(block.footer);
  assert.equal(trend.startsWith('activity '), true);
  assert.equal(visibleWidth(trend), 39);
  assert.equal(block.footer[0].tone, 'muted');
});

test('diff activity scrolls minutes left and blinks the current one', () => {
  const minute = 60_000;
  const now = 3 * minute;
  const totals = {
    added: 1,
    removed: 0,
    stagedAdded: 0,
    stagedRemoved: 0,
    staged: 0,
    remaining: 1,
  };
  const model = {
    diffs: {
      files: 1,
      dirs: [],
      exts: [],
      totals,
      activity: {
        minutes: [
          { at: 1, level: 10, marks: ['commit'] },
          { at: 2, level: 20, marks: [] },
          { at: 3, level: 400, marks: ['fail', 'commit'] },
        ],
        live: true,
      },
      delta: null,
    },
  };
  const tile = { key: 'd', title: 'diffs' };
  const text = (line) => line.map((part) => part.text).join('');
  const block = diffsBlock(model, 40, 6, { now, frame: 0 }, tile);
  const footer = text(block.footer);
  assert.equal(footer.startsWith('activity '), true);
  assert.equal(visibleWidth(footer), 39);
  for (const part of block.footer.slice(1)) {
    assert.equal(visibleWidth(part.text), 1);
  }
  assert.ok(footer.indexOf('◉') < footer.indexOf('+'));
  assert.equal(footer.endsWith(' '), true);
  assert.equal(block.footer.at(-2).text, '∙');
  assert.equal(block.footer[1].text, ' ');
  assert.equal(block.footer.at(-1).text, ' ');
  for (const part of block.footer) {
    assert.equal(part.bg, null);
  }
  const flash = diffsBlock(model, 40, 6, { now, frame: 1 }, tile);
  assert.equal(flash.footer.at(-2).text, '█');
  assert.equal(flash.footer.at(-2).tone, 'blink');
  const painted = paintTile(tile, flash, 40, 6, true);
  const row = painted.at(-1);
  const plain = stripAnsi(row);
  assert.equal(visibleWidth(plain), 40);
  assert.equal(plain.endsWith('█ '), true);
  model.diffs.activity.live = false;
  const done = diffsBlock(model, 40, 6, { now, frame: 0 }, tile);
  assert.equal(done.footer.at(-2).text, 'x');
});

test('diff activity keeps a foreground-only timeline with edge gaps', () => {
  const minute = 60_000;
  const now = 5 * minute;
  const totals = {
    added: 1,
    removed: 0,
    stagedAdded: 0,
    stagedRemoved: 0,
    staged: 0,
    remaining: 1,
  };
  const model = {
    diffs: {
      files: 1,
      dirs: [],
      exts: [],
      totals,
      activity: {
        minutes: [
          { at: 2, level: 4, marks: ['commit'] },
          { at: 4, level: 0, marks: ['pass'] },
        ],
        live: false,
      },
      delta: null,
    },
  };
  const tile = { key: 'd', title: 'diffs' };
  const block = diffsBlock(model, 40, 6, { now, frame: 0 }, tile);
  const timeline = block.footer
    .slice(1)
    .map((part) => part.text)
    .join('');
  assert.equal(timeline[0], ' ');
  assert.equal(timeline.at(-1), ' ');
  assert.ok(timeline.includes('◉'));
  assert.ok(timeline.includes('*'));
  assert.ok(timeline.includes('─'));
  for (const part of block.footer) {
    assert.equal(part.bg, null);
  }
});

test('diff activity marks removals and pulses the current minute', () => {
  const minute = 60_000;
  const now = 3 * minute;
  const totals = {
    added: 1,
    removed: 4,
    stagedAdded: 0,
    stagedRemoved: 0,
    staged: 0,
    remaining: 1,
  };
  const model = {
    diffs: {
      files: 1,
      dirs: [],
      exts: [],
      totals,
      activity: {
        minutes: [
          { at: 1, level: 0, added: 0, removed: 0, marks: ['abort'] },
          { at: 2, level: 5, added: 1, removed: 4, marks: [] },
          { at: 3, level: 3, added: 3, removed: 0, marks: ['fail'] },
        ],
        live: true,
      },
      delta: null,
    },
  };
  const tile = { key: 'd', title: 'diffs' };
  const text = (line) => line.map((part) => part.text).join('');
  const quiet = diffsBlock(model, 40, 6, { now, frame: 0 }, tile);
  const footer = text(quiet.footer);
  assert.ok(footer.includes('!'));
  assert.ok(footer.indexOf('!') < footer.indexOf('-'));
  assert.equal(quiet.footer.at(-2).text, '∙');
  assert.equal(quiet.footer.at(-1).text, ' ');
  const low = diffsBlock(model, 40, 6, { now, frame: 1 }, tile);
  assert.equal(low.footer.at(-2).text, '◦');
  model.diffs.activity.minutes[2].level = 90;
  const high = diffsBlock(model, 40, 6, { now, frame: 1 }, tile);
  assert.equal(high.footer.at(-2).text, '•');
  model.diffs.activity.minutes[2].level = 400;
  const top = diffsBlock(model, 40, 6, { now, frame: 1 }, tile);
  assert.equal(top.footer.at(-2).text, '█');
});

test('diff rows keep removals when the tile is narrow', () => {
  const group = (key) => ({
    key,
    added: 34,
    removed: 8,
    stagedAdded: 12,
    stagedRemoved: 3,
    staged: 12,
    remaining: 40,
    date: '5 minutes ago',
  });
  const model = {
    diffs: {
      files: 12,
      dirs: [group('lib')],
      exts: [group('.js')],
      totals: {
        added: 34,
        removed: 8,
        stagedAdded: 12,
        stagedRemoved: 3,
        staged: 12,
        remaining: 40,
      },
      activity: { minutes: [], live: false },
      delta: null,
    },
  };
  const tile = { key: 'd', title: 'diffs' };
  const block = diffsBlock(model, 32, 6, { now: 1, frame: 0 }, tile);
  const text = (line) => line.map((part) => part.text).join('');
  const header = text(block.titleLine);
  const folder = block.lines.map(text).find((line) => line.includes('lib'));
  assert.ok(header.includes('+12/34'));
  assert.ok(header.includes('-3/8'));
  assert.ok(folder.includes('-3/8'));
  assert.ok(folder.includes('12/40'));
});

test('file names stay whole when the tile is narrow', () => {
  const model = {
    files: {
      ready: true,
      total: { files: 2, bytes: 40, lines: 8 },
      dirs: [{ key: 'node_modules', files: 2, bytes: 40, lines: 8 }],
      exts: [{ key: '.js', files: 2, bytes: 40, lines: 8 }],
      hot: { dirs: new Set(), exts: new Set() },
      delta: null,
    },
  };
  const tile = { key: 'f', title: 'files' };
  const block = filesBlock(model, 22, 6, { now: 1 }, tile);
  const text = (line) => line.map((part) => part.text).join('');
  const folder = text(block.lines[0]);
  const ext = text(block.lines[1]);
  assert.ok(folder.includes('node_modules'));
  assert.equal(ext.indexOf('*.js'), folder.indexOf('node_modules'));
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
  const count = block.titleLine.find((part) => part.text === '2');
  assert.equal(count.tone, 'muted');
});

test('the npm tile lists packages under the header counts', () => {
  const tile = { key: 'n', title: 'npm' };
  const model = {
    npm: {
      ready: true,
      hasManifest: true,
      deps: 1,
      dev: 0,
      modules: {
        bytes: 20,
        count: 2,
        packages: [
          { name: 'big', bytes: 14 },
          { name: 'small', bytes: 6, dev: true },
        ],
      },
      audit: 0,
      outdated: 0,
      running: '',
    },
  };
  const block = npmBlock(model, 36, 8, { now: 1, frame: 0 }, tile);
  const text = (line) => line.map((part) => part.text).join('');
  const header = text(block.titleLine);
  const body = block.lines.map(text).join('\n');
  assert.equal(header.startsWith('npm'), true);
  assert.match(header, /deps: 1/);
  assert.match(header, /dev: 0/);
  assert.match(header, /all: 2 \(20\)/);
  assert.equal(header.includes('🚨'), false);
  assert.equal(header.includes('⚠️'), false);
  assert.equal(body.includes('deps'), false);
  assert.ok(body.indexOf('big') < body.indexOf('small'));
  assert.match(body, /14/);
  assert.match(body, /6/);
  const tone = (value) => {
    for (const line of block.lines) {
      const part = line.find((item) => item.text === value);
      if (part) return part.tone;
    }
    return '';
  };
  assert.equal(tone('name'), '');
  assert.equal(tone('size'), 'muted');
  assert.equal(tone('big'), 'dep');
  assert.equal(tone('small'), 'dev');
});

test('the npm screen lists every package the tile cuts off', () => {
  const packages = [];
  for (let i = 0; i < 12; i++) {
    packages.push({
      name: `pkg${i}`,
      bytes: i + 1,
      dev: false,
      current: '1.0.0',
      wanted: '1.0.0',
      latest: '1.0.0',
    });
  }
  const data = {
    ready: true,
    hasManifest: true,
    deps: 12,
    dev: 0,
    modules: { bytes: 78, count: 12, packages },
    audit: 0,
    outdated: 0,
    running: '',
  };
  const tile = { key: 'n', title: 'npm' };
  const ctx = { frame: 0 };
  const block = npmBlock({ npm: data }, 48, 6, ctx, tile);
  const full = npmContent(data, 48, null, ctx, tile);
  const text = (line) => line.map((part) => part.text).join('');
  const short = block.lines.map(text).join('\n');
  const complete = full.lines.map(text).join('\n');
  assert.ok(short.includes('pkg0'));
  assert.equal(short.includes('pkg11'), false);
  assert.ok(complete.includes('pkg11'));
  assert.ok(text(block.lines[0]).includes('current'));
  assert.ok(text(full.lines[0]).includes('current'));
  const view = {
    packages: data,
    packagesCursor: full.lines.length,
    listScroll: 0,
    progressFrame: 0,
  };
  const painted = paintBodyPackages(view, 48, false, 8, 1);
  const body = painted.body.join('\n');
  assert.match(painted.body[1], /^ {3}/);
  assert.ok(painted.body[1].includes('current'));
  assert.ok(body.includes('▶'));
  assert.ok(body.includes('pkg11'));
  assert.equal(body.includes('deps:'), false);
});

test('the npm tile shows current, wanted, and latest', () => {
  const tile = { key: 'n', title: 'npm' };
  const model = {
    npm: {
      ready: true,
      hasManifest: true,
      deps: 3,
      dev: 0,
      modules: {
        bytes: 24,
        count: 3,
        packages: [
          {
            name: 'big',
            bytes: 14,
            current: '1.0.0',
            wanted: '1.2.0',
            latest: '2.0.0',
          },
          {
            name: 'next',
            bytes: 4,
            current: '4.0.0',
            wanted: '4.0.0',
            latest: '5.0.0',
          },
          {
            name: 'small',
            bytes: 6,
            current: '3.1.0',
            wanted: '3.1.0',
            latest: '3.1.0',
            audit: true,
          },
        ],
      },
      audit: 1,
      outdated: 2,
      running: '',
    },
  };
  const block = npmBlock(model, 64, 10, { now: 1, frame: 0 }, tile);
  const text = (line) => line.map((part) => part.text).join('');
  const body = block.lines.map(text);
  const header = text(block.titleLine);
  assert.match(header, /deps: 3/);
  assert.match(header, /dev: 0/);
  assert.match(header, /all: 3 \(24\)/);
  assert.match(header, /🚨 1/);
  assert.match(header, /⚠️ 2/);
  assert.equal(body.join('\n').includes('deps'), false);
  const labels = body.find((line) => line.includes('current'));
  const heading = block.lines.find((line) =>
    line.some((part) => part.text === 'current'),
  );
  const behind = block.lines.find((line) =>
    line.some((part) => part.text === 'big'),
  );
  const ready = block.lines.find((line) =>
    line.some((part) => part.text === 'small'),
  );
  const ahead = block.lines.find((line) =>
    line.some((part) => part.text === 'next'),
  );
  const tone = (line, value) => {
    const part = line.find((item) => item.text === value);
    return part ? part.tone : '';
  };
  assert.equal(labels.includes('name'), false);
  assert.ok(labels.includes('current'));
  assert.ok(labels.includes('wanted'));
  assert.ok(labels.includes('latest'));
  assert.ok(labels.includes('size'));
  assert.equal(tone(heading, 'current'), 'muted');
  assert.equal(tone(heading, 'size'), 'muted');
  assert.equal(tone(behind, 'big'), 'dep');
  assert.equal(tone(behind, '1.0.0'), 'warn');
  assert.equal(tone(behind, '1.2.0'), 'add');
  assert.equal(tone(behind, '2.0.0'), 'add');
  assert.equal(tone(ready, '3.1.0'), 'error');
  assert.equal(tone(ahead, '5.0.0'), 'add');
  assert.equal(tone(ahead, '4.0.0'), 'warn');
  assert.equal(body.join('\n').includes('⚠️'), false);
  assert.equal(body.join('\n').includes('🛑'), false);
  const screen = npmContent(model.npm, 96, null, { now: 1, frame: 0 }, tile);
  const screenTone = (name, value) => {
    const line = screen.lines.find((row) =>
      row.some((part) => part.text === name),
    );
    const part = line.find((item) => item.text === value);
    return part ? part.tone : '';
  };
  assert.equal(screenTone('big', '⚠️ outdated'), 'warn');
  assert.equal(screenTone('small', '🛑 vulnerability detected'), 'error');
  assert.equal(screenTone('next', '⚠️ outdated'), 'warn');
  const narrow = npmBlock(model, 52, 10, { now: 1, frame: 0 }, tile);
  const narrowText = narrow.lines.map(text).join('\n');
  assert.match(narrowText, /big/);
  assert.match(narrowText, /2\.0\.0/);
  assert.match(narrowText, /5\.0\.0/);
});

test('npm packages take wanted and latest from the outdated report', () => {
  const outdatedMap = new Map([
    [
      'big',
      {
        current: '1.0.0',
        wanted: '1.2.0',
        latest: '2.0.0',
        type: 'dependencies',
      },
    ],
  ]);
  const model = buildModel({
    now: 1,
    frame: 0,
    busy: false,
    index: null,
    fileDelta: null,
    entries: [],
    totals: { added: 0, removed: 0 },
    activity: { minutes: [], live: false },
    diffDelta: null,
    git: null,
    switches: [],
    branchAt: new Map(),
    marks: { npm: 0, commit: 0, branches: 0 },
    npm: {
      hasManifest: true,
      deps: 2,
      dev: 0,
      modules: {
        bytes: 20,
        count: 2,
        packages: [
          { name: 'big', bytes: 14, dev: false, version: '1.0.0' },
          { name: 'small', bytes: 6, dev: false, version: '3.1.0' },
        ],
      },
    },
    npmExtras: {
      auditMap: new Map([['small', { severity: 'high' }]]),
      outdatedMap,
    },
    npmRun: null,
    runs: [],
    notes: { tasks: 0, tasksDone: 0, feedback: 0, code: 0 },
    store: { tasks: [] },
  });
  const packages = model.npm.modules.packages;
  assert.deepEqual(packages[0], {
    name: 'big',
    bytes: 14,
    dev: false,
    transitive: false,
    chain: '',
    audit: false,
    fix: '',
    range: '',
    severity: '',
    title: '',
    current: '1.0.0',
    wanted: '1.2.0',
    latest: '2.0.0',
  });
  assert.deepEqual(packages[1], {
    name: 'small',
    bytes: 6,
    dev: false,
    transitive: false,
    chain: '',
    audit: true,
    fix: '',
    range: '',
    severity: 'high',
    title: '',
    current: '3.1.0',
    wanted: '3.1.0',
    latest: '3.1.0',
  });
});

test('a fixed version is green and a still vulnerable one stays red', () => {
  const tile = { key: 'n', title: 'npm' };
  const model = {
    npm: {
      ready: true,
      hasManifest: true,
      deps: 1,
      dev: 0,
      modules: {
        bytes: 10,
        count: 1,
        packages: [
          {
            name: 'lodash',
            bytes: 10,
            current: '4.17.15',
            wanted: '4.17.20',
            latest: '4.17.21',
            audit: true,
            fix: '4.17.21',
            range: '<4.17.21',
            severity: 'high',
          },
        ],
      },
      audit: 1,
      outdated: 1,
      running: '',
    },
  };
  const block = npmContent(model.npm, 96, null, { now: 1, frame: 0 }, tile);
  const row = block.lines.find((line) =>
    line.some((part) => part.text === 'lodash'),
  );
  const tone = (value) => {
    const part = row.find((item) => item.text === value);
    return part ? part.tone : '';
  };
  assert.equal(tone('🛑 vulnerability detected'), 'error');
  assert.equal(tone('⚠️ outdated'), 'warn');
  assert.equal(tone('4.17.15'), 'error');
  assert.equal(tone('4.17.20'), 'error');
  assert.equal(tone('4.17.21'), 'add');
});

test('a transitive package is grey and shows its parent chain', () => {
  const tile = { key: 'n', title: 'npm' };
  const model = {
    npm: {
      ready: true,
      hasManifest: true,
      deps: 1,
      dev: 1,
      modules: {
        bytes: 9,
        count: 3,
        packages: [
          {
            name: 'one',
            bytes: 3,
            dev: false,
            transitive: false,
            chain: '',
            current: '1.0.0',
            wanted: '1.0.0',
            latest: '1.0.0',
          },
          {
            name: 'eslint',
            bytes: 3,
            dev: true,
            transitive: false,
            chain: '',
            current: '8.0.0',
            wanted: '8.0.0',
            latest: '8.0.0',
          },
          {
            name: 'three',
            bytes: 3,
            dev: false,
            transitive: true,
            chain: 'two 🢒 one',
            current: '1.0.0',
            wanted: '1.0.0',
            latest: '1.0.0',
          },
        ],
      },
      audit: 0,
      outdated: 0,
      running: '',
    },
  };
  const block = npmBlock(model, 80, 8, { now: 1, frame: 0 }, tile);
  const tone = (name) => {
    const row = block.lines.find((line) =>
      line.some((part) => part.text === name),
    );
    const part = row.find((item) => item.text === name);
    return part ? part.tone : '';
  };
  const text = (line) => line.map((part) => part.text).join('');
  const nested = block.lines.find((line) =>
    line.some((part) => part.text === 'three'),
  );
  assert.equal(tone('one'), 'dep');
  assert.equal(tone('eslint'), 'dev');
  assert.equal(tone('three'), 'pkg');
  const via = nested.find((part) => part.text.includes('🢒'));
  assert.equal(via.tone, 'chain');
  assert.match(text(nested), /three 🢒 two 🢒 one/);
  const chain = 'js-yaml 🢒 @eslint/eslintrc 🢒 eslint';
  const long = {
    ...model,
    npm: {
      ...model.npm,
      modules: {
        ...model.npm.modules,
        packages: [
          {
            ...model.npm.modules.packages[2],
            name: 'argparse',
            chain,
          },
        ],
      },
    },
  };
  const tight = npmBlock(long, 72, 6, { now: 1, frame: 0 }, tile);
  const tightRow = tight.lines
    .find((line) => line.some((part) => part.text.startsWith('argparse')))
    .map((part) => part.text)
    .join('');
  assert.match(tightRow, /argparse 🢒 js-yaml 🢒 @eslint\/eslintrc/);
  assert.match(tightRow, /1\.0\.0/);
});

test('the tasks header shows done against the total', () => {
  const tile = { key: 't', title: 'tasks' };
  const model = {
    tasks: {
      done: 3,
      total: 8,
      kinds: [
        { id: 'features', title: 'Feature requests', done: 1, total: 4 },
        { id: 'bugs', title: 'Bug reports', done: 1, total: 2 },
        { id: 'debt', title: 'Technical debt', done: 1, total: 1 },
        { id: 'research', title: 'Research', done: 0, total: 1 },
        { id: 'security', title: 'Security', done: 0, total: 0 },
      ],
    },
  };
  const block = tasksBlock(model, 48, 6, { now: 1, frame: 0 }, tile);
  const text = (line) => line.map((part) => part.text).join('');
  const header = text(block.titleLine);
  const lines = block.lines.map(text);
  const body = lines.join('\n');
  const backlog = lines.find((line) => line.includes('Feature requests'));
  const barAt = (line) => line.indexOf('─');
  assert.equal(header.startsWith('tasks'), true);
  assert.equal(header.trimEnd().endsWith('3/8'), true);
  assert.ok(barAt(header) > 0);
  assert.ok(barAt(header) < header.lastIndexOf('3/8'));
  assert.ok(!header.includes('█'));
  assert.ok(!header.includes('░'));
  assert.match(body, /Bug reports/);
  assert.match(body, /1\/2/);
  assert.match(body, /Technical debt/);
  assert.match(body, /Research/);
  assert.match(body, /Security/);
  assert.equal(backlog.trimEnd().endsWith('1/4'), true);
  assert.ok(backlog.indexOf('Feature requests') < barAt(backlog));
  assert.ok(barAt(backlog) < backlog.lastIndexOf('1/4'));
  assert.ok(!backlog.includes('█'));
  assert.ok(!backlog.includes('░'));
  assert.match(body, /0\/1/);
  const row = block.lines.find((line) =>
    line.some((part) => `${part.text}`.includes('Feature requests')),
  );
  const dash = row.find((part) => part.text.includes('─'));
  const at = row.indexOf(dash);
  assert.equal(dash.tone, 'add');
  assert.equal(dash.bg ?? null, null);
  assert.equal(row[at - 1].text, ' ');
  assert.equal(row[at + 1].text.endsWith(' '), true);
  const ratio = row.find((part) => part.text === '1/4');
  let gapAt = row.indexOf(ratio) - 1;
  while (gapAt > 0 && row[gapAt].text === '') gapAt -= 1;
  assert.equal(row[gapAt].text, ' ');
});

test('dashboard tasks use short captions', () => {
  const model = buildModel({
    entries: [],
    runs: [],
    now: 1,
    frame: 0,
    marks: { commit: 0 },
    store: {
      tasks: [
        { text: 'ship', kind: 'features', done: true },
        { text: 'fix', kind: 'bugs', done: false },
      ],
    },
  });
  const titles = model.tasks.kinds.map((kind) => kind.title);
  assert.deepEqual(titles, [
    'Features',
    'Improvements',
    'Bug Reports',
    'Refactoring',
    'Research',
    'Security',
  ]);
  const tile = { key: 't', title: 'tasks' };
  const block = tasksBlock(model, 48, 8, { now: 1, frame: 0 }, tile);
  const text = (line) => line.map((part) => part.text).join('');
  const body = block.lines.map(text).join('\n');
  assert.match(body, /Features/);
  assert.equal(body.includes('Feature requests'), false);
  assert.match(body, /Bug Reports/);
  assert.match(body, /Refactoring/);
  const painted = paintTile(tile, block, 50, 8, false);
  const shown = painted.find((line) => line.includes('Features'));
  assert.equal(shown.endsWith('1/1 '), true);
  assert.equal(shown.endsWith('1/1  '), false);
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
  assert.equal(metricText(passed), '10|8|2|10');
  assert.equal(passed[2].align, 'r');
  const live = runMetrics({
    status: 'running',
    source: 'reslop t',
    done: 3,
    failed: 1,
    expected: 12,
    result: null,
  });
  assert.equal(metricText(live), '4|3|1|12');
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

test('run captions sit in the header with total and duration', () => {
  const now = 1_000_000;
  const model = {
    busy: '',
    runs: [
      {
        name: 'test',
        status: 'passed',
        source: 'reslop t',
        startedAt: now - 3200,
        endedAt: now - 200,
        done: 8,
        failed: 2,
        expected: 10,
        result: { tests: 10, passed: 8, failed: 2 },
      },
    ],
  };
  const tile = { key: 'r', title: 'run' };
  const block = runsBlock(model, 48, 4, { now, frame: 0 }, tile);
  const text = (line) => line.map((part) => part.text).join('');
  const header = text(block.titleLine);
  const row = text(block.lines[0]);
  const end = (line, value, from = 0) => {
    const at = line.indexOf(value, from);
    return visibleWidth(line.slice(0, at + value.length));
  };
  assert.equal(header.startsWith('run'), true);
  assert.equal(row.includes('done'), false);
  assert.equal(end(header, 'done'), end(row, '10'));
  assert.equal(end(header, 'ok'), end(row, '8'));
  assert.equal(end(header, 'fail'), end(row, '2'));
  assert.equal(end(header, 'total'), end(row, '10', row.indexOf('10') + 2));
  assert.equal(end(header, 'duration'), end(row, '3.0s'));
});

test('a running command spins on its row and not in the caption', () => {
  const now = 1_000_000;
  const model = {
    busy: 'npm test',
    runs: [
      {
        name: 'test',
        status: 'running',
        source: 'node --test',
        startedAt: now - 1000,
        endedAt: 0,
        done: 1,
        failed: 0,
        expected: 4,
        result: null,
      },
    ],
  };
  const tile = { key: 'r', title: 'run' };
  const block = runsBlock(model, 48, 6, { now, frame: 0 }, tile);
  const text = (line) => line.map((part) => part.text).join('');
  const header = text(block.titleLine);
  const body = block.lines.map(text).join('\n');
  assert.equal(header.includes('⠋'), false);
  assert.ok(body.includes('⠋'));
  assert.ok(body.includes('npm test'));
  assert.ok(body.includes('test'));
});

test('a long run command keeps the columns and shows an ellipsis', () => {
  const now = 1_000_000;
  const name = 'node --test test/dashboard.test.js';
  const model = {
    busy: '',
    runs: [
      {
        name,
        status: 'passed',
        source: 'reslop t',
        startedAt: now - 3200,
        endedAt: now - 200,
        done: 8,
        failed: 2,
        expected: 10,
        result: { tests: 10, passed: 8, failed: 2 },
      },
    ],
  };
  const tile = { key: 'r', title: 'run' };
  const block = runsBlock(model, 40, 4, { now, frame: 0 }, tile);
  const text = (line) => line.map((part) => part.text).join('');
  const header = text(block.titleLine);
  const row = text(block.lines[0]);
  assert.ok(header.includes('duration'));
  assert.ok(row.includes('3.0s'));
  assert.ok(row.includes('…'));
  assert.equal(row.includes(name), false);
  assert.equal(visibleWidth(row), 40);
});

const runRecord = (command, script, startedAt, endedAt, extra = {}) => ({
  id: `${startedAt}`,
  command,
  script,
  status: extra.status || 'passed',
  exit: extra.exit ?? 0,
  startedAt,
  endedAt,
  progress: { done: 0, failed: 0, lines: 0, expected: 0 },
  result: extra.result ?? null,
});

test('chained npm script steps share one run row', () => {
  const lint = { errors: 1, warnings: 2, problems: 1 };
  const list = mergeRuns(
    [
      runRecord('eslint .', 'lint', 1000, 2000, { result: lint }),
      runRecord('prettier -c **/*.js', 'lint', 2086, 3000),
      runRecord('eslint . --fix', 'fix', 8000, 9000),
      runRecord('prettier --write **/*.js', 'fix', 9100, 10000, {
        status: 'failed',
        exit: 1,
      }),
      runRecord('npm run -s lint', 'test', 20000, 23000),
      runRecord('eslint .', 'lint', 20100, 21000),
      runRecord('prettier -c **/*.js', 'lint', 21100, 22900),
      runRecord('node --test', 'test', 23100, 28000, {
        result: { tests: 2, passed: 2, failed: 0 },
      }),
      runRecord('eslint .', 'lint', 40000, 41000),
    ],
    null,
  );
  assert.deepEqual(
    list.map((run) => run.name),
    ['lint', 'test', 'lint', 'fix', 'lint'],
  );
  const fix = list.find((run) => run.name === 'fix');
  assert.equal(fix.status, 'failed');
  assert.equal(fix.exit, 1);
  const first = list.at(-1);
  assert.equal(first.startedAt, 1000);
  assert.equal(first.endedAt, 3000);
  assert.equal(first.result.errors, 1);
  assert.equal(first.result.warnings, 2);
});

test('diff groups keep staged lines apart from the total', () => {
  const groups = groupChanges([
    {
      path: 'lib/a.js',
      added: 5,
      removed: 2,
      stagedAdded: 3,
      stagedRemoved: 1,
      staged: 1,
      remaining: 2,
      date: '1 hour ago',
    },
  ]);
  const folder = groups.dirs[0];
  assert.equal(folder.stagedAdded, 3);
  assert.equal(folder.added, 5);
  assert.equal(folder.stagedRemoved, 1);
  assert.equal(folder.removed, 2);
  assert.equal(groups.exts[0].stagedAdded, 3);
});

test('run names use the npm script, or the command', () => {
  assert.equal(scriptName('npm run test'), 'test');
  assert.equal(scriptName('npm run -s lint'), 'lint');
  assert.equal(scriptName('npm test'), 'test');
  assert.equal(scriptName('/usr/bin/eslint .'), 'eslint');
  assert.equal(runName({ command: 'node --test', script: 'test' }), 'test');
  const nested = { command: 'npm run -s lint', script: 'test' };
  assert.equal(runName(nested), 'lint');
  assert.equal(runName({ command: 'eslint .', script: 'lint' }), 'lint');
  assert.equal(runName({ command: 'node --test', script: '' }), 'node --test');
});

test('stat pairs become label and value table rows', () => {
  const rows = pairRows([stat('a', '1'), stat('bb', '2'), stat('c', '3')], 2);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].length, 4);
  assert.equal(rows[1].length, 2);
});
