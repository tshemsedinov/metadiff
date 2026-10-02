'use strict';

const files = require('../files.js');
const { listPath, isTaskItem, isTasksEntry, TASKS_FILE } = files;
const actions = require('./actions.js');
const { LIST_PANES } = actions;

const freshListScroll = () =>
  Object.fromEntries(LIST_PANES.map((pane) => [pane, 0]));

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
    this.listScrollByPane = freshListScroll();
    this.reviewPath = null;
    this.fileScope = 'diff';
    this.unitLine = 0;
    this.selection = null;
    this.mouseAnchor = null;
    this.pendingClick = null;
    this.lastClick = null;
    this.tasksOpen = false;
    this.tasksFocus = 0;
    this.find = null;
  }

  clampIndex(length) {
    if (!length) {
      this.index = 0;
      return;
    }
    if (this.index < 0) this.index = 0;
    if (this.index >= length) this.index = length - 1;
  }

  current(items, tasksItem) {
    if (this.tasksOpen) return tasksItem;
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
      (entry) => !isTasksEntry(entry) && entry.path === this.reviewPath,
    );
    if (this.reviewPath === TASKS_FILE || isTaskItem(item)) {
      idx = fileList.findIndex((entry) => isTasksEntry(entry));
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

  get listScroll() {
    return this.listScrollByPane[this.pane] ?? 0;
  }

  set listScroll(value) {
    if (!LIST_PANES.includes(this.pane)) return;
    this.listScrollByPane[this.pane] = value ?? 0;
  }

  resetListScroll(pane = this.pane) {
    if (!LIST_PANES.includes(pane)) return;
    this.listScrollByPane[pane] = 0;
  }
}

module.exports = { Navigation };
