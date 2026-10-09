'use strict';

const { isTasksEntry, TASKS_FILE } = require('../files.js');
const { fileMatches } = require('../find.js');
const { lineKey, lineField } = require('./line-edit.js');

const FIND_PANES = ['files', 'diff'];

const isTypeKey = (key) =>
  Boolean(key) && key.length === 1 && key.charCodeAt(0) >= 32;

const startFind = (ui) => {
  if (ui.mode !== 'review') return;
  if (!FIND_PANES.includes(ui.pane)) return;
  ui.mode = 'find';
  const find = lineField('query');
  find.at = 0;
  ui.nav.find = find;
  ui.status = '';
};

const stopFind = (ui) => {
  ui.mode = 'review';
  ui.nav.find = null;
  ui.status = '';
};

const focusMatch = (ui, hit, jump) => {
  const entry = ui.fileList()[hit.index];
  if (!entry) return;
  const moved = ui.nav.fileCursor !== hit.index;
  ui.nav.fileCursor = hit.index;
  if (isTasksEntry(entry)) {
    ui.nav.reviewPath = TASKS_FILE;
    return;
  }
  ui.nav.reviewPath = entry.path;
  if (ui.nav.pane !== 'diff') {
    ui.nav.index = entry.firstIndex;
    return;
  }
  if (!moved && !jump) return;
  ui.nav.index = entry.openIndex ?? entry.firstIndex;
  ui.nav.scroll = 0;
  ui.nav.clearSelection();
};

const showHit = (ui, jump) => {
  const state = ui.nav.find;
  if (!state) return;
  const hits = fileMatches(ui.fileList(), state.query);
  if (!hits.length) return;
  const count = hits.length;
  let at = state.at % count;
  if (at < 0) at += count;
  state.at = at;
  focusMatch(ui, hits[at], jump);
};

const typeFind = (ui, key) => {
  const state = ui.nav.find;
  state.editor.insert(key);
  state.at = 0;
  showHit(ui, true);
};

const moveFind = (ui, delta) => {
  const state = ui.nav.find;
  if (!state.query) return;
  state.at += delta;
  showHit(ui, false);
};

const onFindKey = (ui, key) => {
  if (!ui.nav.find) {
    ui.mode = 'review';
    return;
  }
  if (key === 'escape' || key === 'enter') return void stopFind(ui);
  if (key === 'backspace' && !ui.nav.find.query) return void stopFind(ui);
  const handled = lineKey(ui.nav.find.editor, key, ui, true);
  if (handled === 'text') {
    ui.nav.find.at = 0;
    showHit(ui, true);
  }
  if (handled) return;
  if (key === 'up') return void moveFind(ui, -1);
  if (key === 'down') return void moveFind(ui, 1);
  if (isTypeKey(key)) typeFind(ui, key);
};

module.exports = { FIND_PANES, startFind, stopFind, onFindKey };
