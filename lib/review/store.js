'use strict';

const files = require('../common/files.js');
const { TASK_KINDS, taskKind } = files;

const createStore = (reviewPath, templates = []) => ({
  reviewPath,
  dirty: false,
  nextTaskId: 1,
  feedback: new Map(),
  code: new Map(),
  tasks: [],
  templates: [...templates],
  status: 'editing',
  baseline: null,
});

const noteCounts = (store) => {
  const counts = { feedback: 0, tasks: 0, tasksDone: 0, code: 0 };
  if (!store) return counts;
  for (const task of store.tasks) {
    if (!task.text.trim()) continue;
    counts.tasks += 1;
    if (task.done) counts.tasksDone += 1;
  }
  for (const note of store.feedback.values()) {
    if (note.text.trim()) counts.feedback += 1;
  }
  counts.code = store.code.size;
  return counts;
};

const reviewProgress = (store) => {
  let done = 0;
  let total = 0;
  if (!store) return { done, total };
  for (const task of store.tasks) {
    if (!`${task.text ?? ''}`.trim()) continue;
    total += 1;
    if (task.done) done += 1;
  }
  for (const note of store.feedback.values()) {
    total += 1;
    if (note.done) done += 1;
  }
  for (const note of store.code.values()) {
    total += 1;
    if (note.done) done += 1;
  }
  return { done, total };
};

const hasNotes = (store) => {
  const counts = noteCounts(store);
  return counts.feedback > 0 || counts.tasks > 0 || counts.code > 0;
};

const toNote = (note, done = false) => ({
  file: note.file,
  oldStart: note.oldStart ?? 0,
  newStart: note.newStart ?? 0,
  blockId: note.blockId ?? 0,
  origin: note.origin ?? '',
  header: note.header ?? '',
  text: note.text ?? '',
  done: note.done ?? done,
});

const putNote = (store, notes, key, note, clear) => {
  const prev = notes.get(key);
  if (clear) {
    if (!prev) return;
    notes.delete(key);
    store.dirty = true;
    return;
  }
  if (prev && prev.text === (note.text ?? '')) return;
  notes.set(key, toNote(note, prev?.done));
  store.dirty = true;
};

const setFeedback = (store, key, note) => {
  const clear = !(note.text ?? '').trim();
  putNote(store, store.feedback, key, note, clear);
};

const setCode = (store, key, note) => {
  putNote(store, store.code, key, note, Boolean(note.clear));
};

const addTask = (store, file, text = '', done = false, kind = 'features') => {
  const id = store.nextTaskId;
  store.nextTaskId += 1;
  const todo = { id, file, text, done, kind: taskKind({ kind }) };
  store.tasks.push(todo);
  store.dirty = true;
  return todo;
};

const removeTask = (store, id) => {
  const tasks = store.tasks.filter((todo) => todo.id !== id);
  if (tasks.length === store.tasks.length) return false;
  store.tasks = tasks;
  store.dirty = true;
  return true;
};

const setTaskText = (store, id, text) => {
  const i = store.tasks.findIndex((todo) => todo.id === id);
  if (i < 0) return;
  if (!text.trim()) return void removeTask(store, id);
  if (store.tasks[i].text === text) return;
  store.tasks[i] = { ...store.tasks[i], text };
  store.dirty = true;
};

const setTaskDone = (store, id, done) => {
  const i = store.tasks.findIndex((todo) => todo.id === id);
  if (i < 0 || store.tasks[i].done === done) return;
  store.tasks[i] = { ...store.tasks[i], done };
  store.dirty = true;
};

const setFeedbackDone = (store, key, done) => {
  const note = store.feedback.get(key);
  if (!note || note.done === done) return;
  store.feedback.set(key, { ...note, done });
  store.dirty = true;
};

const kindOrder = () => TASK_KINDS.map((kind) => kind.id);

const moveTask = (store, id, delta) => {
  if (!store || !delta) return false;
  const tasks = store.tasks;
  const index = tasks.findIndex((task) => task.id === id);
  if (index < 0) return false;
  const task = tasks[index];
  const kind = taskKind(task);
  const order = kindOrder();
  const same = [];
  for (let i = 0; i < tasks.length; i++) {
    if (taskKind(tasks[i]) === kind) same.push(i);
  }
  const at = same.indexOf(index);
  const neighbor = same[at + delta];
  if (neighbor !== undefined) {
    const next = tasks.slice();
    const swap = next[index];
    next[index] = next[neighbor];
    next[neighbor] = swap;
    store.tasks = next;
    store.dirty = true;
    return true;
  }
  const dest = order[order.indexOf(kind) + delta];
  if (!dest) return false;
  const rest = [];
  for (const item of tasks) {
    if (item.id !== id) rest.push(item);
  }
  let insertAt;
  if (delta > 0) {
    const first = rest.findIndex((item) => taskKind(item) === dest);
    insertAt = first < 0 ? rest.length : first;
  } else {
    let last = -1;
    for (let i = 0; i < rest.length; i++) {
      if (taskKind(rest[i]) === dest) last = i;
    }
    insertAt = last + 1;
  }
  rest.splice(insertAt, 0, { ...task, kind: dest });
  store.tasks = rest;
  store.dirty = true;
  return true;
};

const feedbackSpots = (entries, file) => {
  const spots = [];
  for (let i = 0; i < entries.length; i++) {
    const note = entries[i][1];
    if ((note.file ?? '') !== file) continue;
    if (!`${note.text ?? ''}`.trim()) continue;
    spots.push(i);
  }
  return spots;
};

const moveFeedback = (store, key, delta) => {
  if (!store || !delta) return false;
  const note = store.feedback.get(key);
  if (!note) return false;
  const entries = [...store.feedback];
  const spots = feedbackSpots(entries, note.file ?? '');
  const at = spots.findIndex((i) => entries[i][0] === key);
  if (at < 0) return false;
  const neighbor = spots[at + delta];
  if (neighbor === undefined) return false;
  const next = entries.slice();
  const swap = next[spots[at]];
  next[spots[at]] = next[neighbor];
  next[neighbor] = swap;
  store.feedback = new Map(next);
  store.dirty = true;
  return true;
};

const checkLabel = (text, done) => {
  const mark = done ? 'x' : ' ';
  return `[${mark}] ${text}`;
};

const feedbackKey = (note) => {
  const file = note.file ?? '';
  const oldStart = note.oldStart ?? 0;
  const newStart = note.newStart ?? 0;
  const block = note.blockId ?? 0;
  return `${file}:${oldStart}:${newStart}:${block}`;
};

const ISSUE_TASK_FILE = 'issue';

const flatTaskText = (text) => `${text ?? ''}`.trim().replace(/\n/g, ' ');

const knownTaskText = (store) => {
  const known = new Set();
  for (const task of store.tasks) known.add(flatTaskText(task.text));
  return known;
};

const applyImportedNotes = (store, imported) => {
  if (!store || !imported) return;
  const feedbacks = imported.feedback ?? [];
  for (const note of feedbacks) {
    const key = feedbackKey(note);
    const prev = store.feedback.get(key);
    const text = prev ? `${prev.text}\n\n${note.text}` : note.text;
    const done = prev ? prev.done && !!note.done : !!note.done;
    setFeedback(store, key, { ...note, text, done });
  }
  const todos = imported.tasks ?? imported.todos ?? [];
  const known = knownTaskText(store);
  for (const todo of todos) {
    const text = todo.text ?? '';
    const file = todo.file || '';
    const same = file === ISSUE_TASK_FILE && known.has(flatTaskText(text));
    if (same) continue;
    addTask(store, file, text, !!todo.done);
    if (file === ISSUE_TASK_FILE) known.add(flatTaskText(text));
  }
};

module.exports = {
  createStore,
  noteCounts,
  reviewProgress,
  hasNotes,
  toNote,
  setFeedback,
  setCode,
  addTask,
  removeTask,
  setTaskText,
  setTaskDone,
  setFeedbackDone,
  moveTask,
  moveFeedback,
  checkLabel,
  feedbackKey,
  flatTaskText,
  applyImportedNotes,
};
