'use strict';

const { remoteKind, selectChangeSource } = require('../source/source.js');
const { lineKey, lineField } = require('../input/line-edit.js');

const startImport = (ui) => {
  if (ui.mode !== 'review' || ui.pane !== 'tasks') return;
  ui.composer.tasks.closePlanMenu();
  ui.mode = 'import';
  ui.nav.import = lineField('url');
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
  store.applyImportedNotes(imported);
  ui.flushReview();
  noteImport(ui, 'imported');
};

const runImport = (ui, selected) => {
  const kind = remoteKind(selected);
  if (!kind) return Promise.resolve(null);
  const load = ui[kind.option] ?? kind.load;
  const target = kind.target(selected);
  if (!load || !target) return Promise.resolve(null);
  const fetch = ui.fetchImpl ?? globalThis.fetch;
  const options = { cwd: ui.top || ui.cwd, token: kind.token(), fetch };
  return Promise.resolve().then(() => load(target, options));
};

const submitImport = (ui) => {
  const state = ui.nav.import;
  const url = state ? state.url.trim() : '';
  const store = ui.review.store;
  stopImport(ui);
  if (!url) return;
  const selected = selectChangeSource([url]);
  if (!remoteKind(selected)) {
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
  if (key === 'escape') return void stopImport(ui);
  if (key === 'enter') return void submitImport(ui);
  if (key === 'backspace' && !state.url) return void stopImport(ui);
  lineKey(state.editor, key, ui, true);
};

module.exports = { startImport, stopImport, onImportKey };
