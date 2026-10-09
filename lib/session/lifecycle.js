'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { isAbort } = require('../utilities.js');
const { tagLoaded, fetchSnapshot, fetchExtras } = require('./load.js');
const { DiskWatcher, DEBOUNCE_MS } = require('./watch.js');
const { itemPath, relativeAge, REVIEW_DIR } = require('../files.js');
const { MANIFEST, LOCKFILE, depFileMeta } = require('../deps.js');
const { hasNotes, loadReview } = require('../review.js');
const { mergeReview } = require('../review-merge.js');

const WATCH_IGNORE_MS = 500;

const isWorktree = (ui) => !ui.rev && !ui.change;

const kindFromExtra = (extra = {}) => {
  if (extra.keepView === true) return 'watch';
  if (extra.keepEmpty === true) return 'keep';
  return 'reload';
};

const statStamp = (file) => {
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'missing';
  }
};

const itemRels = (items) => {
  const rels = new Set();
  for (const item of items) {
    const rel = itemPath(item);
    if (rel) rels.add(rel);
  }
  return [...rels];
};

const stampItemDates = (top, items) => {
  if (!top) return;
  const now = Date.now();
  const dates = new Map();
  for (const rel of itemRels(items)) {
    try {
      const stat = fs.statSync(path.join(top, rel));
      dates.set(rel, relativeAge(stat.mtimeMs, now));
    } catch {
      continue;
    }
  }
  for (const item of items) {
    const date = dates.get(itemPath(item));
    if (date) item.date = date;
  }
};

const npmRels = (items) => {
  const rels = new Set([MANIFEST, LOCKFILE]);
  for (const item of items) {
    const rel = itemPath(item);
    if (depFileMeta(rel)) rels.add(rel);
  }
  return [...rels].sort();
};

class Lifecycle {
  constructor(ui) {
    this.ui = ui;
    this.diskWatcher = null;
    this.watchRetry = null;
    this.reviewStamp = '';
    this.ignoreWatchUntil = 0;
    this.cachedExtras = null;
  }

  get root() {
    return this.ui.top || this.ui.cwd;
  }

  loadOptions(extra = {}) {
    const ui = this.ui;
    return {
      commit: ui.rev,
      audit: ui.audit,
      outdatedMap: ui.outdatedMap,
      auditMap: ui.auditMap,
      ...extra,
    };
  }

  endReadLoop() {
    const finish = this.ui.finishReadLoop;
    if (finish) finish();
  }

  finishIfEmpty(kind) {
    const ui = this.ui;
    if (ui.items.length) return;
    const store = ui.review.store;
    if (store && hasNotes(store)) return;
    if (kind === 'keep') return;
    if (isWorktree(ui)) {
      if (ui.nav.pane === 'diff') ui.nav.pane = 'files';
      return;
    }
    ui.done = true;
    ui.exitCode = 0;
    ui.status = 'nothing to review';
    ui.emptyReview = kind === 'open';
    this.endReadLoop();
  }

  failOpen(error) {
    if (isAbort(error)) return;
    const ui = this.ui;
    ui.loadError = error;
    ui.done = true;
    ui.exitCode = 1;
    ui.ops.setBusy('');
    ui.stopProgress();
    this.endReadLoop();
  }

  restoreAfterLoad(here, wasTasks) {
    const { nav, collection } = this.ui;
    nav.tasksOpen = wasTasks;
    if (here && !wasTasks) {
      const idx = collection.findRestoredIndex(here);
      if (idx >= 0) nav.index = idx;
    }
    this.ui.clampIndex();
    nav.restoreFileCursor(this.ui.fileList());
    this.ui.syncReviewPath();
    this.ui.syncFileCursor();
  }

  syncUnitEditor() {
    const ui = this.ui;
    const rel = ui.nav.reviewPath;
    if (ui.nav.pane !== 'unit' || !rel || !ui.repo.fileText) return;
    ui.composer.applyDiskText(ui.repo.fileText(this.root, rel, ui.rev));
  }

  syncItemWatches() {
    if (!this.diskWatcher) return;
    const nav = this.ui.nav;
    const rels = itemRels(this.ui.items);
    if (nav.pane === 'unit' && nav.reviewPath) {
      if (!rels.includes(nav.reviewPath)) rels.push(nav.reviewPath);
    }
    this.diskWatcher.watchFiles(rels);
  }

  applyLoaded(loaded) {
    const ui = this.ui;
    if (ui.nav.pane === 'repos') return false;
    const { loader, collection, nav } = ui;
    if (loaded.generation !== undefined) {
      if (!loader.isCurrent(loaded.generation, ui.done)) return false;
    }
    const wasTasks = nav.tasksOpen === true;
    const firstLoad = !loader.didLoad;
    const here = ui.current();
    ui.top = loaded.top ?? ui.cwd;
    collection.replace(loaded.items);
    stampItemDates(ui.top, collection.items);
    if (loaded.rev) ui.rev = loaded.rev;
    if (loaded.revShort) ui.revShort = loaded.revShort;
    else if (ui.rev && !ui.revShort) ui.revShort = ui.rev.slice(0, 7);
    if (loaded.sourceLabel) ui.sourceLabel = loaded.sourceLabel;
    if (loaded.change) ui.change = loaded.change;
    if (loaded.branch !== undefined) ui.branch = loaded.branch || '';
    const repository = ui.change ? ui.change.repository : '';
    if (!ui.repoName && repository) ui.repoName = repository;
    if (!ui.review.store) ui.initReview();
    ui.review.applyImported(loaded.imported);
    this.restoreAfterLoad(here, wasTasks);
    const issue = loaded.change && loaded.change.source === 'issue';
    if (firstLoad && issue && !collection.items.length) {
      ui.composer.tasks.openTasksPage();
    }
    loader.didLoad = true;
    ui.updater.maybePrompt();
    loader.pendingExtras = loaded.pending === true;
    this.syncItemWatches();
    this.syncUnitEditor();
    ui.dashboard.noteLoaded();
    return true;
  }

  load() {
    const ui = this.ui;
    const loaded = ui.repo.load(ui.cwd, ui.paths, this.loadOptions());
    this.applyLoaded(loaded);
  }

  npmStamp() {
    const root = this.root;
    const rels = npmRels(this.ui.items);
    const stamp = (rel) => `${rel}:${statStamp(path.join(root, rel))}`;
    return rels.map(stamp).join('|');
  }

  npmExtrasStale() {
    const cached = this.cachedExtras;
    if (!cached || !this.ui.audit) return false;
    return cached.stamp !== this.npmStamp();
  }

  cacheNpmExtras(loaded) {
    this.cachedExtras = {
      stamp: this.npmStamp(),
      auditMap: loaded.auditMap ?? null,
      outdatedMap: loaded.outdatedMap ?? null,
      usedNames: loaded.usedNames ?? null,
      exportEntries: loaded.exportEntries,
    };
  }

  clearNpmExtras() {
    this.cachedExtras = null;
  }

  npmExtras() {
    if (this.cachedExtras) return this.cachedExtras;
    const { auditMap, outdatedMap } = this.ui;
    if (!auditMap && !outdatedMap) return null;
    return { auditMap: auditMap ?? null, outdatedMap: outdatedMap ?? null };
  }

  isWanted(gen) {
    if (!this.ui.loader.isCurrent(gen)) return false;
    if (!this.ui.done) return true;
    this.ui.ops.clearBusy();
    return false;
  }

  async followExtras(loaded, gen, kind) {
    const ui = this.ui;
    const extra = this.loadOptions({
      paths: ui.paths,
      signal: ui.loader.signal,
    });
    let next;
    try {
      next = await fetchExtras(ui.repo, loaded, extra);
    } catch (error) {
      if (ui.loader.isCurrent(gen)) this.failOpen(error);
      return;
    }
    if (!this.isWanted(gen)) return;
    if (next) {
      this.applyLoaded(tagLoaded(next, gen));
      this.cacheNpmExtras(next);
    } else {
      ui.loader.pendingExtras = false;
    }
    ui.ops.clearBusy();
    ui.paint();
    this.finishIfEmpty(kind);
  }

  snapshotOpts(extra = {}) {
    const ui = this.ui;
    const waiting = ui.outdatedMap === undefined || ui.auditMap === undefined;
    const opts = { deferExtras: ui.audit && waiting };
    if (extra.signal) opts.signal = extra.signal;
    const cached = this.cachedExtras;
    if (cached && cached.stamp === this.npmStamp()) {
      opts.deferExtras = false;
      opts.collect = false;
      opts.auditMap = cached.auditMap;
      opts.outdatedMap = cached.outdatedMap;
      opts.usedNames = cached.usedNames;
      opts.exportEntries = cached.exportEntries;
    }
    return this.loadOptions(opts);
  }

  afterSnapshot(kind, extra = {}) {
    const nav = this.ui.nav;
    if (nav.pane === 'commits') this.ui.commits.refresh();
    if (kind !== 'open' && kind !== 'watch') {
      nav.scroll = 0;
      nav.clearSelection();
    }
    if (extra.afterLoad) extra.afterLoad();
  }

  async runSnapshot(gen, kind, extra = {}) {
    const ui = this.ui;
    if (extra.quiet !== true) {
      ui.progressFrame = 0;
      ui.ops.setBusy('loading');
      ui.paint();
    }
    let loaded;
    try {
      const opts = this.snapshotOpts({ signal: ui.loader.signal });
      loaded = await fetchSnapshot(ui.repo, ui.cwd, ui.paths, opts);
    } catch (error) {
      if (ui.loader.isCurrent(gen)) this.failOpen(error);
      return;
    }
    if (!this.isWanted(gen)) return;
    this.applyLoaded(tagLoaded(loaded, gen));
    this.afterSnapshot(kind, extra);
    if (loaded.pending === true || this.npmExtrasStale()) {
      ui.ops.setBusy('checking npm');
      if (kind === 'open' || extra.quiet === true) ui.paint();
      await this.followExtras(loaded, gen, kind);
      return;
    }
    ui.ops.clearBusy();
    this.finishIfEmpty(kind);
    if (extra.doneStatus && !ui.status && !ui.ops.busy) {
      ui.status = extra.doneStatus;
    }
    ui.paint();
  }

  openLoad() {
    const loader = this.ui.loader;
    if (this.ui.nav.pane === 'repos') {
      loader.didLoad = true;
      loader.promise = Promise.resolve();
      return loader.promise;
    }
    if (loader.promise) return loader.promise;
    if (loader.didLoad && !loader.pendingExtras) {
      loader.promise = Promise.resolve();
    } else {
      loader.promise = this.runSnapshot(loader.bump(), 'open');
    }
    return loader.promise;
  }

  async loadReady() {
    if (this.ui.nav.pane === 'repos') {
      this.ui.loader.didLoad = true;
      return;
    }
    this.ui.ensureRepo();
    await this.openLoad();
    if (this.ui.loadError) throw this.ui.loadError;
  }

  refreshFromRepo(extra = {}) {
    const ui = this.ui;
    ui.loader.promise = null;
    const gen = ui.loader.bump();
    const kind = kindFromExtra(extra);
    if (ui.uiOpen && ui.repo.loadAsync) {
      return void this.runSnapshot(gen, kind, extra);
    }
    const loaded = ui.repo.load(ui.cwd, ui.paths, this.snapshotOpts(extra));
    this.applyLoaded(tagLoaded(loaded, gen));
    this.afterSnapshot(kind, extra);
    if (loaded.pending === true || this.npmExtrasStale()) {
      ui.ops.setBusy('checking npm');
      return void this.followExtras(loaded, gen, kind);
    }
    if (kind === 'keep') return;
    this.finishIfEmpty(kind);
    if (extra.doneStatus && !ui.done && !ui.loader.pendingExtras) {
      ui.status = extra.doneStatus;
    }
    if (kind === 'watch') ui.paint();
  }

  reloadAfterChange(afterLoad) {
    const ui = this.ui;
    const hereItem = ui.current();
    const hereIndex = ui.nav.index;
    const restore = () => {
      const idx = ui.collection.findRestoredIndex(hereItem);
      ui.nav.index = idx >= 0 ? idx : hereIndex;
      ui.clampIndex();
      ui.syncReviewPath();
      ui.syncFileCursor();
      if (afterLoad) afterLoad();
    };
    if (ui.uiOpen && ui.repo.loadAsync) {
      return void this.refreshFromRepo({ afterLoad: restore });
    }
    this.refreshFromRepo();
    restore();
  }

  onReload() {
    this.ui.collection.dismissed.clear();
    this.ui.status = '';
    this.refreshFromRepo({ doneStatus: 'reloaded' });
  }

  clearWatchRetry() {
    if (this.watchRetry === null) return;
    clearTimeout(this.watchRetry);
    this.watchRetry = null;
  }

  shouldDeferWatch() {
    const ui = this.ui;
    if (ui.done || !ui.uiOpen || !ui.loader.didLoad) return true;
    if (ui.ops.gitBusy) return true;
    if (ui.mode === 'compose' && ui.composeKind === 'file') return false;
    return ui.mode !== 'review';
  }

  ignoreWatch(ms = WATCH_IGNORE_MS) {
    this.ignoreWatchUntil = Date.now() + ms;
  }

  onDiskChange() {
    if (this.ui.nav.pane === 'repos') return;
    if (Date.now() < this.ignoreWatchUntil) return;
    if (!this.shouldDeferWatch()) {
      return void this.refreshFromRepo({ keepView: true, quiet: true });
    }
    if (this.watchRetry !== null) return;
    this.watchRetry = setTimeout(() => {
      this.watchRetry = null;
      this.onDiskChange();
    }, DEBOUNCE_MS);
    this.watchRetry.unref();
  }

  catchUpWatch() {
    this.clearWatchRetry();
    if (this.shouldDeferWatch()) return void this.onDiskChange();
    this.refreshFromRepo({ keepView: true, quiet: true });
  }

  reviewFileStamp() {
    const store = this.ui.review.store;
    if (!store || !store.reviewPath) return '';
    return statStamp(store.reviewPath);
  }

  noteReviewStamp() {
    this.reviewStamp = this.reviewFileStamp();
  }

  applyReviewChange() {
    if (this.ui.done) return;
    const stamp = this.reviewFileStamp();
    if (!stamp || stamp === this.reviewStamp) return;
    if (stamp === 'missing') {
      this.reviewStamp = stamp;
      return;
    }
    const store = this.ui.review.store;
    let disk;
    try {
      disk = loadReview(store.reviewPath, store.templates);
    } catch {
      return;
    }
    mergeReview(store, disk);
    this.reviewStamp = stamp;
    this.ui.paint();
  }

  stopWatch() {
    this.clearWatchRetry();
    this.reviewStamp = '';
    if (!this.diskWatcher) return;
    this.diskWatcher.close();
    this.diskWatcher = null;
  }

  startWatch() {
    this.stopWatch();
    const ui = this.ui;
    if (ui.nav.pane === 'repos') {
      const root = ui.workspaceRoot;
      if (!root) return;
      const info = ui.workspaceInfo;
      const repos = info ? info.repos : [];
      const paths = ['.'];
      for (const repo of repos) paths.push(path.join(repo.name, '.git'));
      this.diskWatcher = new DiskWatcher({
        root,
        paths,
        matchReview: (rel) => rel.includes(`/${REVIEW_DIR}/`),
        onPaths: (rels) => ui.workspace.notePaths(rels),
      });
      return;
    }
    const root = this.root;
    if (!isWorktree(this.ui) || !root) return;
    this.diskWatcher = new DiskWatcher({
      root,
      paths: this.ui.paths,
      onChange: () => this.onDiskChange(),
      onReview: () => this.applyReviewChange(),
      onPaths: (paths) => this.ui.dashboard.noteDisk(paths),
    });
    this.syncItemWatches();
    this.noteReviewStamp();
  }
}

module.exports = { Lifecycle };
