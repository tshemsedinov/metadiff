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
  if (key.startsWith('ctrl-')) return false;
  if (key.startsWith('alt-')) return false;
  return key.charCodeAt(0) >= 32;
};

const listTasks = (api) => {
  const notes = api.review.store;
  if (!notes) return [];
  return notes.tasks;
};

const isDraftCompose = (api) => {
  const { state } = api;
  return state.composeKind === 'tasks' && state.composeTaskId === null;
};

const taskTexts = (api) => {
  const nav = api.nav;
  if (!nav.tasksOpen) return [];
  const todos = listTasks(api);
  const texts = new Array(todos.length + 1);
  const { state } = api;
  const editingTodo = state.composeKind === 'tasks';
  const editingId = editingTodo ? state.composeTaskId : null;
  for (let i = 0; i < todos.length; i++) {
    const todo = todos[i];
    const live = editingId === todo.id && state.editor;
    const text = live ? state.editor.text : todo.text;
    texts[i] = checkLabel(text, todo.done);
  }
  const draft = isDraftCompose(api) && state.editor ? state.editor.text : '';
  texts[todos.length] = checkLabel(draft, false);
  return texts;
};

const taskRowCount = (api) => {
  if (!api.nav.tasksOpen) return 0;
  return listTasks(api).length + 1;
};

const clampedTaskFocus = (api) => {
  const last = Math.max(0, taskRowCount(api) - 1);
  const focus = api.nav.tasksFocus;
  if (focus < 0) return 0;
  if (focus > last) return last;
  return focus;
};

const moveTaskFocus = (api, delta) => {
  const nav = api.nav;
  if (!nav.tasksOpen) return;
  const n = taskRowCount(api);
  if (!n) return;
  const next = clampedTaskFocus(api) + delta;
  if (next < 0) nav.tasksFocus = 0;
  else if (next >= n) nav.tasksFocus = n - 1;
  else nav.tasksFocus = next;
};

const openTasksPage = (api) => {
  const nav = api.nav;
  nav.tasksOpen = true;
  nav.pane = 'diff';
  nav.scroll = 0;
  nav.clearSelection();
  api.ui.syncReviewPath();
};

const closeTasksPage = (api) => {
  api.nav.tasksOpen = false;
  api.ui.syncReviewPath();
  api.ui.syncFileCursor();
  api.ui.lifecycle.catchUpWatch();
};

const focusTodoPage = (api, todoId) => {
  openTasksPage(api);
  const todos = listTasks(api);
  let focus = 0;
  if (todoId === null) {
    focus = todos.length;
  } else if (todoId !== undefined) {
    const at = todos.findIndex((todo) => todo.id === todoId);
    if (at >= 0) focus = at;
    else if (todos.length) focus = todos.length - 1;
  }
  api.nav.tasksFocus = focus;
  api.nav.scroll = 0;
  return true;
};

const startDraftCompose = (api) => {
  focusTodoPage(api, null);
  api.open('tasks', '', null);
};

const editFocusedTask = (api) => {
  if (!api.nav.tasksOpen) return;
  const todos = listTasks(api);
  const todo = todos[clampedTaskFocus(api)];
  if (!todo) return void startDraftCompose(api);
  api.open('tasks', todo.text, todo.id);
};

const editNextTask = (api) => {
  if (!api.nav.tasksOpen) return;
  const last = taskRowCount(api) - 1;
  const next = clampedTaskFocus(api) + 1;
  if (next <= last) api.nav.tasksFocus = next;
  editFocusedTask(api);
};

const moveTaskCompose = (api, delta, width, extend) => {
  if (!api.nav.tasksOpen) return;
  const editor = api.state.editor;
  if (editor && width) {
    const before = editor.cursor;
    editor.moveLine(delta, width, extend);
    if (editor.cursor !== before) return;
    if (extend) return;
  }
  const last = taskRowCount(api) - 1;
  const at = clampedTaskFocus(api);
  let next = at + delta;
  if (next < 0) next = 0;
  if (next > last) next = last;
  if (next === at) return;
  api.commit();
  api.ui.flushReview();
  api.close();
  const max = Math.max(0, taskRowCount(api) - 1);
  api.nav.tasksFocus = Math.min(next, max);
  editFocusedTask(api);
};

const typeIntoTask = (api, key) => {
  const nav = api.nav;
  if (!nav.tasksOpen) return false;
  if (nav.pane !== 'diff') return false;
  if (api.ui.mode !== 'review') return false;
  if (!isTaskTypeKey(key)) return false;
  editFocusedTask(api);
  api.state.editor.insert(key);
  api.resetBlink();
  return true;
};

const removeFocusedTask = (api) => {
  const nav = api.nav;
  if (nav.pane !== 'diff' || !nav.tasksOpen) return;
  const todos = listTasks(api);
  const todo = todos[clampedTaskFocus(api)];
  if (!todo) return;
  const notes = api.review.store;
  removeTask(notes, todo.id);
  const left = listTasks(api);
  if (nav.tasksFocus >= left.length) {
    nav.tasksFocus = Math.max(0, left.length - 1);
  }
  api.ui.flushReview(true);
};

const toggleFocusedTask = (api) => {
  const nav = api.nav;
  if (!nav.tasksOpen || nav.pane !== 'diff') return false;
  if (api.ui.mode !== 'review') return false;
  const todo = listTasks(api)[clampedTaskFocus(api)];
  if (!todo) return false;
  setTaskDone(api.review.store, todo.id, !todo.done);
  api.ui.flushReview(true);
  return true;
};

const onTaskHit = (api, cursor) => {
  if (!api.nav.tasksOpen) return;
  const todos = listTasks(api);
  const draft = cursor === todos.length;
  const target = todos[cursor];
  if (!draft && !target) return;
  const { state } = api;
  if (state.composeKind === 'tasks') {
    if (draft && state.composeTaskId === null) return;
    if (target && target.id === state.composeTaskId) return;
    api.commit();
    api.close();
  }
  api.nav.tasksFocus = cursor;
  editFocusedTask(api);
};

const onTaskCheck = (api, cursor) => {
  if (!api.nav.tasksOpen) return;
  const todo = listTasks(api)[cursor];
  if (!todo) return void onTaskHit(api, cursor);
  const { state } = api;
  if (state.composeKind === 'tasks' && state.composeTaskId !== todo.id) {
    api.commit();
    api.close();
  }
  setTaskDone(api.review.store, todo.id, !todo.done);
  api.nav.tasksFocus = cursor;
  api.ui.flushReview(true);
};

const createTask = (api) => {
  startDraftCompose(api);
};

const onTasks = (api) => {
  const { nav, ui } = api;
  if (nav.pane === 'files') {
    const entry = ui.fileCursorEntry();
    if (entry && !isTasksEntry(entry)) {
      nav.index = entry.openIndex ?? entry.firstIndex;
    }
  }
  createTask(api);
};

const taskEditView = (api) => {
  const { state } = api;
  if (state.composeKind !== 'tasks') return null;
  if (!state.editor) return null;
  return { cursor: state.editor.cursor };
};

const commitTask = (api, text) => {
  const notes = api.review.store;
  const id = api.state.composeTaskId;
  const todos = notes.tasks;
  const prev = id === null ? null : todos.find((entry) => entry.id === id);
  if (prev) return void setTaskText(notes, id, text);
  if (!text.trim()) return;
  const todo = addTask(notes, TASKS_FILE, text);
  api.state.composeTaskId = todo.id;
};

const createTasksCompose = (api) => ({
  taskTexts: () => taskTexts(api),
  clampedTaskFocus: () => clampedTaskFocus(api),
  taskRowCount: () => taskRowCount(api),
  moveTaskFocus: (delta) => moveTaskFocus(api, delta),
  openTasksPage: () => openTasksPage(api),
  closeTasksPage: () => closeTasksPage(api),
  startDraftCompose: () => startDraftCompose(api),
  editFocusedTask: () => editFocusedTask(api),
  editNextTask: () => editNextTask(api),
  moveTaskCompose: (delta, width, extend) =>
    moveTaskCompose(api, delta, width, extend),
  typeIntoTask: (key) => typeIntoTask(api, key),
  removeFocusedTask: () => removeFocusedTask(api),
  onTaskHit: (cursor) => onTaskHit(api, cursor),
  onTaskCheck: (cursor) => onTaskCheck(api, cursor),
  toggleFocusedTask: () => toggleFocusedTask(api),
  onTasks: () => onTasks(api),
  taskEditView: () => taskEditView(api),
  commitTask: (text) => commitTask(api, text),
});

module.exports = {
  createTasksCompose,
};
