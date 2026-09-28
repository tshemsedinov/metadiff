'use strict';

const files = require('../files.js');
const { listPath, isTodoItem, isTodosEntry, TODO_FILE } = files;

class Navigation {
  constructor(options = {}) {
    this.reset(options.startPane ?? 'files');
  }

  reset(startPane = this.pane) {
    this.pane = startPane;
    this.index = 0;
    this.fileCursor = 0;
    this.branchCursor = 0;
    this.commitCursor = 0;
    this.npmCursor = 0;
    this.scroll = 0;
    this.listScroll = 0;
    this.reviewPath = null;
    this.fileScope = 'diff';
    this.unitLine = 0;
    this.selection = null;
    this.mouseAnchor = null;
    this.pendingClick = null;
    this.lastClick = null;
    this.todoOpen = false;
    this.todoFocus = 0;
  }

  clampIndex(length) {
    if (!length) {
      this.index = 0;
      return;
    }
    if (this.index < 0) this.index = 0;
    if (this.index >= length) this.index = length - 1;
  }

  current(items, todoItem) {
    if (this.todoOpen) return todoItem;
    if (this.pane === 'unit' && this.reviewPath) {
      const item = items[this.index];
      if (item && listPath(item) === this.reviewPath) return item;
      for (const entry of items) {
        if (listPath(entry) === this.reviewPath) return entry;
      }
      return null;
    }
    return items[this.index] ?? null;
  }

  syncReviewPath(item) {
    if (this.pane !== 'diff' && this.pane !== 'unit') return;
    if (this.pane === 'unit' && this.reviewPath) return;
    this.reviewPath = item ? listPath(item) : null;
  }

  clampFileCursor(length) {
    if (!length) {
      this.fileCursor = 0;
      return;
    }
    if (this.fileCursor >= length) this.fileCursor = length - 1;
  }

  followReviewPath(fileList, item) {
    if (!fileList.length) {
      this.fileCursor = 0;
      return;
    }
    let idx = fileList.findIndex(
      (entry) => !isTodosEntry(entry) && entry.path === this.reviewPath,
    );
    if (this.reviewPath === TODO_FILE || isTodoItem(item)) {
      idx = fileList.findIndex((entry) => isTodosEntry(entry));
    }
    if (idx >= 0) {
      this.fileCursor = idx;
      return;
    }
    this.clampFileCursor(fileList.length);
  }

  restoreFileCursor(fileList) {
    if (this.pane !== 'files') return;
    this.followReviewPath(fileList, null);
  }

  clearSelection() {
    this.selection = null;
    this.mouseAnchor = null;
    this.pendingClick = null;
  }
}

module.exports = { Navigation };
