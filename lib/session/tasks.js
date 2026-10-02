'use strict';

const files = require('../files.js');
const { isTasksEntry, TASKS_FILE, TASK_KINDS, taskKind } = files;
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
  'f',
  'd',
  't',
  'b',
  'r',
  'c',
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

  isOpen() {
    return this.nav.pane === 'tasks';
  }

  list(kind) {
    const notes = this.ui.review.store;
    if (!notes) return [];
    const rows = [];
    for (const task of notes.tasks) {
      if (taskKind(task) === kind) rows.push(task);
    }
    return rows;
  }

  rows() {
    const rows = [];
    for (const kind of TASK_KINDS) {
      const tasks = this.list(kind.id);
      for (const task of tasks) {
        rows.push({ kind: kind.id, task, draft: false });
      }
      rows.push({ kind: kind.id, task: null, draft: true });
    }
    return rows;
  }

  rowAt(index) {
    return this.rows()[index] ?? null;
  }

  rowIndex(dest) {
    const rows = this.rows();
    if (!dest) return 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (dest.draft) {
        if (row.draft && row.kind === dest.kind) return i;
        continue;
      }
      if (row.task && dest.task && row.task.id === dest.task.id) return i;
    }
    return clamp(0, rows.length - 1);
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
    if (!this.isOpen()) return false;
    return this.ui.mode === 'review';
  }

  focused() {
    const row = this.rowAt(this.clampedTaskFocus());
    return row && row.task ? row.task : null;
  }

  focusedKind() {
    const row = this.rowAt(this.clampedTaskFocus());
    return row ? row.kind : 'backlog';
  }

  closeEditor() {
    this.composer.commitCompose();
    this.composer.closeCompose();
  }

  taskSections() {
    if (!this.isOpen()) return [];
    const editor = this.composer.editor;
    const editingId = this.editingId();
    const draft = this.isDraftCompose();
    const focus = this.clampedTaskFocus();
    let at = 0;
    const sections = [];
    for (const kind of TASK_KINDS) {
      const tasks = this.list(kind.id);
      const texts = [];
      for (const task of tasks) {
        const live = editingId === task.id && editor;
        texts.push(checkLabel(live ? editor.text : task.text, task.done));
        at += 1;
      }
      const drafting = draft && at === focus && editor;
      texts.push(checkLabel(drafting ? editor.text : '', false));
      at += 1;
      sections.push({ title: kind.title, texts });
    }
    return sections;
  }

  taskTexts() {
    const texts = [];
    for (const section of this.taskSections()) texts.push(...section.texts);
    return texts;
  }

  taskRowCount() {
    if (!this.isOpen()) return 0;
    return this.rows().length;
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
    nav.pane = 'tasks';
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
    this.nav.tasksFocus = this.list('backlog').length;
    this.nav.scroll = 0;
    this.composer.openCompose('tasks', '', null);
  }

  editFocusedTask() {
    if (!this.isOpen()) return;
    const row = this.rowAt(this.clampedTaskFocus());
    if (!row || row.draft) {
      this.composer.openCompose('tasks', '', null);
      return;
    }
    this.composer.openCompose('tasks', row.task.text, row.task.id);
  }

  editNextTask() {
    if (!this.isOpen()) return;
    const next = this.clampedTaskFocus() + 1;
    if (next < this.taskRowCount()) this.nav.tasksFocus = next;
    this.editFocusedTask();
  }

  moveTaskCompose(delta, width, extend) {
    if (!this.isOpen()) return;
    const editor = this.composer.editor;
    if (editor && width) {
      const before = editor.cursor;
      editor.moveLine(delta, width, extend);
      if (editor.cursor !== before || extend) return;
    }
    const rows = this.rows();
    const at = this.clampedTaskFocus();
    const next = clamp(at + delta, rows.length - 1);
    if (next === at) return;
    const dest = rows[next];
    this.composer.commitCompose();
    this.ui.flushReview();
    this.composer.closeCompose();
    this.nav.tasksFocus = this.rowIndex(dest);
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
    if (!this.isOpen()) return;
    const row = this.rowAt(this.clampedTaskFocus());
    if (!row || !row.task) return;
    const kind = row.kind;
    removeTask(this.ui.review.store, row.task.id);
    const rows = this.rows();
    let focus = Math.min(nav.tasksFocus, rows.length - 1);
    const at = rows[focus];
    const prev = rows[focus - 1];
    if (at && at.draft && prev && prev.task && prev.kind === kind) {
      focus -= 1;
    }
    nav.tasksFocus = Math.max(0, focus);
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
    if (!this.isOpen()) return;
    const row = this.rowAt(cursor);
    if (!row) return;
    const composer = this.composer;
    if (composer.composeKind === 'tasks') {
      const same =
        cursor === this.clampedTaskFocus() &&
        ((row.draft && composer.composeTaskId === null) ||
          (row.task && row.task.id === composer.composeTaskId));
      if (same) return;
      this.closeEditor();
    }
    this.nav.tasksFocus = cursor;
    this.editFocusedTask();
  }

  onTaskCheck(cursor) {
    if (!this.isOpen()) return;
    const row = this.rowAt(cursor);
    if (!row || !row.task) return void this.onTaskHit(cursor);
    const composer = this.composer;
    if (
      composer.composeKind === 'tasks' &&
      composer.composeTaskId !== row.task.id
    ) {
      this.closeEditor();
    }
    setTaskDone(this.ui.review.store, row.task.id, !row.task.done);
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
    const kind = this.focusedKind();
    const todo = addTask(notes, TASKS_FILE, text, false, kind);
    this.composer.composeTaskId = todo.id;
  }
}

module.exports = { TaskPage };
