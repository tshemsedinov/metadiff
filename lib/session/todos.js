'use strict';

const files = require('../files.js');
const { isTodosEntry, TODO_FILE } = files;
const review = require('../review.js');
const { addTodo, setTodoText, setTodoDone, removeTodo, checkLabel } = review;

const TODO_TYPE_SKIP = [
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

const isTodoTypeKey = (key) => {
  if (!key) return false;
  if (TODO_TYPE_SKIP.includes(key)) return false;
  if (key.startsWith('ctrl-')) return false;
  if (key.startsWith('alt-')) return false;
  return key.charCodeAt(0) >= 32;
};

const listTodos = (api) => {
  const notes = api.review.store;
  if (!notes) return [];
  return notes.todos;
};

const isDraftCompose = (api) => {
  const { state } = api;
  return state.composeKind === 'todo' && state.composeTodoId === null;
};

const todoTexts = (api) => {
  const nav = api.nav;
  if (!nav.todoOpen) return [];
  const todos = listTodos(api);
  const texts = new Array(todos.length + 1);
  const { state } = api;
  const editingTodo = state.composeKind === 'todo';
  const editingId = editingTodo ? state.composeTodoId : null;
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

const todoRowCount = (api) => {
  if (!api.nav.todoOpen) return 0;
  return listTodos(api).length + 1;
};

const clampedTodoFocus = (api) => {
  const last = Math.max(0, todoRowCount(api) - 1);
  const focus = api.nav.todoFocus;
  if (focus < 0) return 0;
  if (focus > last) return last;
  return focus;
};

const moveTodoFocus = (api, delta) => {
  const nav = api.nav;
  if (!nav.todoOpen) return;
  const n = todoRowCount(api);
  if (!n) return;
  const next = clampedTodoFocus(api) + delta;
  if (next < 0) nav.todoFocus = 0;
  else if (next >= n) nav.todoFocus = n - 1;
  else nav.todoFocus = next;
};

const openTodoPage = (api) => {
  const nav = api.nav;
  nav.todoOpen = true;
  nav.pane = 'diff';
  nav.scroll = 0;
  nav.clearSelection();
  api.ui.syncReviewPath();
};

const closeTodoPage = (api) => {
  api.nav.todoOpen = false;
  api.ui.syncReviewPath();
  api.ui.syncFileCursor();
  api.ui.lifecycle.catchUpWatch();
};

const focusTodoPage = (api, todoId) => {
  openTodoPage(api);
  const todos = listTodos(api);
  let focus = 0;
  if (todoId === null) {
    focus = todos.length;
  } else if (todoId !== undefined) {
    const at = todos.findIndex((todo) => todo.id === todoId);
    if (at >= 0) focus = at;
    else if (todos.length) focus = todos.length - 1;
  }
  api.nav.todoFocus = focus;
  api.nav.scroll = 0;
  return true;
};

const startDraftCompose = (api) => {
  focusTodoPage(api, null);
  api.open('todo', '', null);
};

const editFocusedTodo = (api) => {
  if (!api.nav.todoOpen) return;
  const todos = listTodos(api);
  const todo = todos[clampedTodoFocus(api)];
  if (!todo) return void startDraftCompose(api);
  api.open('todo', todo.text, todo.id);
};

const editNextTodo = (api) => {
  if (!api.nav.todoOpen) return;
  const last = todoRowCount(api) - 1;
  const next = clampedTodoFocus(api) + 1;
  if (next <= last) api.nav.todoFocus = next;
  editFocusedTodo(api);
};

const moveTodoCompose = (api, delta, width, extend) => {
  if (!api.nav.todoOpen) return;
  const editor = api.state.editor;
  if (editor && width) {
    const before = editor.cursor;
    editor.moveLine(delta, width, extend);
    if (editor.cursor !== before) return;
    if (extend) return;
  }
  const last = todoRowCount(api) - 1;
  const at = clampedTodoFocus(api);
  let next = at + delta;
  if (next < 0) next = 0;
  if (next > last) next = last;
  if (next === at) return;
  api.commit();
  api.ui.flushReview();
  api.close();
  const max = Math.max(0, todoRowCount(api) - 1);
  api.nav.todoFocus = Math.min(next, max);
  editFocusedTodo(api);
};

const typeIntoTodo = (api, key) => {
  const nav = api.nav;
  if (!nav.todoOpen) return false;
  if (nav.pane !== 'diff') return false;
  if (api.ui.mode !== 'review') return false;
  if (!isTodoTypeKey(key)) return false;
  editFocusedTodo(api);
  api.state.editor.insert(key);
  api.resetBlink();
  return true;
};

const removeFocusedTodo = (api) => {
  const nav = api.nav;
  if (nav.pane !== 'diff' || !nav.todoOpen) return;
  const todos = listTodos(api);
  const todo = todos[clampedTodoFocus(api)];
  if (!todo) return;
  const notes = api.review.store;
  removeTodo(notes, todo.id);
  const left = listTodos(api);
  if (nav.todoFocus >= left.length) {
    nav.todoFocus = Math.max(0, left.length - 1);
  }
  api.ui.flushReview(true);
};

const toggleFocusedTodo = (api) => {
  const nav = api.nav;
  if (!nav.todoOpen || nav.pane !== 'diff') return false;
  if (api.ui.mode !== 'review') return false;
  const todo = listTodos(api)[clampedTodoFocus(api)];
  if (!todo) return false;
  setTodoDone(api.review.store, todo.id, !todo.done);
  api.ui.flushReview(true);
  return true;
};

const onTodoHit = (api, cursor) => {
  if (!api.nav.todoOpen) return;
  const todos = listTodos(api);
  const draft = cursor === todos.length;
  const target = todos[cursor];
  if (!draft && !target) return;
  const { state } = api;
  if (state.composeKind === 'todo') {
    if (draft && state.composeTodoId === null) return;
    if (target && target.id === state.composeTodoId) return;
    api.commit();
    api.close();
  }
  api.nav.todoFocus = cursor;
  editFocusedTodo(api);
};

const onTodoCheck = (api, cursor) => {
  if (!api.nav.todoOpen) return;
  const todo = listTodos(api)[cursor];
  if (!todo) return void onTodoHit(api, cursor);
  const { state } = api;
  if (state.composeKind === 'todo' && state.composeTodoId !== todo.id) {
    api.commit();
    api.close();
  }
  setTodoDone(api.review.store, todo.id, !todo.done);
  api.nav.todoFocus = cursor;
  api.ui.flushReview(true);
};

const createTodo = (api) => {
  startDraftCompose(api);
};

const onTodo = (api) => {
  const { nav, ui } = api;
  if (nav.pane === 'files') {
    const entry = ui.fileCursorEntry();
    if (entry && !isTodosEntry(entry)) {
      nav.index = entry.openIndex ?? entry.firstIndex;
    }
  }
  createTodo(api);
};

const todoEditView = (api) => {
  const { state } = api;
  if (state.composeKind !== 'todo') return null;
  if (!state.editor) return null;
  return { cursor: state.editor.cursor };
};

const commitTodo = (api, text) => {
  const notes = api.review.store;
  const id = api.state.composeTodoId;
  const todos = notes.todos;
  const prev = id === null ? null : todos.find((entry) => entry.id === id);
  if (prev) return void setTodoText(notes, id, text);
  if (!text.trim()) return;
  const todo = addTodo(notes, TODO_FILE, text);
  api.state.composeTodoId = todo.id;
};

const createTodoCompose = (api) => ({
  todoTexts: () => todoTexts(api),
  clampedTodoFocus: () => clampedTodoFocus(api),
  todoRowCount: () => todoRowCount(api),
  moveTodoFocus: (delta) => moveTodoFocus(api, delta),
  openTodoPage: () => openTodoPage(api),
  closeTodoPage: () => closeTodoPage(api),
  startDraftCompose: () => startDraftCompose(api),
  editFocusedTodo: () => editFocusedTodo(api),
  editNextTodo: () => editNextTodo(api),
  moveTodoCompose: (delta, width, extend) =>
    moveTodoCompose(api, delta, width, extend),
  typeIntoTodo: (key) => typeIntoTodo(api, key),
  removeFocusedTodo: () => removeFocusedTodo(api),
  onTodoHit: (cursor) => onTodoHit(api, cursor),
  onTodoCheck: (cursor) => onTodoCheck(api, cursor),
  toggleFocusedTodo: () => toggleFocusedTodo(api),
  onTodo: () => onTodo(api),
  todoEditView: () => todoEditView(api),
  commitTodo: (text) => commitTodo(api, text),
});

module.exports = {
  TODO_TYPE_SKIP,
  isTodoTypeKey,
  createTodoCompose,
};
