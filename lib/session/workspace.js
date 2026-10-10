'use strict';

const path = require('node:path');
const { REVIEW_DIR } = require('../common/files.js');
const { FileIndex, HEAT_MS } = require('../dashboard/tree.js');
const { UNKNOWN_PATH } = require('../dashboard/watch.js');
const workspace = require('../dashboard/workspace.js');
const { emptyDiff, countCommits, readDiffStat, taskStats, pickRun } = workspace;
const { readNpmSummary } = require('../dashboard/npm.js');
const { collectReportAsync } = require('../git/deps.js');

const TICK_ID = 'repos';
const HEAT_TIMER = 'repos-heat';

const freshBag = () => ({
  files: [],
  git: false,
  runs: false,
  tasks: false,
  npm: false,
  activity: false,
});

const fullBag = () => ({
  files: [UNKNOWN_PATH],
  git: true,
  runs: true,
  tasks: true,
  npm: true,
  activity: false,
});

const mergeBag = (left, right) => {
  const base = left ?? freshBag();
  return {
    files: [...base.files, ...right.files],
    git: base.git || right.git,
    runs: base.runs || right.runs,
    tasks: base.tasks || right.tasks,
    npm: base.npm || right.npm,
    activity: base.activity || right.activity,
  };
};

const blankRow = (repo) => ({
  name: repo.name,
  dir: repo.dir,
  index: new FileIndex(repo.dir),
  bytes: 0,
  exts: [],
  tasks: 0,
  tasksDone: 0,
  commits: 0,
  diff: emptyDiff(),
  run: null,
  activityAt: 0,
  filesReady: false,
  commitsReady: false,
  diffReady: false,
  tasksReady: false,
  runsReady: false,
  npm: null,
  npmReady: false,
  pending: null,
  running: false,
});

const readFiles = async (row, bag) => {
  if (!bag.files.length) return;
  const unknown = bag.files.includes(UNKNOWN_PATH);
  if (unknown || !row.index.ready) await row.index.rescan();
  else await row.index.touch(bag.files);
  if (!row.index.ready) return;
  const summary = row.index.summary();
  row.bytes = summary.total.bytes;
  row.exts = summary.exts.slice(0, 3);
  row.filesReady = true;
};

const readCommits = async (row) => {
  row.commits = await countCommits(row.dir);
  row.commitsReady = true;
};

const readDiff = async (row) => {
  row.diff = await readDiffStat(row.dir);
  row.diffReady = true;
};

const readTasks = (row) => {
  const stats = taskStats(row.dir);
  row.tasksDone = stats.done;
  row.tasks = stats.total;
  row.tasksReady = true;
};

const readRuns = (row) => {
  row.run = pickRun(row.dir);
  row.runsReady = true;
};

const reportCount = async (dir, kind) => {
  const report = await collectReportAsync(dir, kind);
  return report ? report.size : 0;
};

const readNpm = async (row) => {
  const summary = await readNpmSummary(row.dir, row.npm);
  const [audit, outdated] = await Promise.all([
    reportCount(row.dir, 'audit'),
    reportCount(row.dir, 'outdated'),
  ]);
  row.npm = { ...summary, audit, outdated };
  row.npmReady = true;
};

const toTile = (row) => ({
  id: row.name,
  name: row.name,
  bytes: row.bytes,
  exts: row.exts,
  tasks: row.tasks,
  tasksDone: row.tasksDone,
  commits: row.commits,
  diff: row.diff,
  run: row.run,
  activityAt: row.activityAt,
  filesReady: row.filesReady,
  commitsReady: row.commitsReady,
  diffReady: row.diffReady,
  tasksReady: row.tasksReady,
  runsReady: row.runsReady,
  npm: row.npm,
  npmReady: row.npmReady,
});

const rowBusy = (row) =>
  !row.filesReady ||
  !row.commitsReady ||
  !row.diffReady ||
  !row.tasksReady ||
  !row.runsReady ||
  !row.npmReady;

const classifyRest = (rest) => {
  const bag = freshBag();
  if (!rest) {
    bag.files.push(UNKNOWN_PATH);
    bag.git = true;
    bag.runs = true;
    bag.tasks = true;
    bag.npm = true;
    bag.activity = true;
    return bag;
  }
  if (
    rest === 'package.json' ||
    rest === 'package-lock.json' ||
    rest === 'node_modules/.package-lock.json'
  ) {
    bag.npm = true;
  }
  if (rest === '.git' || rest.startsWith('.git/')) {
    bag.git = true;
    return bag;
  }
  if (rest === '.log' || rest.startsWith('.log/')) {
    bag.runs = true;
    return bag;
  }
  if (rest === REVIEW_DIR || rest.startsWith(`${REVIEW_DIR}/`)) {
    bag.tasks = true;
    return bag;
  }
  bag.files.push(rest);
  bag.activity = true;
  return bag;
};

class Workspace {
  constructor(ui) {
    this.ui = ui;
    this.epoch = 0;
    this.reset();
  }

  reset() {
    this.stop();
    this.rows = [];
    this.byName = new Map();
    this.cursor = 0;
    this.screen = {
      now: 0,
      frame: 0,
      cursor: 0,
      cols: 1,
      tiles: [],
    };
  }

  seed() {
    const info = this.ui.workspaceInfo;
    const repos = info ? info.repos : [];
    this.rows = repos.map(blankRow);
    this.byName = new Map(this.rows.map((row) => [row.name, row]));
    if (this.cursor >= this.rows.length) this.cursor = 0;
  }

  stale(epoch) {
    return epoch !== this.epoch || !this.active;
  }

  publish(epoch) {
    if (this.stale(epoch)) return;
    this.afterDraw();
    if (this.ui.uiOpen && this.ui.nav.pane === 'repos') this.ui.paint();
  }

  async settle(epoch, read) {
    await read();
    this.publish(epoch);
  }

  async apply(row, bag, epoch) {
    if (bag.activity) row.activityAt = Date.now();
    const jobs = [];
    if (bag.files.length) {
      jobs.push(this.settle(epoch, () => readFiles(row, bag)));
    }
    if (bag.git) {
      jobs.push(this.settle(epoch, () => readCommits(row)));
      jobs.push(this.settle(epoch, () => readDiff(row)));
    }
    if (bag.tasks) jobs.push(this.settle(epoch, () => readTasks(row)));
    if (bag.runs) jobs.push(this.settle(epoch, () => readRuns(row)));
    if (bag.npm) jobs.push(this.settle(epoch, () => readNpm(row)));
    await Promise.all(jobs);
  }

  async pump(row) {
    row.running = true;
    while (row.pending && this.active) {
      const bag = row.pending;
      const epoch = this.epoch;
      row.pending = null;
      try {
        await this.apply(row, bag, epoch);
      } catch {
        // keep the previous snapshot until the next event
      }
      if (this.stale(epoch)) break;
      this.afterDraw();
      if (this.ui.uiOpen && this.ui.nav.pane === 'repos') this.ui.paint();
    }
    row.running = false;
    if (row.pending && this.active) {
      void this.pump(row);
      return;
    }
    this.afterDraw();
    if (this.ui.uiOpen && this.ui.nav.pane === 'repos') this.ui.paint();
  }

  kick(row, bag) {
    if (!row || !this.active) return;
    if (bag.activity) row.activityAt = Date.now();
    row.pending = mergeBag(row.pending, bag);
    if (row.running) return;
    void this.pump(row);
  }

  requestAll() {
    for (const row of this.rows) this.kick(row, fullBag());
  }

  notePaths(paths) {
    if (!this.active) return;
    for (const rel of paths) {
      if (rel === UNKNOWN_PATH) return void this.requestAll();
    }
    const found = new Map();
    for (const rel of paths) {
      const slash = rel.indexOf('/');
      const name = slash < 0 ? rel : rel.slice(0, slash);
      const rest = slash < 0 ? '' : rel.slice(slash + 1);
      const row = this.byName.get(name);
      if (!row) continue;
      found.set(name, mergeBag(found.get(name), classifyRest(rest)));
    }
    for (const [name, bag] of found) this.kick(this.byName.get(name), bag);
    if (found.size) {
      this.afterDraw();
      if (this.ui.uiOpen) this.ui.paint();
    }
  }

  start() {
    if (this.active) return;
    this.active = true;
    if (!this.rows.length) this.seed();
    this.requestAll();
  }

  stop() {
    this.epoch += 1;
    this.active = false;
    this.cancelTimers();
  }

  cancelTimers() {
    const { progress, term } = this.ui;
    if (!progress || !term) return;
    progress.stop(TICK_ID);
    term.cancel(HEAT_TIMER);
  }

  hotUntil() {
    let until = 0;
    for (const row of this.rows) {
      until = Math.max(until, row.activityAt + HEAT_MS);
    }
    return until;
  }

  afterDraw() {
    if (!this.active) return;
    const visible = this.ui.uiOpen && this.ui.nav.pane === 'repos';
    if (!visible) return void this.cancelTimers();
    const now = Date.now();
    const until = this.hotUntil();
    const hot = now < until;
    const running = this.rows.some((row) => row.run?.status === 'running');
    const loading = this.rows.some((row) => rowBusy(row));
    const { progress, term } = this.ui;
    if (running || hot || loading) progress.start(TICK_ID);
    else progress.stop(TICK_ID);
    if (!hot) return;
    term.later(
      HEAT_TIMER,
      () => {
        if (this.ui.nav.pane === 'repos') this.ui.paint();
      },
      until - now + 20,
    );
  }

  view() {
    const screen = this.screen;
    screen.now = Date.now();
    screen.frame = this.ui.progressFrame;
    screen.cursor = this.cursor;
    screen.tiles = this.rows.map(toTile);
    return screen;
  }

  move(dx, dy) {
    const count = this.rows.length;
    if (!count) return;
    const cols = Math.max(1, this.screen.cols || 1);
    const next = this.cursor + dx + dy * cols;
    if (next < 0 || next >= count) return;
    this.cursor = next;
    if (this.ui.uiOpen) this.ui.paint();
  }

  enter(name) {
    const row = this.byName.get(name);
    const ui = this.ui;
    if (!row || ui.mode !== 'review') return Promise.resolve();
    ui.flushReview();
    this.stop();
    ui.lifecycle.stopWatch();
    ui.dashboard.stop();
    ui.loader.reset();
    ui.cwd = row.dir;
    ui.paths = [];
    ui.repoName = row.name;
    ui.branch = '';
    ui.rev = null;
    ui.revShort = '';
    ui.change = null;
    ui.dashboardHome = true;
    ui.collection.reset();
    ui.review.reset();
    ui.nav.pane = 'dashboard';
    ui.nav.tasksOpen = false;
    ui.nav.scroll = 0;
    ui.nav.clearSelection();
    ui.status = '';
    try {
      ui.ensureRepo();
    } catch (error) {
      ui.status = error instanceof Error ? error.message : `${error}`;
      return this.show();
    }
    const pending = ui.openLoad();
    if (ui.uiOpen) {
      ui.lifecycle.startWatch();
      ui.dashboard.start();
      ui.paint();
    }
    return pending ?? Promise.resolve();
  }

  openSelected() {
    const row = this.rows[this.cursor];
    if (!row) return Promise.resolve();
    return this.enter(row.name);
  }

  openAt(id) {
    const index = this.rows.findIndex((row) => row.name === id);
    if (index < 0) return Promise.resolve();
    this.cursor = index;
    return this.openSelected();
  }

  show() {
    const ui = this.ui;
    if (!ui.workspaceRoot) return Promise.resolve();
    ui.flushReview();
    ui.dashboard.stop();
    ui.lifecycle.stopWatch();
    ui.loader.reset();
    ui.cwd = ui.workspaceRoot;
    ui.top = ui.workspaceRoot;
    ui.paths = [];
    ui.repoName = path.basename(ui.workspaceRoot);
    ui.branch = '';
    ui.rev = null;
    ui.revShort = '';
    ui.change = null;
    ui.dashboardHome = false;
    ui.collection.reset();
    ui.review.reset();
    ui.nav.pane = 'repos';
    ui.nav.tasksOpen = false;
    ui.nav.scroll = 0;
    ui.nav.clearSelection();
    ui.status = '';
    ui.loader.didLoad = true;
    this.start();
    if (ui.uiOpen) {
      ui.lifecycle.startWatch();
      ui.paint();
    }
    return Promise.resolve();
  }
}

module.exports = { Workspace, classifyRest };
