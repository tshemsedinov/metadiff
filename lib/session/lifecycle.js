'use strict';

const fs = require('node:fs');
const path = require('node:path');

const sessionLoad = require('./load.js');
const { isAbortError } = sessionLoad;
const watch = require('./watch.js');
const { createDiskWatcher, POLL_MS, DEBOUNCE_MS } = watch;
const files = require('../files.js');
const { itemPath, relativeAge, TODO_FILE } = files;
const deps = require('../deps.js');
const { MANIFEST, LOCKFILE, depFileMeta } = deps;
const review = require('../review.js');
const { hasNotes, loadReview } = review;
const reviewMerge = require('../review-merge.js');
const { mergeReview } = reviewMerge;

const loadOptions = (api, extra = {}) => {
  const { loadConfig, ui } = api;
  return {
    commit: ui.rev,
    audit: loadConfig.audit,
    outdatedMap: loadConfig.outdatedMap,
    auditMap: loadConfig.auditMap,
    ...extra,
  };
};

const shouldDeferExtras = (api) => {
  const { loadConfig } = api;
  const audit = !!loadConfig.audit;
  const waitingOutdated = loadConfig.outdatedMap === undefined;
  const waitingAudit = loadConfig.auditMap === undefined;
  return audit && (waitingOutdated || waitingAudit);
};

const endReadLoop = (api) => {
  const finish = api.ui.finishReadLoop;
  if (finish) finish();
};

const markLoaded = (api) => {
  api.loader.didLoad = true;
  api.updater.maybePrompt();
};

const isWorktree = (ui) => !ui.rev && !ui.change;

const kindFromExtra = (extra = {}) => {
  if (extra.keepView === true) return 'watch';
  if (extra.keepEmpty === true) return 'keep';
  return 'reload';
};

const finishIfEmpty = (api, kind) => {
  const { collection, review: notes, ui, nav } = api;
  if (collection.items.length) return;
  if (notes.store && hasNotes(notes.store)) return;
  if (kind === 'keep') return;
  if (isWorktree(ui)) {
    if (nav.pane === 'diff') nav.pane = 'files';
    return;
  }
  ui.done = true;
  ui.exitCode = 0;
  ui.status = 'nothing to review';
  ui.emptyReview = kind === 'open';
  endReadLoop(api);
};

const failOpen = (api, error) => {
  if (isAbortError(error)) return;
  const { ui, ops } = api;
  ui.loadError = error;
  ui.done = true;
  ui.exitCode = 1;
  ops.setBusy('');
  ui.stopProgress();
  endReadLoop(api);
};

const restoreAfterLoad = (api, here, wasTodo) => {
  const { collection, nav, ui } = api;
  nav.todoOpen = wasTodo;
  if (here && !wasTodo) {
    const idx = collection.findRestoredIndex(here);
    if (idx >= 0) nav.index = idx;
  }
  ui.clampIndex();
  nav.restoreFileCursor(ui.fileList());
  ui.syncReviewPath();
  ui.syncFileCursor();
};

const itemRels = (collection) => {
  const rels = [];
  for (const item of collection.items) {
    const rel = itemPath(item);
    if (!rel) continue;
    if (rels.includes(rel)) continue;
    rels.push(rel);
  }
  return rels;
};

const fileDatesFromDisk = (top, rels) => {
  const dates = new Map();
  if (!top) return dates;
  const now = Date.now();
  for (const rel of rels) {
    try {
      const st = fs.statSync(path.join(top, rel));
      dates.set(rel, relativeAge(st.mtimeMs, now));
    } catch {
      continue;
    }
  }
  return dates;
};

const stampItemDates = (items, dates) => {
  for (const item of items) {
    const date = dates.get(itemPath(item));
    if (date) item.date = date;
  }
};

const syncUnitEditor = (api) => {
  const composer = api.ui.composer;
  if (!composer || typeof composer.applyDiskText !== 'function') return;
  if (api.nav.pane !== 'unit') return;
  const rel = api.nav.reviewPath;
  if (!rel) return;
  const repo = api.ui.repo;
  if (!repo || typeof repo.fileText !== 'function') return;
  const text = repo.fileText(api.ui.top || api.loadConfig.cwd, rel, api.ui.rev);
  composer.applyDiskText(text);
};

const syncItemWatches = (api) => {
  if (!api.diskWatcher) return;
  const rels = itemRels(api.collection);
  if (api.nav.pane === 'unit' && api.nav.reviewPath) {
    if (!rels.includes(api.nav.reviewPath)) rels.push(api.nav.reviewPath);
  }
  api.diskWatcher.watchFiles(rels);
};

const applyLoaded = (api, loaded) => {
  const { loader, collection, review: notes, nav, ui } = api;
  if (loaded.generation !== undefined) {
    if (!loader.accept(loaded.generation, ui.done)) return false;
  }
  const wasTodo = nav.todoOpen === true;
  const here = ui.current();
  ui.top = loaded.top ?? api.loadConfig.cwd;
  collection.replace(loaded.items);
  stampItemDates(
    collection.items,
    fileDatesFromDisk(ui.top, itemRels(collection)),
  );
  if (loaded.rev) ui.rev = loaded.rev;
  if (loaded.revShort) {
    ui.revShort = loaded.revShort;
  } else if (ui.rev && !ui.revShort) {
    ui.revShort = ui.rev.slice(0, 7);
  }
  if (loaded.sourceLabel) ui.sourceLabel = loaded.sourceLabel;
  if (loaded.change) ui.change = loaded.change;
  if (loaded.branch !== undefined) ui.branch = loaded.branch || '';
  const repository = ui.change ? ui.change.repository : '';
  if (!ui.repoName && repository) ui.repoName = repository;
  if (!notes.store) ui.initReview();
  notes.applyImported(loaded.imported);
  restoreAfterLoad(api, here, wasTodo);
  markLoaded(api);
  loader.pendingExtras = loaded.pending === true;
  syncItemWatches(api);
  syncUnitEditor(api);
  return true;
};

const load = (api) => {
  const { loadConfig } = api;
  const loaded = loadConfig.repo.load(
    loadConfig.cwd,
    loadConfig.paths,
    loadOptions(api),
  );
  applyLoaded(api, loaded);
};

const fileStamp = (top, rel) => {
  const full = path.join(top, rel);
  try {
    const stat = fs.statSync(full);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'missing';
  }
};

const npmRels = (items) => {
  const rels = [MANIFEST, LOCKFILE];
  for (const item of items) {
    const rel = itemPath(item);
    if (!depFileMeta(rel)) continue;
    if (rels.includes(rel)) continue;
    rels.push(rel);
  }
  rels.sort();
  return rels;
};

const npmStamp = (api) => {
  const top = api.ui.top || api.loadConfig.cwd;
  const rels = npmRels(api.collection.items);
  const parts = new Array(rels.length);
  for (let i = 0; i < rels.length; i++) {
    parts[i] = `${rels[i]}:${fileStamp(top, rels[i])}`;
  }
  return parts.join('|');
};

const npmExtrasStale = (api) => {
  const cached = api.npmExtras;
  if (!cached || !api.loadConfig.audit) return false;
  return cached.stamp !== npmStamp(api);
};

const cacheNpmExtras = (api, loaded) => {
  api.npmExtras = {
    stamp: npmStamp(api),
    auditMap: loaded.auditMap ?? null,
    outdatedMap: loaded.outdatedMap ?? null,
    usedNames: loaded.usedNames ?? null,
    exportEntries: loaded.exportEntries,
  };
};

const clearNpmExtras = (api) => {
  api.npmExtras = null;
};

const followExtras = async (api, loaded, gen, kind) => {
  const extra = loadOptions(api, {
    paths: api.loadConfig.paths,
    signal: api.loader.signal,
  });
  let next;
  try {
    next = await api.loader.fetchExtras(api.loadConfig.repo, loaded, extra);
  } catch (error) {
    if (!api.loader.isCurrent(gen)) return;
    return void failOpen(api, error);
  }
  if (!api.loader.isCurrent(gen)) return;
  if (api.ui.done) {
    api.ops.clearBusy();
    return;
  }
  if (!next) {
    api.ops.clearBusy();
    api.loader.pendingExtras = false;
    api.ui.paint();
    finishIfEmpty(api, kind);
    return;
  }
  applyLoaded(api, api.loader.tag(next, gen));
  cacheNpmExtras(api, next);
  api.ops.clearBusy();
  api.ui.paint();
  finishIfEmpty(api, kind);
};

const npmReuseOpts = (api, extra = {}) => {
  const opts = {};
  if (extra.signal) opts.signal = extra.signal;
  const cached = api.npmExtras;
  if (!cached) return opts;
  if (cached.stamp !== npmStamp(api)) return opts;
  opts.deferExtras = false;
  opts.collect = false;
  opts.auditMap = cached.auditMap;
  opts.outdatedMap = cached.outdatedMap;
  opts.usedNames = cached.usedNames;
  opts.exportEntries = cached.exportEntries;
  return opts;
};

const snapshotOpts = (api, extra = {}) =>
  loadOptions(api, {
    deferExtras: shouldDeferExtras(api),
    ...npmReuseOpts(api, extra),
  });

const resetNavAfterLoad = (api, extra = {}) => {
  api.nav.scroll = 0;
  api.nav.clearSelection();
  if (extra.afterLoad) extra.afterLoad();
};

const afterSnapshot = (api, kind, extra = {}) => {
  if (kind !== 'open' && kind !== 'watch') {
    return void resetNavAfterLoad(api, extra);
  }
  if (extra.afterLoad) extra.afterLoad();
};

const beginSnapshot = (api, extra) => {
  if (extra.quiet === true) return;
  api.ui.progressFrame = 0;
  api.ops.setBusy('loading');
  api.ui.paint();
};

const runSnapshot = async (api, gen, kind, extra = {}) => {
  beginSnapshot(api, extra);
  let loaded;
  try {
    loaded = await api.loader.fetchSnapshot(
      api.loadConfig.repo,
      api.loadConfig.cwd,
      api.loadConfig.paths,
      snapshotOpts(api, {
        signal: api.loader.signal,
        keepView: extra.keepView,
      }),
    );
  } catch (error) {
    if (!api.loader.isCurrent(gen)) return;
    return void failOpen(api, error);
  }
  if (!api.loader.isCurrent(gen)) return;
  if (api.ui.done) {
    api.ops.clearBusy();
    return;
  }
  applyLoaded(api, api.loader.tag(loaded, gen));
  afterSnapshot(api, kind, extra);
  if (loaded.pending === true || npmExtrasStale(api)) {
    api.ops.setBusy('checking npm');
    if (kind === 'open' || extra.quiet === true) api.ui.paint();
    await followExtras(api, loaded, gen, kind);
    return;
  }
  api.ops.clearBusy();
  finishIfEmpty(api, kind);
  if (extra.doneStatus && !api.ui.status && !api.ops.busy) {
    api.ui.status = extra.doneStatus;
  }
  api.ui.paint();
};

const openLoad = (api) => {
  const { loader } = api;
  if (loader.promise) return loader.promise;
  if (loader.didLoad && !loader.pendingExtras) {
    loader.promise = Promise.resolve();
    return loader.promise;
  }
  const gen = loader.bump();
  loader.promise = runSnapshot(api, gen, 'open');
  return loader.promise;
};

const loadReady = async (api) => {
  api.ui.ensureRepo();
  await openLoad(api);
  if (api.ui.loadError) throw api.ui.loadError;
};

const refreshFromRepo = (api, extra = {}) => {
  api.loader.promise = null;
  const gen = api.loader.bump();
  const kind = kindFromExtra(extra);
  if (api.ui.uiOpen && api.loadConfig.repo.loadAsync) {
    return void runSnapshot(api, gen, kind, extra);
  }
  const loaded = api.loadConfig.repo.load(
    api.loadConfig.cwd,
    api.loadConfig.paths,
    snapshotOpts(api, extra),
  );
  applyLoaded(api, api.loader.tag(loaded, gen));
  afterSnapshot(api, kind, extra);
  if (loaded.pending === true || npmExtrasStale(api)) {
    api.ops.setBusy('checking npm');
    return void followExtras(api, loaded, gen, kind);
  }
  if (kind === 'keep') return;
  finishIfEmpty(api, kind);
  if (extra.doneStatus && !api.ui.done && !api.loader.pendingExtras) {
    api.ui.status = extra.doneStatus;
  }
  if (kind === 'watch') api.ui.paint();
};

const reloadAfterChange = (api, afterLoad) => {
  const hereItem = api.ui.current();
  const hereIndex = api.nav.index;
  const restore = () => {
    const idx = api.collection.findRestoredIndex(hereItem);
    api.nav.index = idx >= 0 ? idx : hereIndex;
    api.ui.clampIndex();
    api.ui.syncReviewPath();
    api.ui.syncFileCursor();
    if (afterLoad) afterLoad();
  };
  if (api.ui.uiOpen && api.loadConfig.repo.loadAsync) {
    return void refreshFromRepo(api, { afterLoad: restore });
  }
  refreshFromRepo(api);
  restore();
};

const onReload = (api) => {
  api.collection.dismissed.clear();
  api.ui.status = '';
  refreshFromRepo(api, { doneStatus: 'reloaded' });
};

const clearWatchRetry = (api) => {
  if (api.watchRetry === null) return;
  clearTimeout(api.watchRetry);
  api.watchRetry = null;
};

const shouldDeferWatch = (api) => {
  const { ui, ops } = api;
  if (ui.done) return true;
  if (!ui.uiOpen) return true;
  if (!api.loader.didLoad) return true;
  if (ops.gitBusy) return true;
  if (ui.mode === 'compose') {
    const kind = ui.composer && ui.composer.state.composeKind;
    if (kind === 'file') return false;
  }
  if (ui.mode !== 'review') return true;
  return false;
};

const WATCH_IGNORE_MS = 500;

const ignoreWatch = (api, ms = WATCH_IGNORE_MS) => {
  api.ignoreWatchUntil = Date.now() + ms;
};

const onDiskChange = (api) => {
  if (Date.now() < (api.ignoreWatchUntil ?? 0)) return;
  if (shouldDeferWatch(api)) {
    if (api.watchRetry !== null) return;
    api.watchRetry = setTimeout(() => {
      api.watchRetry = null;
      onDiskChange(api);
    }, DEBOUNCE_MS);
    if (typeof api.watchRetry.unref === 'function') api.watchRetry.unref();
    return;
  }
  refreshFromRepo(api, { keepView: true, quiet: true });
};

const catchUpWatch = (api) => {
  clearWatchRetry(api);
  if (shouldDeferWatch(api)) return void onDiskChange(api);
  refreshFromRepo(api, { keepView: true, quiet: true });
};

const stampFile = (root, rel) => {
  const full = path.join(root, rel);
  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    return `${rel}:missing`;
  }
  return `${rel}:${stat.mtimeMs}:${stat.size}`;
};

const worktreeStamp = (api) => {
  const root = api.ui.top || api.loadConfig.cwd;
  const parts = [];
  for (const rel of itemRels(api.collection)) {
    if (!rel || rel === TODO_FILE) continue;
    parts.push(stampFile(root, rel));
  }
  return parts.join('\n');
};

const watchesWorktree = (nav) =>
  nav.todoOpen === true ||
  nav.pane === 'branches' ||
  nav.pane === 'commits' ||
  nav.pane === 'npm';

const currentFileStamp = (api) => {
  const { nav } = api;
  const root = api.ui.top || api.loadConfig.cwd;
  if (watchesWorktree(nav)) return worktreeStamp(api);
  const pane = nav.pane;
  if (pane !== 'diff' && pane !== 'unit') return '';
  const rel = pane === 'unit' ? nav.reviewPath : itemPath(api.ui.current());
  if (!rel) return '';
  return stampFile(root, rel);
};

const pollCurrentFile = (api) => {
  const stamp = currentFileStamp(api);
  if (!stamp) {
    api.watchStamp = '';
    return;
  }
  if (!api.watchStamp) {
    api.watchStamp = stamp;
    return;
  }
  if (stamp === api.watchStamp) return;
  api.watchStamp = stamp;
  onDiskChange(api);
};

const reviewFileStamp = (api) => {
  const store = api.review && api.review.store;
  if (!store || !store.reviewPath) return '';
  try {
    const stat = fs.statSync(store.reviewPath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'missing';
  }
};

const noteReviewStamp = (api) => {
  api.reviewStamp = reviewFileStamp(api);
};

const applyReviewChange = (api) => {
  if (!api.ui || api.ui.done) return;
  const stamp = reviewFileStamp(api);
  if (!stamp || stamp === api.reviewStamp) return;
  if (stamp === 'missing') {
    api.reviewStamp = stamp;
    return;
  }
  const store = api.review && api.review.store;
  if (!store) return;
  let disk;
  try {
    disk = loadReview(store.reviewPath, store.templates);
  } catch {
    return;
  }
  mergeReview(store, disk);
  api.reviewStamp = stamp;
  if (typeof api.ui.paint === 'function') api.ui.paint();
};

const stopWatch = (api) => {
  clearWatchRetry(api);
  api.watchStamp = '';
  api.reviewStamp = '';
  if (api.ui.term) api.ui.term.stopTimer('watch');
  if (!api.diskWatcher) return;
  api.diskWatcher.close();
  api.diskWatcher = null;
};

const startWatch = (api) => {
  stopWatch(api);
  if (!isWorktree(api.ui)) return;
  const root = api.ui.top || api.loadConfig.cwd;
  if (!root) return;
  api.diskWatcher = createDiskWatcher({
    root,
    paths: api.loadConfig.paths,
    onChange: () => onDiskChange(api),
    onReview: () => applyReviewChange(api),
  });
  syncItemWatches(api);
  noteReviewStamp(api);
  if (!api.ui.term) return;
  api.ui.term.startTimer(
    'watch',
    () => {
      pollCurrentFile(api);
      applyReviewChange(api);
    },
    POLL_MS,
  );
};

const createLifecycle = (api) => {
  api.diskWatcher = null;
  api.watchRetry = null;
  api.watchStamp = '';
  api.reviewStamp = '';
  api.ignoreWatchUntil = 0;
  api.npmExtras = null;
  return {
    applyLoaded: (loaded) => applyLoaded(api, loaded),
    load: () => load(api),
    openLoad: () => openLoad(api),
    loadReady: () => loadReady(api),
    refreshFromRepo: (extra) => refreshFromRepo(api, extra),
    reloadAfterChange: (afterLoad) => reloadAfterChange(api, afterLoad),
    onReload: () => onReload(api),
    onDiskChange: () => onDiskChange(api),
    applyReviewChange: () => applyReviewChange(api),
    noteReviewStamp: () => noteReviewStamp(api),
    catchUpWatch: () => catchUpWatch(api),
    pollCurrentFile: () => pollCurrentFile(api),
    startWatch: () => startWatch(api),
    stopWatch: () => stopWatch(api),
    ignoreWatch: (ms) => ignoreWatch(api, ms),
    clearNpmExtras: () => clearNpmExtras(api),
  };
};

module.exports = { createLifecycle };
