'use strict';

const { selectChangeSource } = require('../source.js');
const github = require('../github.js');
const gitlab = require('../gitlab.js');
const { applyImportedNotes } = require('../review.js');

const isTypeKey = (key) => {
  if (!key || key.length !== 1) return false;
  return key.charCodeAt(0) >= 32;
};

const startImport = (ui) => {
  if (ui.mode !== 'review' || ui.pane !== 'tasks') return;
  ui.composer.tasks.closePlanMenu();
  ui.mode = 'import';
  ui.nav.import = { url: '' };
  ui.status = '';
};

const stopImport = (ui) => {
  ui.mode = 'review';
  ui.nav.import = null;
  ui.status = '';
};

const noteImport = (ui, message) => {
  ui.status = message;
  if (ui.uiOpen) ui.paint();
};

const finishImport = (ui, store, loaded) => {
  const imported = loaded && loaded.imported;
  if (!imported || ui.review.store !== store) {
    noteImport(ui, 'import failed');
    return;
  }
  applyImportedNotes(store, imported);
  ui.flushReview();
  noteImport(ui, 'imported');
};

const loaderFor = (ui, kind) => {
  if (kind === 'pr') return ui.loadPullRequest ?? github.loadPullRequest;
  if (kind === 'mr') return ui.loadMergeRequest ?? gitlab.loadMergeRequest;
  return null;
};

const tokenFor = (kind) => {
  if (kind === 'pr') return github.githubToken();
  if (kind === 'mr') return gitlab.gitlabToken();
  return '';
};

const targetFor = (selected) => {
  if (selected.kind === 'pr') return selected.pr;
  if (selected.kind === 'mr') return selected.mr;
  return null;
};

const runImport = (ui, selected) => {
  const load = loaderFor(ui, selected.kind);
  const target = targetFor(selected);
  if (!load || !target) return Promise.resolve(null);
  const fetch = ui.fetchImpl ?? globalThis.fetch;
  const options = {
    cwd: ui.top || ui.cwd,
    token: tokenFor(selected.kind),
    fetch,
  };
  return Promise.resolve().then(() => load(target, options));
};

const submitImport = (ui) => {
  const state = ui.nav.import;
  const url = state ? state.url.trim() : '';
  const store = ui.review.store;
  stopImport(ui);
  if (!url) return;
  const selected = selectChangeSource([url]);
  const kind = selected.kind;
  if (kind !== 'pr' && kind !== 'mr') {
    ui.status = 'bad url';
    return;
  }
  ui.status = 'importing';
  const pending = runImport(ui, selected);
  ui.importPromise = pending;
  pending.then(
    (loaded) => finishImport(ui, store, loaded),
    (error) => {
      const message = error instanceof Error ? error.message : '';
      noteImport(ui, message || 'import failed');
    },
  );
};

const onImportKey = (ui, key) => {
  const state = ui.nav.import;
  if (!state) {
    ui.mode = 'review';
    return;
  }
  if (key === 'ctrl-c') return void ui.onQuit();
  if (key === 'escape') return void stopImport(ui);
  if (key === 'enter') return void submitImport(ui);
  if (key === 'backspace') {
    state.url = state.url.slice(0, -1);
    if (!state.url) stopImport(ui);
    return;
  }
  if (isTypeKey(key)) state.url += key;
};

module.exports = { startImport, stopImport, onImportKey };
