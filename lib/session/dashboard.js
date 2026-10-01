'use strict';

const files = require('../files.js');
const { fileEntries, fileTotals } = files;
const review = require('../review.js');
const { noteCounts } = review;
const runs = require('../runs.js');
const { readRuns, settleRecord, isRunsRel } = runs;
const tree = require('../dashboard/tree.js');
const { FileIndex, HEAT_MS } = tree;
const gitInfo = require('../dashboard/git.js');
const { readGitSummary } = gitInfo;
const npmInfo = require('../dashboard/npm.js');
const { readNpmSummary } = npmInfo;
const model = require('../dashboard/model.js');
const { buildModel } = model;
const filesPane = require('./files-pane.js');
const watch = require('./watch.js');
const { UNKNOWN_PATH, MODULES_STAMP } = watch;

const TICK_ID = 'dashboard';
const HEAT_TIMER = 'dashboard-heat';
const AGE_TIMER = 'dashboard-age';
const SAMPLES = 40;
const SWITCHES = 4;
const GIT_NAMES = new Set([
  'HEAD',
  'packed-refs',
  'FETCH_HEAD',
  'ORIG_HEAD',
  'refs',
  'logs',
  'rebase-merge',
  'rebase-apply',
]);
const NPM_FILES = new Set(['package.json', 'package-lock.json', MODULES_STAMP]);
const AGE_FAST_MS = 1000;
const AGE_MID_MS = 30000;
const AGE_SLOW_MS = 600000;

class Coalesced {
  constructor(run, onDone) {
    this.run = run;
    this.onDone = onDone;
    this.running = false;
    this.dirty = false;
  }

  request() {
    this.dirty = true;
    if (!this.running) void this.pump();
  }

  async pump() {
    this.running = true;
    while (this.dirty) {
      this.dirty = false;
      try {
        await this.run();
      } catch {
        // keep the previous data until the next event
      }
    }
    this.running = false;
    this.onDone();
  }
}

const totalsKey = (totals) =>
  [
    totals.stagedAdded,
    totals.unstagedAdded,
    totals.stagedRemoved,
    totals.unstagedRemoved,
    totals.remaining,
  ].join(':');

const classify = (paths) => {
  const found = { files: [], git: false, npm: false, runs: false, all: false };
  for (const rel of paths) {
    if (rel === UNKNOWN_PATH) {
      found.all = true;
    } else if (rel.startsWith('.git/')) {
      if (GIT_NAMES.has(rel.split('/')[1])) found.git = true;
    } else if (isRunsRel(rel)) {
      found.runs = true;
    } else {
      if (NPM_FILES.has(rel)) found.npm = true;
      found.files.push(rel);
    }
  }
  return found;
};

const ageDelay = (ageMs) => {
  if (ageMs < 90000) return AGE_FAST_MS;
  if (ageMs < 5400000) return AGE_MID_MS;
  return AGE_SLOW_MS;
};

class Dashboard {
  constructor(ui) {
    this.ui = ui;
    this.epoch = 0;
    const done = () => this.done();
    this.tasks = {
      files: new Coalesced(() => this.runFiles(), done),
      git: new Coalesced(() => this.runGit(), done),
      npm: new Coalesced(() => this.runNpm(), done),
      runs: new Coalesced(() => this.runRuns(), done),
    };
    this.clear();
  }

  clear() {
    this.epoch += 1;
    this.active = false;
    this.index = null;
    this.touch = new Set();
    this.fileDelta = null;
    this.git = null;
    this.npm = null;
    this.runs = [];
    this.totals = null;
    this.totalsKey = '';
    this.diffDelta = null;
    this.samples = [];
    this.switches = [];
    this.branchAt = new Map();
    this.branchSha = new Map();
    this.lastSha = '';
    this.marks = { npm: 0, commit: 0, branches: 0 };
  }

  root() {
    return this.ui.top || this.ui.cwd;
  }

  visible() {
    return this.ui.uiOpen && this.ui.nav.pane === 'dashboard';
  }

  paintIfVisible() {
    if (this.visible()) this.ui.paint();
  }

  done() {
    this.afterDraw();
    this.paintIfVisible();
  }

  hotUntil() {
    const { marks, index, fileDelta, diffDelta } = this;
    return Math.max(
      index ? index.hotUntil() : 0,
      fileDelta ? fileDelta.at + HEAT_MS : 0,
      diffDelta ? diffDelta.at + HEAT_MS : 0,
      marks.npm + HEAT_MS,
      marks.commit + HEAT_MS,
      marks.branches + HEAT_MS,
    );
  }

  liveRuns() {
    return this.runs.map((run) => settleRecord(run));
  }

  youngest(runs) {
    const last = this.git && this.git.commits.last;
    let at = last ? last.at : 0;
    for (const run of runs) at = Math.max(at, run.endedAt, run.startedAt);
    return at;
  }

  cancelTimers() {
    const { progress, term } = this.ui;
    progress.stop(TICK_ID);
    term.cancel(HEAT_TIMER);
    term.cancel(AGE_TIMER);
  }

  afterDraw() {
    if (!this.active) return;
    if (!this.visible()) return void this.cancelTimers();
    const { progress, term } = this.ui;
    const now = Date.now();
    const until = this.hotUntil();
    const hot = now < until;
    const runs = this.liveRuns();
    const running = runs.some((run) => run.status === 'running');
    if (running || hot) progress.start(TICK_ID);
    else progress.stop(TICK_ID);
    const repaint = () => this.paintIfVisible();
    if (hot) term.later(HEAT_TIMER, repaint, until - now + 20);
    const at = this.youngest(runs);
    const delay = at ? ageDelay(now - at) : AGE_SLOW_MS;
    term.later(AGE_TIMER, repaint, delay);
  }

  async runFiles() {
    const { epoch, index } = this;
    if (!index) return;
    const wasReady = index.ready;
    const before = index.summary().total;
    const paths = [...this.touch];
    this.touch.clear();
    const changed = await index.touch(paths);
    if (epoch !== this.epoch || !changed || !wasReady) return;
    const after = index.summary().total;
    const lines = after.lines - before.lines;
    const bytes = after.bytes - before.bytes;
    if (lines || bytes) this.fileDelta = { lines, at: Date.now() };
  }

  noteShas(next, now) {
    const seen = this.branchSha;
    const known = seen.size > 0;
    let changed = false;
    for (const entry of next.branches) {
      if (known && seen.get(entry.name) !== entry.sha) {
        this.branchAt.set(entry.name, now);
        changed = true;
      }
      seen.set(entry.name, entry.sha);
    }
    return changed;
  }

  noteSwitch(next, now) {
    const prev = this.git;
    if (!prev || !prev.branch || !next.branch) return false;
    if (prev.branch === next.branch) return false;
    const entry = { from: prev.branch, to: next.branch, at: now };
    this.switches = [entry, ...this.switches].slice(0, SWITCHES);
    return true;
  }

  async runGit() {
    const epoch = this.epoch;
    const next = await readGitSummary(this.root());
    if (epoch !== this.epoch) return;
    const now = Date.now();
    const moved = this.noteShas(next, now);
    const switched = this.noteSwitch(next, now);
    if (moved || switched) this.marks.branches = now;
    const sha = next.commits.last ? next.commits.last.sha : '';
    if (this.lastSha && sha !== this.lastSha) this.marks.commit = now;
    this.lastSha = sha;
    this.git = next;
  }

  async runNpm() {
    const epoch = this.epoch;
    const prev = this.npm;
    const next = await readNpmSummary(this.root(), prev);
    if (epoch !== this.epoch) return;
    const changed =
      prev &&
      (prev.deps !== next.deps ||
        prev.dev !== next.dev ||
        prev.modules.stamp !== next.modules.stamp);
    if (changed) this.marks.npm = Date.now();
    this.npm = next;
  }

  runRuns() {
    this.runs = readRuns(this.root());
  }

  noteLoaded() {
    if (!this.active) return;
    const totals = fileTotals(fileEntries(this.ui.items));
    const key = totalsKey(totals);
    if (key === this.totalsKey) return;
    const prev = this.totals;
    if (prev) {
      const added = totals.added - prev.added;
      const removed = totals.removed - prev.removed;
      this.diffDelta = { added, removed, at: Date.now() };
    }
    this.totals = totals;
    this.totalsKey = key;
    this.samples.push(totals.added + totals.removed);
    if (this.samples.length > SAMPLES) this.samples.shift();
  }

  requestAll() {
    this.touch.add(UNKNOWN_PATH);
    for (const task of Object.values(this.tasks)) task.request();
  }

  noteDisk(paths) {
    if (!this.active) return;
    const found = classify(paths);
    if (found.all) return void this.requestAll();
    const tasks = this.tasks;
    if (found.files.length) {
      for (const rel of found.files) this.touch.add(rel);
      tasks.files.request();
    }
    if (found.git) tasks.git.request();
    if (found.npm) tasks.npm.request();
    if (found.runs) tasks.runs.request();
  }

  start() {
    if (this.active) return;
    this.clear();
    this.active = true;
    this.index = new FileIndex(this.root());
    this.noteLoaded();
    this.requestAll();
  }

  stop() {
    this.epoch += 1;
    this.active = false;
    this.cancelTimers();
  }

  reset() {
    this.stop();
    this.clear();
  }

  view() {
    const ui = this.ui;
    const entries = fileEntries(ui.items);
    const store = ui.review.store;
    return buildModel({
      now: Date.now(),
      frame: ui.progressFrame,
      busy: ui.ops.busy,
      index: this.index,
      fileDelta: this.fileDelta,
      entries,
      totals: this.totals ?? fileTotals(entries),
      samples: this.samples,
      diffDelta: this.diffDelta,
      git: this.git,
      switches: this.switches,
      branchAt: this.branchAt,
      marks: this.marks,
      npm: this.npm,
      npmExtras: ui.lifecycle.npmExtras(),
      npmRun: ui.npm.lastRun,
      runs: this.liveRuns(),
      notes: noteCounts(store),
      store,
    });
  }

  showFiles(scope) {
    const ui = this.ui;
    ui.showFiles();
    if (scope === 'file') filesPane.onFileScope(ui);
    else filesPane.onDiffScope(ui);
    ui.status = '';
  }

  open(id) {
    const ui = this.ui;
    const openers = {
      files: () => this.showFiles('file'),
      diffs: () => this.showFiles('diff'),
      commits: () => ui.commits.onCommit(),
      branches: () => ui.gitBranches.onBranch(),
      npm: () => ui.npm.open(),
      run: () => ui.npm.open(),
      tasks: () => ui.composer.tasks.openTasksPage(),
    };
    const opener = openers[id];
    if (!opener || ui.mode !== 'review') return;
    opener();
    this.afterDraw();
  }

  enter() {
    if (!this.active) return;
    this.tasks.runs.request();
    this.afterDraw();
  }
}

module.exports = { Dashboard, classify, ageDelay };
