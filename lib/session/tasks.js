'use strict';

const path = require('node:path');

const files = require('../files.js');
const { isTasksEntry, TASKS_FILE, TASK_KINDS, taskKind, taskTitle } = files;
const { REVIEW_DIR } = files;
const review = require('../review.js');
const { addTask, setTaskText, setTaskDone, removeTask, checkLabel } = review;
const { setFeedback, setFeedbackDone, moveTask, moveFeedback } = review;
const { orderedPlanNames, allocateReviewPath } = review;
const { stopImport } = require('./import.js');
const plans = require('./agent-plans.js');
const { planKey, planPart, alignPlanLabels } = plans;
const { MenuPick, menuRows, pickDelta } = require('./menu-pick.js');

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
  'i',
  'b',
  'r',
  'c',
];

const isTaskTypeKey = (key) => {
  if (!key || key.length !== 1 || key === ' ') return false;
  if (TASK_TYPE_SKIP.includes(key)) return false;
  if (key.startsWith('ctrl-') || key.startsWith('alt-')) return false;
  return key.charCodeAt(0) >= 32;
};

const clamp = (value, last) => Math.max(0, Math.min(value, last));

const sectionTitle = (row) => {
  if (row.quote) return row.file;
  return taskTitle(row.kind);
};

const idlePick = () => false;
const NEW_PLAN = '<new plan>';
const PLAN_ROWS = 8;

const planListSize = (ui) => {
  const frame = ui.lastFrame;
  const height = frame && frame.height ? frame.height : ui.getSize().height;
  const room = Math.max(1, height - 3);
  return Math.min(room, PLAN_ROWS);
};

const planOpenScroll = (cursor, extra, count, size) => {
  const span = Math.abs(extra - cursor);
  const end = span < size ? Math.max(cursor, extra) : cursor;
  const start = Math.max(0, end - size + 1);
  const maxStart = Math.max(0, count - size);
  return Math.min(start, maxStart);
};

class TaskPage {
  constructor(composer) {
    this.composer = composer;
    this.planPick = null;
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

  quoteSections() {
    const notes = this.ui.review.store;
    if (!notes) return [];
    const groups = new Map();
    for (const [key, note] of notes.feedback) {
      if (!`${note.text ?? ''}`.trim()) continue;
      const file = note.file || key;
      let items = groups.get(file);
      if (!items) {
        items = [];
        groups.set(file, items);
      }
      items.push({ key, note });
    }
    const sections = [];
    for (const [file, items] of groups) sections.push({ file, items });
    return sections;
  }

  rows() {
    const rows = [];
    for (const kind of TASK_KINDS) {
      const tasks = this.list(kind.id);
      for (const task of tasks) {
        rows.push({ quote: false, kind: kind.id, task, draft: false });
      }
      rows.push({ quote: false, kind: kind.id, task: null, draft: true });
    }
    for (const section of this.quoteSections()) {
      for (const item of section.items) {
        rows.push({
          quote: true,
          kind: section.file,
          file: section.file,
          key: item.key,
          note: item.note,
          task: null,
          draft: false,
        });
      }
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
      if (dest.quote) {
        if (row.quote && row.key === dest.key) return i;
        continue;
      }
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
    return (
      composer.composeKind === 'tasks' &&
      composer.composeTaskId === null &&
      !composer.composeQuoteKey
    );
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
    if (!row || row.quote) return TASK_KINDS[0].id;
    return row.kind;
  }

  closeEditor() {
    this.composer.commitCompose();
    this.composer.closeCompose();
  }

  rowText(row, at) {
    const editor = this.composer.editor;
    const focus = this.clampedTaskFocus();
    if (row.draft) {
      const live = this.isDraftCompose() && at === focus && editor;
      return checkLabel(live ? editor.text : '', false);
    }
    if (row.quote) {
      const live = this.composer.composeQuoteKey === row.key && editor;
      const text = live ? editor.text : row.note.text;
      return checkLabel(text, row.note.done);
    }
    const live = this.editingId() === row.task.id && editor;
    const text = live ? editor.text : row.task.text;
    return checkLabel(text, row.task.done);
  }

  taskSections() {
    if (!this.isOpen()) return [];
    const sections = [];
    let current = null;
    let at = 0;
    for (const row of this.rows()) {
      const key = row.quote ? `quote:${row.file}` : row.kind;
      if (!current || current.key !== key) {
        current = { key, title: sectionTitle(row), texts: [] };
        sections.push(current);
      }
      current.texts.push(this.rowText(row, at));
      at += 1;
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
    this.closePlanMenu();
    if (this.ui.mode === 'import') stopImport(this.ui);
    this.ui.syncReviewPath();
    this.ui.syncFileCursor();
    this.ui.lifecycle.catchUpWatch();
  }

  startDraftCompose() {
    this.openTasksPage();
    this.nav.tasksFocus = this.list(TASK_KINDS[0].id).length;
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
    if (row.quote) {
      this.composer.openQuote(row.key, row.note.text);
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
    if (!row || row.draft) return;
    const store = this.ui.review.store;
    if (row.quote) {
      setFeedback(store, row.key, { ...row.note, text: '' });
      nav.tasksFocus = Math.min(nav.tasksFocus, this.rows().length - 1);
      nav.tasksFocus = Math.max(0, nav.tasksFocus);
      this.ui.flushReview(true);
      return;
    }
    if (!row.task) return;
    const kind = row.kind;
    removeTask(store, row.task.id);
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
    const row = this.rowAt(this.clampedTaskFocus());
    if (!row || row.draft) return false;
    const store = this.ui.review.store;
    if (row.quote) setFeedbackDone(store, row.key, !row.note.done);
    else if (row.task) setTaskDone(store, row.task.id, !row.task.done);
    else return false;
    this.ui.flushReview(true);
    return true;
  }

  followRow(dest) {
    this.nav.tasksFocus = this.rowIndex(dest);
  }

  moveIssue(delta) {
    if (!this.isOpen() || !delta) return;
    const row = this.rowAt(this.clampedTaskFocus());
    if (!row || row.draft) return;
    this.composer.commitCompose();
    const store = this.ui.review.store;
    const moved = row.quote
      ? moveFeedback(store, row.key, delta)
      : moveTask(store, row.task.id, delta);
    if (!moved) return;
    this.composer.closeCompose();
    this.followRow(row.quote ? { quote: true, key: row.key } : row);
    this.ui.flushReview(true);
  }

  sameCompose(row, cursor) {
    const composer = this.composer;
    if (cursor !== this.clampedTaskFocus()) return false;
    if (row.draft) return this.isDraftCompose();
    if (row.quote) return composer.composeQuoteKey === row.key;
    return row.task && row.task.id === composer.composeTaskId;
  }

  onTaskHit(cursor) {
    if (!this.isOpen()) return;
    this.closePlanMenu();
    const row = this.rowAt(cursor);
    if (!row) return;
    const composer = this.composer;
    if (composer.composeKind === 'tasks') {
      if (this.sameCompose(row, cursor)) return;
      this.closeEditor();
    }
    this.nav.tasksFocus = cursor;
    this.editFocusedTask();
  }

  onTaskCheck(cursor) {
    if (!this.isOpen()) return;
    const row = this.rowAt(cursor);
    if (!row || row.draft) return void this.onTaskHit(cursor);
    const composer = this.composer;
    const otherTask =
      row.task &&
      composer.composeKind === 'tasks' &&
      composer.composeTaskId !== row.task.id;
    const otherQuote =
      row.quote &&
      composer.composeKind === 'tasks' &&
      composer.composeQuoteKey !== row.key;
    if (otherTask || otherQuote) this.closeEditor();
    const store = this.ui.review.store;
    if (row.quote) setFeedbackDone(store, row.key, !row.note.done);
    else setTaskDone(store, row.task.id, !row.task.done);
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
    const key = this.composer.composeQuoteKey;
    if (key) {
      const note = notes.feedback.get(key);
      if (!note) return;
      setFeedback(notes, key, { ...note, text });
      return;
    }
    const id = this.composer.composeTaskId;
    const prev =
      id === null ? null : notes.tasks.find((task) => task.id === id);
    if (prev) return void setTaskText(notes, id, text);
    if (!text.trim()) return;
    const kind = this.focusedKind();
    const todo = addTask(notes, TASKS_FILE, text, false, kind);
    this.composer.composeTaskId = todo.id;
  }

  planName() {
    const store = this.ui.review.store;
    if (!store || !store.reviewPath) return '';
    return path.basename(store.reviewPath);
  }

  planNames() {
    const names = orderedPlanNames(this.ui.top || this.ui.cwd);
    const current = this.planName();
    if (current && !names.includes(current)) names.push(current);
    return names;
  }

  planLabels() {
    const root = this.ui.top || this.ui.cwd;
    const dir = path.join(root, REVIEW_DIR);
    const store = this.ui.review.store;
    const parts = this.planNames().map((name) => planPart(dir, name, store));
    const labels = alignPlanLabels(parts.filter(Boolean));
    labels.push(NEW_PLAN);
    return labels;
  }

  planMenu() {
    const labels = this.planLabels();
    if (!this.planPick) return labels;
    return this.planPick.filter(labels);
  }

  planQuery() {
    return this.planPick ? this.planPick.query : '';
  }

  planScroll() {
    return this.planPick ? this.planPick.scroll : 0;
  }

  closePlanMenu() {
    this.planPick = null;
    this.nav.planOpen = false;
    this.nav.planCursor = 0;
  }

  togglePlanMenu() {
    if (this.planPick) return void this.closePlanMenu();
    const labels = this.planLabels();
    if (!labels.length) return;
    const current = this.planName();
    const at = labels.findIndex((item) => planKey(item) === current);
    const cursor = at < 0 ? labels.length - 1 : at;
    const extra = labels.length - 1;
    const size = planListSize(this.ui);
    this.planPick = new MenuPick('plan', cursor);
    this.planPick.scroll = planOpenScroll(cursor, extra, labels.length, size);
    this.nav.planOpen = true;
    this.nav.planCursor = cursor;
  }

  movePlan(delta) {
    const pick = this.planPick;
    const items = this.planMenu();
    if (!pick || !items.length) return;
    pick.move(delta, items, idlePick);
    this.nav.planCursor = pick.cursor;
  }

  planStep(key) {
    const body = this.ui.lastFrame && this.ui.lastFrame.bodyH;
    return pickDelta(key, menuRows(body), menuRows(body, 0.5));
  }

  editPlanQuery(query) {
    if (!this.planPick) return;
    this.planPick.edit(query);
    this.nav.planCursor = this.planPick.cursor;
  }

  onPlanKey(key) {
    const pick = this.planPick;
    if (!pick) return;
    if (key === 'escape') return void this.closePlanMenu();
    if (key === 'enter') return void this.choosePlan(pick.cursor);
    if (key === 'backspace') {
      return void this.editPlanQuery(pick.query.slice(0, -1));
    }
    const step = this.planStep(key);
    if (step) return void this.movePlan(step);
    if (key.length === 1 && key > ' ') this.editPlanQuery(pick.query + key);
  }

  openPlan(name) {
    if (!name || name === this.planName()) return;
    this.composer.commitCompose();
    this.composer.closeCompose();
    const dir = this.ui.top || this.ui.cwd;
    if (!this.ui.review.usePlan(dir, name)) return;
    this.nav.tasksFocus = 0;
    this.nav.scroll = 0;
    this.ui.lifecycle.noteReviewStamp();
  }

  createPlan() {
    const dir = this.ui.top || this.ui.cwd;
    const reviewPath = allocateReviewPath(dir, new Date(), this.planNames());
    this.openPlan(path.basename(reviewPath));
  }

  choosePlan(index) {
    const label = this.planMenu()[index];
    const name = label ? planKey(label) : '';
    this.closePlanMenu();
    if (name === NEW_PLAN) return void this.createPlan();
    this.openPlan(name);
  }
}

module.exports = { TaskPage };
