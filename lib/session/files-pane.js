'use strict';

const ansi = require('../ansi.js');
const files = require('../files.js');
const { THEME_NAMES, setTheme, themeName } = ansi;
const { isTodosEntry, TODO_FILE } = files;
const npm = require('../render/npm.js');
const { logViewRows } = npm;
const unit = require('./unit.js');
const actions = require('./actions.js');
const { LIST_PANES } = actions;
const { setFileScope, openUnitFile, moveUnitBlock } = unit;

const LAYOUTS = ['unified', 'mixed', 'side'];

const current = (ui) => ui.nav.current(ui.items, ui.todoItem);

const clampIndex = (ui) => ui.nav.clampIndex(ui.items.length);

const syncReviewPath = (ui) => ui.nav.syncReviewPath(current(ui));

const clampFileCursor = (ui) => ui.nav.clampFileCursor(ui.fileList().length);

const followReviewPath = (ui) =>
  ui.nav.followReviewPath(ui.fileList(), current(ui));

const syncFileCursor = (ui) => {
  if (ui.nav.pane === 'files') return void clampFileCursor(ui);
  followReviewPath(ui);
};

const showFiles = (ui) => {
  const nav = ui.nav;
  const held =
    nav.todoOpen === true ||
    nav.pane === 'branches' ||
    nav.pane === 'commits' ||
    nav.pane === 'npm';
  nav.pane = 'files';
  nav.clearSelection();
  followReviewPath(ui);
  nav.todoOpen = false;
  if (held) ui.lifecycle.catchUpWatch();
};

const onEscape = (ui) => {
  if (ui.nav.pane === 'files') return void ui.onQuit();
  showFiles(ui);
};

const onFiles = (ui) => {
  if (ui.nav.pane === 'files') {
    if (!ui.nav.reviewPath) return;
    if (ui.nav.fileScope === 'file') {
      const list = ui.fileList();
      const entry = list[ui.nav.fileCursor];
      if (entry && !isTodosEntry(entry)) openUnitFile(ui, entry);
      return;
    }
    ui.nav.pane = 'diff';
    ui.nav.clearSelection();
    if (ui.nav.reviewPath === TODO_FILE) ui.composer.openTodoPage();
    return;
  }
  showFiles(ui);
};

const onOpenFile = (ui) => {
  if (ui.nav.pane === 'branches') {
    return void ui.gitBranches.onCheckoutBranch();
  }
  if (ui.nav.pane === 'commits') return void ui.commits.onShowDiff();
  if (ui.nav.pane === 'npm') return void ui.npm.run();
  if (ui.nav.pane !== 'files') {
    if (ui.nav.todoOpen) ui.composer.editFocusedTodo();
    return;
  }
  const list = ui.fileList();
  const entry = list[ui.nav.fileCursor];
  if (!entry) return;
  if (isTodosEntry(entry)) {
    ui.composer.openTodoPage();
    ui.status = '';
    return;
  }
  ui.nav.todoOpen = false;
  ui.nav.index = entry.openIndex ?? entry.firstIndex;
  if (ui.nav.fileScope === 'file') {
    return void openUnitFile(ui, entry);
  }
  ui.nav.pane = 'diff';
  ui.nav.scroll = 0;
  ui.status = '';
  ui.nav.clearSelection();
  syncReviewPath(ui);
};

const onFileMove = (ui, delta) => {
  const list = ui.fileList();
  if (!list.length) {
    ui.status = 'nothing to review';
    return;
  }
  const last = list.length - 1;
  const moved = ui.nav.fileCursor + delta;
  const next = Math.min(last, Math.max(0, moved));
  if (next === ui.nav.fileCursor) return;
  ui.nav.fileCursor = next;
  const entry = list[next];
  if (isTodosEntry(entry)) {
    ui.nav.reviewPath = TODO_FILE;
  } else {
    ui.nav.reviewPath = entry.path;
    ui.nav.index = entry.firstIndex;
  }
  ui.status = '';
};

const moveRemaining = (ui, step) => {
  const list = ui.items;
  if (!list.length) {
    ui.status = 'nothing to review';
    return;
  }
  const next = ui.nav.index + step;
  if (next < 0 || next >= list.length) return;
  ui.nav.index = next;
  ui.nav.scroll = 0;
  ui.status = '';
  ui.nav.clearSelection();
  syncReviewPath(ui);
};

const onNext = (ui) => {
  if (ui.nav.pane === 'unit') return void moveUnitBlock(ui, 1);
  if (ui.nav.todoOpen) {
    ui.composer.closeTodoPage();
    if (ui.items.length) ui.nav.index = 0;
    ui.nav.scroll = 0;
    syncReviewPath(ui);
    syncFileCursor(ui);
    return;
  }
  moveRemaining(ui, 1);
};

const onPrev = (ui) => {
  if (ui.nav.pane === 'unit') return void moveUnitBlock(ui, -1);
  if (ui.nav.todoOpen) return;
  if (ui.nav.index <= 0) return void ui.composer.openTodoPage();
  moveRemaining(ui, -1);
};

const scrollStep = (ui, fraction) => {
  const frame = ui.lastFrame;
  const size = ui.lastSize ?? ui.getSize();
  const rows = size.height ?? 24;
  const fallback = Math.max(1, rows - 4);
  const bodyH = frame?.bodyH ?? fallback;
  const viewing = ui.nav.pane === 'npm' && ui.npm && ui.npm.viewing;
  const viewRows = viewing ? logViewRows(bodyH) : bodyH;
  const height = Math.max(1, viewRows);
  const span = Math.floor(height * Math.abs(fraction));
  const n = Math.max(1, span);
  if (fraction < 0) return -n;
  return n;
};

const onScroll = (ui, delta) => {
  if (ui.nav.pane === 'files') return void onFileMove(ui, delta);
  if (ui.nav.pane === 'branches') {
    return void ui.gitBranches.onBranchMove(delta);
  }
  if (ui.nav.pane === 'commits') {
    return void ui.commits.onCommitMove(delta);
  }
  if (ui.nav.pane === 'npm') return void ui.npm.move(delta);
  if (ui.nav.todoOpen && ui.composer.todoRowCount() > 1) {
    return void ui.composer.moveTodoFocus(delta);
  }
  const frame = ui.lastFrame;
  const max = frame ? frame.scrollMax : null;
  const scroll = ui.nav.scroll;
  const current = max === null ? scroll : Math.min(scroll, max);
  const moved = current + delta;
  const next = max === null ? moved : Math.min(max, moved);
  ui.nav.scroll = Math.max(0, next);
  ui.nav.clearSelection();
};

const onJump = (ui, toEnd) => {
  if (LIST_PANES.includes(ui.nav.pane)) {
    const delta = toEnd ? Number.MAX_SAFE_INTEGER : -Number.MAX_SAFE_INTEGER;
    return void onScroll(ui, delta);
  }
  if (ui.nav.todoOpen && ui.composer.todoRowCount() > 0) {
    const last = ui.composer.todoRowCount() - 1;
    const target = toEnd ? last : 0;
    const at = ui.composer.clampedTodoFocus();
    return void ui.composer.moveTodoFocus(target - at);
  }
  const frame = ui.lastFrame;
  const max = frame ? frame.scrollMax : 0;
  ui.nav.scroll = toEnd ? max : 0;
  ui.nav.clearSelection();
};

const onLayout = (ui) => {
  const i = LAYOUTS.indexOf(ui.layout);
  const next = (i < 0 ? 0 : i + 1) % LAYOUTS.length;
  ui.layout = LAYOUTS[next];
  const name = LAYOUTS[next] === 'side' ? 'side-by-side' : LAYOUTS[next];
  ui.status = name;
  ui.nav.scroll = 0;
  ui.nav.clearSelection();
};

const onTheme = (ui) => {
  const i = THEME_NAMES.indexOf(themeName());
  const next = THEME_NAMES[(i + 1) % THEME_NAMES.length];
  setTheme(next);
  ui.status = next;
};

const createFilesPane = (ui) => ({
  clampIndex: () => clampIndex(ui),
  syncReviewPath: () => syncReviewPath(ui),
  syncFileCursor: () => syncFileCursor(ui),
  showFiles: () => showFiles(ui),
  onEscape: () => onEscape(ui),
  onFiles: () => onFiles(ui),
  onOpenFile: () => onOpenFile(ui),
  onFileMove: (delta) => onFileMove(ui, delta),
  onNext: () => onNext(ui),
  onPrev: () => onPrev(ui),
  scrollStep: (fraction) => scrollStep(ui, fraction),
  onScroll: (delta) => onScroll(ui, delta),
  onHome: () => onJump(ui, false),
  onEnd: () => onJump(ui, true),
  onLayout: () => onLayout(ui),
  onTheme: () => onTheme(ui),
  onFileScope: () => setFileScope(ui, 'file'),
  onDiffScope: () => setFileScope(ui, 'diff'),
});

module.exports = { LAYOUTS, createFilesPane };
