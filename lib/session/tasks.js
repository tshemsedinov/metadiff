'use strict';

const files = require('../files.js');
const { isTasksEntry, TASKS_FILE } = files;
const review = require('../review.js');
const { addTask, setTaskText, setTaskDone, removeTask, checkLabel } = review;

const TASK_TYPE_SKIP = [
  'enter',
  'escape',
  'tab',
  'backspace',
  'delete',
  'left',
  'right',
  'up',
  'down',
  'home',
  'end',
  'pageUp',
  'pageDown',
  'j',
  'k',
  'n',
  'p',
  'q',
];

const isTaskTypeKey = (key) => {
  if (!key) return false;
  if (TASK_TYPE_SKIP.includes(key)) return false;
  if (key.startsWith('ctrl-') || key.startsWith('alt-')) return false;
  return key.charCodeAt(0) >= 32;
};

const clamp = (value, last) => Math.max(0, Math.min(value, last));

class TaskPage {
  constructor(composer) {
    this.composer = composer;
  }

  get ui() {
    return this.composer.ui;
  }

  get nav() {
    return this.composer.ui.nav;
  }

  list() {
    const notes = this.ui.review.store;
    return notes ? notes.tasks : [];
  }

  editingId() {
    const composer = this.composer;
    return composer.composeKind === 'tasks' ? composer.composeTaskId : null;
  }

  isDraftCompose() {
    const composer = this.composer;
    return composer.composeKind === 'tasks' && composer.composeTaskId === null;
  }

  canToggle() {
    const nav = this.nav;
    if (!nav.tasksOpen || nav.pane !== 'diff') return false;
    return this.ui.mode === 'review';
  }

  focused() {
    return this.list()[this.clampedTaskFocus()];
  }

  closeEditor() {
    this.composer.commitCompose();
    this.composer.closeCompose();
  }

  taskTexts() {
    if (!this.nav.tasksOpen) return [];
    const tasks = this.list();
    const editor = this.composer.editor;
    const editingId = this.editingId();
    const texts = new Array(tasks.length + 1);
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const live = editingId === task.id && editor;
      texts[i] = checkLabel(live ? editor.text : task.text, task.done);
    }
    const draft = this.isDraftCompose() && editor ? editor.text : '';
    texts[tasks.length] = checkLabel(draft, false);
    return texts;
  }

  taskRowCount() {
    if (!this.nav.tasksOpen) return 0;
    return this.list().length + 1;
  }

  clampedTaskFocus() {
    return clamp(this.nav.tasksFocus, this.taskRowCount() - 1);
  }

  moveTaskFocus(delta) {
    const count = this.taskRowCount();
    if (!count) return;
    this.nav.tasksFocus = clamp(this.clampedTaskFocus() + delta, count - 1);
  }

  openTasksPage() {
    const nav = this.nav;
    nav.tasksOpen = true;
    nav.pane = 'diff';
    nav.scroll = 0;
    nav.clearSelection();
    this.ui.syncReviewPath();
  }

  closeTasksPage() {
    this.nav.tasksOpen = false;
    this.ui.syncReviewPath();
    this.ui.syncFileCursor();
    this.ui.lifecycle.catchUpWatch();
  }

  startDraftCompose() {
    this.openTasksPage();
    this.nav.tasksFocus = this.list().length;
    this.nav.scroll = 0;
    this.composer.openCompose('tasks', '', null);
  }

  editFocusedTask() {
    if (!this.nav.tasksOpen) return;
    const task = this.focused();
    if (!task) return void this.startDraftCompose();
    this.composer.openCompose('tasks', task.text, task.id);
  }

  editNextTask() {
    if (!this.nav.tasksOpen) return;
    const next = this.clampedTaskFocus() + 1;
    if (next < this.taskRowCount()) this.nav.tasksFocus = next;
    this.editFocusedTask();
  }

  moveTaskCompose(delta, width, extend) {
    if (!this.nav.tasksOpen) return;
    const editor = this.composer.editor;
    if (editor && width) {
      const before = editor.cursor;
      editor.moveLine(delta, width, extend);
      if (editor.cursor !== before || extend) return;
    }
    const at = this.clampedTaskFocus();
    const next = clamp(at + delta, this.taskRowCount() - 1);
    if (next === at) return;
    this.composer.commitCompose();
    this.ui.flushReview();
    this.composer.closeCompose();
    this.nav.tasksFocus = Math.min(next, this.taskRowCount() - 1);
    this.editFocusedTask();
  }

  typeIntoTask(key) {
    if (!this.canToggle() || !isTaskTypeKey(key)) return false;
    this.editFocusedTask();
    this.composer.editor.insert(key);
    return true;
  }

  removeFocusedTask() {
    const nav = this.nav;
    if (nav.pane !== 'diff' || !nav.tasksOpen) return;
    const task = this.focused();
    if (!task) return;
    removeTask(this.ui.review.store, task.id);
    const left = this.list().length;
    if (nav.tasksFocus >= left) nav.tasksFocus = Math.max(0, left - 1);
    this.ui.flushReview(true);
  }

  toggleFocusedTask() {
    if (!this.canToggle()) return false;
    const task = this.focused();
    if (!task) return false;
    setTaskDone(this.ui.review.store, task.id, !task.done);
    this.ui.flushReview(true);
    return true;
  }

  onTaskHit(cursor) {
    if (!this.nav.tasksOpen) return;
    const tasks = this.list();
    const draft = cursor === tasks.length;
    const target = tasks[cursor];
    if (!draft && !target) return;
    const composer = this.composer;
    if (composer.composeKind === 'tasks') {
      if (draft && composer.composeTaskId === null) return;
      if (target && target.id === composer.composeTaskId) return;
      this.closeEditor();
    }
    this.nav.tasksFocus = cursor;
    this.editFocusedTask();
  }

  onTaskCheck(cursor) {
    if (!this.nav.tasksOpen) return;
    const task = this.list()[cursor];
    if (!task) return void this.onTaskHit(cursor);
    const composer = this.composer;
    if (
      composer.composeKind === 'tasks' &&
      composer.composeTaskId !== task.id
    ) {
      this.closeEditor();
    }
    setTaskDone(this.ui.review.store, task.id, !task.done);
    this.nav.tasksFocus = cursor;
    this.ui.flushReview(true);
  }

  onTasks() {
    const { nav } = this;
    if (nav.pane === 'files') {
      const entry = this.ui.fileCursorEntry();
      if (entry && !isTasksEntry(entry)) {
        nav.index = entry.openIndex ?? entry.firstIndex;
      }
    }
    this.startDraftCompose();
  }

  taskEditView() {
    const { composeKind, editor } = this.composer;
    if (composeKind !== 'tasks' || !editor) return null;
    return { cursor: editor.cursor };
  }

  commitTask(text) {
    const notes = this.ui.review.store;
    const id = this.composer.composeTaskId;
    const prev =
      id === null ? null : notes.tasks.find((task) => task.id === id);
    if (prev) return void setTaskText(notes, id, text);
    if (!text.trim()) return;
    this.composer.composeTaskId = addTask(notes, TASKS_FILE, text).id;
  }
}

module.exports = { TaskPage };
