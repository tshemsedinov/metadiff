'use strict';

const files = require('../common/files.js');
const { ISSUE_FILE } = files;
const { TASK_KINDS, taskKind } = files;
const { upsertTemplate } = require('./templates.js');
const { trimText } = require('../common/utilities.js');

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
    if (!trimText(task.text)) continue;
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

const kindOrder = () => TASK_KINDS.map((kind) => kind.id);

const feedbackSpots = (entries, file) => {
  const spots = [];
  for (let i = 0; i < entries.length; i++) {
    const note = entries[i][1];
    if ((note.file ?? '') !== file) continue;
    if (!trimText(note.text)) continue;
    spots.push(i);
  }
  return spots;
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

const flatTaskText = (text) => trimText(text).replace(/\n/g, ' ');

const knownTaskText = (store) => {
  const known = new Set();
  for (const task of store.tasks) known.add(flatTaskText(task.text));
  return known;
};

class ReviewStore {
  constructor(reviewPath, templates = []) {
    this.reviewPath = reviewPath;
    this.dirty = false;
    this.nextTaskId = 1;
    this.feedback = new Map();
    this.code = new Map();
    this.tasks = [];
    this.templates = [...templates];
    this.status = 'editing';
    this.baseline = null;
  }

  putNote(notes, key, note, clear) {
    const prev = notes.get(key);
    if (clear) {
      if (!prev) return;
      notes.delete(key);
      this.dirty = true;
      return;
    }
    if (prev && prev.text === (note.text ?? '')) return;
    notes.set(key, toNote(note, prev?.done));
    this.dirty = true;
  }

  setFeedback(key, note) {
    const clear = !(note.text ?? '').trim();
    this.putNote(this.feedback, key, note, clear);
  }

  setCode(key, note) {
    this.putNote(this.code, key, note, Boolean(note.clear));
  }

  addTask(file, text = '', done = false, kind = 'features') {
    const id = this.nextTaskId;
    this.nextTaskId += 1;
    const todo = { id, file, text, done, kind: taskKind({ kind }) };
    this.tasks.push(todo);
    this.dirty = true;
    return todo;
  }

  removeTask(id) {
    const tasks = this.tasks.filter((todo) => todo.id !== id);
    if (tasks.length === this.tasks.length) return false;
    this.tasks = tasks;
    this.dirty = true;
    return true;
  }

  setTaskText(id, text) {
    const i = this.tasks.findIndex((todo) => todo.id === id);
    if (i < 0) return;
    if (!text.trim()) return void this.removeTask(id);
    if (this.tasks[i].text === text) return;
    this.tasks[i] = { ...this.tasks[i], text };
    this.dirty = true;
  }

  setTaskDone(id, done) {
    const i = this.tasks.findIndex((todo) => todo.id === id);
    if (i < 0 || this.tasks[i].done === done) return;
    this.tasks[i] = { ...this.tasks[i], done };
    this.dirty = true;
  }

  setFeedbackDone(key, done) {
    const note = this.feedback.get(key);
    if (!note || note.done === done) return;
    this.feedback.set(key, { ...note, done });
    this.dirty = true;
  }

  moveTask(id, delta) {
    if (!delta) return false;
    const tasks = this.tasks;
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
      this.tasks = next;
      this.dirty = true;
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
    this.tasks = rest;
    this.dirty = true;
    return true;
  }

  moveFeedback(key, delta) {
    if (!delta) return false;
    const note = this.feedback.get(key);
    if (!note) return false;
    const entries = [...this.feedback];
    const spots = feedbackSpots(entries, note.file ?? '');
    const at = spots.findIndex((i) => entries[i][0] === key);
    if (at < 0) return false;
    const neighbor = spots[at + delta];
    if (neighbor === undefined) return false;
    const next = entries.slice();
    const swap = next[spots[at]];
    next[spots[at]] = next[neighbor];
    next[neighbor] = swap;
    this.feedback = new Map(next);
    this.dirty = true;
    return true;
  }

  applyImportedNotes(imported) {
    if (!imported) return;
    const feedbacks = imported.feedback ?? [];
    for (const note of feedbacks) {
      const key = feedbackKey(note);
      const prev = this.feedback.get(key);
      const text = prev ? `${prev.text}\n\n${note.text}` : note.text;
      const done = prev ? prev.done && !!note.done : !!note.done;
      this.setFeedback(key, { ...note, text, done });
    }
    const todos = imported.tasks ?? imported.todos ?? [];
    const known = knownTaskText(this);
    for (const todo of todos) {
      const text = todo.text ?? '';
      const file = todo.file || '';
      const same = file === ISSUE_FILE && known.has(flatTaskText(text));
      if (same) continue;
      this.addTask(file, text, !!todo.done);
      if (file === ISSUE_FILE) known.add(flatTaskText(text));
    }
  }

  rememberTemplate(prevText, nextText) {
    const trimmed = nextText.trim();
    if (!trimmed) return;
    const prev = (prevText ?? '').trim();
    if (prev === trimmed) return;
    this.templates = upsertTemplate(this.templates, trimmed);
    this.dirty = true;
  }
}

module.exports = {
  ReviewStore,
  noteCounts,
  reviewProgress,
  hasNotes,
  toNote,
  checkLabel,
  feedbackKey,
  flatTaskText,
};
