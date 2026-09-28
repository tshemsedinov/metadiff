'use strict';

const files = require('../files.js');
const { listPath, isTodoItem, isTodosEntry, TODO_FILE } = files;

const initialState = (options = {}) => ({
  pane: options.startPane ?? 'files',
  index: 0,
  fileCursor: 0,
  branchCursor: 0,
  commitCursor: 0,
  npmCursor: 0,
  scroll: 0,
  listScroll: 0,
  reviewPath: null,
  fileScope: 'diff',
  unitLine: 0,
  selection: null,
  mouseAnchor: null,
  pendingClick: null,
  lastClick: null,
  todoOpen: false,
  todoFocus: 0,
});

const clampIndex = (nav, length) => {
  if (!length) {
    nav.index = 0;
    return;
  }
  if (nav.index < 0) nav.index = 0;
  if (nav.index >= length) nav.index = length - 1;
};

const current = (nav, items, todoItem) => {
  if (nav.todoOpen) return todoItem;
  if (nav.pane === 'unit' && nav.reviewPath) {
    const item = items[nav.index];
    if (item && listPath(item) === nav.reviewPath) return item;
    for (const entry of items) {
      if (listPath(entry) === nav.reviewPath) return entry;
    }
    return null;
  }
  return items[nav.index] ?? null;
};

const syncReviewPath = (nav, item) => {
  if (nav.pane !== 'diff' && nav.pane !== 'unit') return;
  if (nav.pane === 'unit' && nav.reviewPath) return;
  nav.reviewPath = item ? listPath(item) : null;
};

const clampFileCursor = (nav, length) => {
  if (!length) {
    nav.fileCursor = 0;
    return;
  }
  if (nav.fileCursor >= length) nav.fileCursor = length - 1;
};

const followReviewPath = (nav, fileList, item) => {
  if (!fileList.length) {
    nav.fileCursor = 0;
    return;
  }
  let idx = fileList.findIndex(
    (entry) => !isTodosEntry(entry) && entry.path === nav.reviewPath,
  );
  if (nav.reviewPath === TODO_FILE || isTodoItem(item)) {
    idx = fileList.findIndex((entry) => isTodosEntry(entry));
  }
  if (idx >= 0) {
    nav.fileCursor = idx;
    return;
  }
  clampFileCursor(nav, fileList.length);
};

const restoreFileCursor = (nav, fileList) => {
  if (nav.pane !== 'files') return;
  followReviewPath(nav, fileList, null);
};

const clearSelection = (nav) => {
  nav.selection = null;
  nav.mouseAnchor = null;
  nav.pendingClick = null;
};

const createNavigation = (options = {}) => {
  const nav = initialState(options);
  nav.reset = (startPane) => {
    const pane = startPane ?? nav.pane;
    Object.assign(nav, initialState({ startPane: pane }));
  };
  nav.clampIndex = (length) => clampIndex(nav, length);
  nav.current = (items, todoItem) => current(nav, items, todoItem);
  nav.syncReviewPath = (item) => syncReviewPath(nav, item);
  nav.clampFileCursor = (length) => clampFileCursor(nav, length);
  nav.followReviewPath = (list, item) => followReviewPath(nav, list, item);
  nav.restoreFileCursor = (list) => restoreFileCursor(nav, list);
  nav.clearSelection = () => clearSelection(nav);
  return nav;
};

module.exports = { createNavigation };
