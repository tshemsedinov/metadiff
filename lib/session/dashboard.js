'use strict';

const { fileEntries, fileTotals } = require('../files.js');
const { noteCounts } = require('../review.js');
const { readRuns, settleRecord, isRunsRel } = require('../runs.js');
const { FileIndex, HEAT_MS } = require('../dashboard/tree.js');
const { readGitSummary } = require('../dashboard/git.js');
const { readNpmSummary } = require('../dashboard/npm.js');
const model = require('../dashboard/model.js');
const { buildModel, minuteOf, MINUTE_MS, npmModel } = model;
const filesPane = require('./files-pane.js');
const { UNKNOWN_PATH, MODULES_STAMP } = require('./watch.js');

const TICK_ID = 'dashboard';
const HEAT_TIMER = 'dashboard-heat';
const AGE_TIMER = 'dashboard-age';
const MINUTE_TIMER = 'dashboard-minute';
const BLINK_TIMER = 'dashboard-blink';
const BLINK_MS = 3000;
const MINUTE_KEEP = 360;
const SWITCHES = 4;
const RUN_MARK = { failed: 'fail', passed: 'pass', aborted: 'abort' };
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
    this.minutes = new Map();
    this.activityAt = 0;
    this.rebaseOn = false;
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
    term.cancel(MINUTE_TIMER);
    term.cancel(BLINK_TIMER);
  }

  bucket(at) {
    const minute = minuteOf(at);
    let newest = minute;
    for (const key of this.minutes.keys()) {
      if (key > newest) newest = key;
    }
    if (minute < newest - MINUTE_KEEP) return null;
    let row = this.minutes.get(minute);
    if (!row) {
      row = { level: 0, added: 0, removed: 0, marks: [] };
      this.minutes.set(minute, row);
    }
    const oldest = newest - MINUTE_KEEP;
    for (const key of this.minutes.keys()) {
      if (key < oldest) this.minutes.delete(key);
    }
    return row;
  }

  touchActivity(at) {
    if (at > this.activityAt) this.activityAt = at;
  }

  heat(at, added, removed = 0) {
    const plus = Math.max(0, added || 0);
    const minus = Math.max(0, removed || 0);
    if (!at || plus + minus <= 0) return;
    const row = this.bucket(at);
    if (!row) return;
    row.added += plus;
    row.removed += minus;
    row.level += plus + minus;
    this.touchActivity(at);
  }

  mark(at, kind) {
    if (!at || !kind) return;
    const row = this.bucket(at);
    if (!row || row.marks.includes(kind)) return;
    row.marks.push(kind);
    this.touchActivity(at);
  }

  noteCommits(next) {
    const recent = next.commits.recent;
    for (const entry of recent) this.mark(entry.at, 'commit');
  }

  noteRebase(next, now) {
    const rebasing = Boolean(next.rebase);
    if (rebasing && !this.rebaseOn) this.mark(now, 'rebase');
    this.rebaseOn = rebasing;
  }

  noteRuns(runs) {
    for (const run of runs) {
      const kind = RUN_MARK[run.status];
      if (kind) this.mark(run.endedAt || run.startedAt, kind);
    }
  }

  isRunLive() {
    for (const run of this.liveRuns()) {
      if (run.status === 'running') return true;
    }
    const npm = this.ui.npm.lastRun;
    return Boolean(npm && npm.running);
  }

  isBusy() {
    if (this.git && this.git.rebase) return true;
    return this.isRunLive();
  }

  liveActivity(now) {
    if (this.isBusy()) return true;
    return now - this.activityAt < BLINK_MS;
  }

  activityView(now) {
    const minutes = [];
    for (const [at, row] of this.minutes) {
      minutes.push({
        at,
        level: row.level,
        added: row.added,
        removed: row.removed,
        marks: row.marks.slice(),
      });
    }
    return { minutes, live: this.liveActivity(now) };
  }

  afterDraw() {
    if (!this.active) return;
    if (!this.visible()) return void this.cancelTimers();
    const { progress, term } = this.ui;
    const now = Date.now();
    if (this.isBusy()) this.touchActivity(now);
    const until = this.hotUntil();
    const hot = now < until;
    const live = this.liveActivity(now);
    if (live || hot) progress.start(TICK_ID);
    else progress.stop(TICK_ID);
    const repaint = () => this.paintIfVisible();
    if (hot) term.later(HEAT_TIMER, repaint, until - now + 20);
    const at = this.youngest(this.liveRuns());
    const delay = at ? ageDelay(now - at) : AGE_SLOW_MS;
    term.later(AGE_TIMER, repaint, delay);
    const minuteLeft = MINUTE_MS - (now % MINUTE_MS) + 20;
    term.later(MINUTE_TIMER, repaint, minuteLeft);
    const blinkLeft = this.activityAt + BLINK_MS - now;
    if (blinkLeft > 0) term.later(BLINK_TIMER, repaint, blinkLeft + 20);
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
    if (!lines && !bytes) return;
    const at = Date.now();
    this.fileDelta = { lines, at };
    const plus = lines > 0 ? lines : 0;
    const minus = lines < 0 ? -lines : 0;
    this.heat(at, plus || (minus ? 0 : 1), minus);
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
    if (switched) this.mark(now, 'branch');
    const sha = next.commits.last ? next.commits.last.sha : '';
    if (this.lastSha && sha !== this.lastSha) this.marks.commit = now;
    this.lastSha = sha;
    this.noteCommits(next);
    this.noteRebase(next, now);
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
    if (changed) {
      const now = Date.now();
      this.marks.npm = now;
      this.mark(now, 'npm');
    }
    this.npm = next;
  }

  runRuns() {
    this.runs = readRuns(this.root());
    this.noteRuns(this.runs);
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
      const at = Date.now();
      this.diffDelta = { added, removed, at };
      const plus = Math.max(0, added);
      const minus = Math.max(0, removed);
      this.heat(at, plus || (minus ? 0 : 1), minus);
    }
    this.totals = totals;
    this.totalsKey = key;
  }

  requestAll() {
    this.touch.add(UNKNOWN_PATH);
    for (const task of Object.values(this.tasks)) task.request();
  }

  noteDisk(paths) {
    const found = classify(paths);
    const npm = this.ui.npm;
    if ((found.runs || found.all) && npm && npm.refreshRecorded) {
      npm.refreshRecorded();
    }
    if (!this.active) return;
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
    const now = Date.now();
    const entries = fileEntries(ui.items);
    const store = ui.review.store;
    return buildModel({
      now,
      frame: ui.progressFrame,
      busy: ui.ops.busy,
      index: this.index,
      fileDelta: this.fileDelta,
      entries,
      totals: this.totals ?? fileTotals(entries),
      activity: this.activityView(now),
      diffDelta: this.diffDelta,
      git: this.git,
      switches: this.switches,
      branchAt: this.branchAt,
      marks: this.marks,
      npm: this.npm,
      npmExtras: ui.lifecycle.npmExtras(),
      npmRun: ui.npm.lastRun,
      npmRuns: ui.npm.dashboardRuns(),
      runs: this.liveRuns(),
      notes: noteCounts(store),
      store,
      agents: ui.agents.summary(),
    });
  }

  packagesView() {
    return npmModel({
      npm: this.npm,
      npmExtras: this.ui.lifecycle.npmExtras(),
      npmRun: this.ui.npm.lastRun,
    });
  }

  packageCount() {
    const data = this.packagesView();
    if (!data.ready || !data.hasManifest) return 1;
    const listed = data.modules && data.modules.packages;
    return listed ? listed.length : 0;
  }

  openPackages() {
    const ui = this.ui;
    ui.nav.pane = 'packages';
    ui.nav.packagesCursor = 0;
    ui.nav.resetListScroll('packages');
    ui.nav.clearSelection();
    ui.status = '';
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
      npm: () => this.openPackages(),
      run: () => ui.npm.open(),
      tasks: () => ui.composer.tasks.openTasksPage(),
      agents: () => ui.agents.open(),
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
