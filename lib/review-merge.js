'use strict';

const files = require('./files.js');
const { TODO_FILE } = files;

const flatText = (text) => `${text ?? ''}`.trim().replace(/\n/g, ' ');

const snapTodo = (todo) => ({
  file: todo.file ?? '',
  text: flatText(todo.text),
  done: todo.done === true,
});

const snapList = (todos) => {
  const list = [];
  for (const todo of todos ?? []) {
    const snap = snapTodo(todo);
    if (!snap.text) continue;
    list.push(snap);
  }
  return list;
};

const copyMap = (map) => {
  const next = new Map();
  if (!map) return next;
  for (const [key, note] of map) next.set(key, { ...note });
  return next;
};

const snapshotSide = (store) => ({
  status: store.status,
  todos: snapList(store.todos),
  feedback: copyMap(store.feedback),
  code: copyMap(store.code),
});

const captureBaseline = (store) => {
  store.baseline = snapshotSide(store);
};

const claim = (list, used, text, read) => {
  for (let i = 0; i < list.length; i++) {
    if (used[i]) continue;
    if (read(list[i]) !== text) continue;
    used[i] = true;
    return i;
  }
  return -1;
};

const pickDone = (baseDone, ourDone, theirDone) => {
  if (ourDone === theirDone) return ourDone;
  if (theirDone === baseDone) return ourDone;
  if (ourDone === baseDone) return theirDone;
  return ourDone;
};

const withDone = (todo, done) => {
  if (todo.done === done) return todo;
  return { id: todo.id, file: todo.file, text: todo.text, done };
};

const liveText = (todo) => flatText(todo.text);

const snapText = (snap) => snap.text;

const flags = (n) => new Array(n).fill(false);

const adoptTodo = (store, snap) => {
  const id = store.nextTodoId;
  store.nextTodoId += 1;
  const file = snap.file || TODO_FILE;
  return { id, file, text: snap.text, done: snap.done };
};

const replaceTodo = (todo, snap) => ({
  id: todo.id,
  file: todo.file,
  text: snap.text,
  done: snap.done,
});

class TodoMerge {
  constructor(store, theirs) {
    this.store = store;
    this.ours = store.todos.filter((todo) => liveText(todo));
    this.theirs = theirs;
    this.usedOurs = flags(this.ours.length);
    this.usedTheirs = flags(theirs.length);
    this.kept = flags(this.ours.length);
    this.dropped = flags(this.ours.length);
    this.theirKeep = flags(theirs.length);
    this.alias = new Map();
  }

  keepOurs(index, text) {
    this.kept[index] = true;
    this.alias.set(text, this.ours[index]);
  }

  mergeBase(base) {
    const { ours, theirs } = this;
    const text = base.text;
    const oi = claim(ours, this.usedOurs, text, liveText);
    const ti = claim(theirs, this.usedTheirs, text, snapText);
    if (oi >= 0 && ti >= 0) {
      const done = pickDone(base.done, ours[oi].done === true, theirs[ti].done);
      ours[oi] = withDone(ours[oi], done);
      this.keepOurs(oi, text);
    } else if (oi >= 0) {
      if (ours[oi].done === base.done) this.dropped[oi] = true;
      else this.keepOurs(oi, text);
    } else if (ti >= 0 && theirs[ti].done !== base.done) {
      this.theirKeep[ti] = true;
    }
  }

  mergeFresh(index) {
    const { ours, theirs } = this;
    const text = liveText(ours[index]);
    const ti = claim(theirs, this.usedTheirs, text, snapText);
    if (ti < 0) {
      this.kept[index] = true;
      return;
    }
    const done = ours[index].done === true || theirs[ti].done === true;
    ours[index] = withDone(ours[index], done);
    this.keepOurs(index, text);
  }

  findMerged(merged, text) {
    const linked = this.alias.get(text);
    const at = linked ? merged.indexOf(linked) : -1;
    if (at >= 0) return at;
    return merged.findIndex((todo) => liveText(todo) === text);
  }

  theirPlace(merged, index) {
    const { theirs } = this;
    for (let j = index - 1; j >= 0; j--) {
      const prev = this.findMerged(merged, theirs[j].text);
      if (prev >= 0) return prev + 1;
    }
    for (let j = index + 1; j < theirs.length; j++) {
      const next = this.findMerged(merged, theirs[j].text);
      if (next >= 0) return next;
    }
    return merged.length;
  }

  place(merged, at, index, item) {
    merged.splice(at, 0, item);
    this.alias.set(this.theirs[index].text, item);
    this.theirKeep[index] = false;
  }

  merge(base) {
    const { ours, theirs } = this;
    for (const item of base) this.mergeBase(item);
    for (let i = 0; i < ours.length; i++) {
      if (!this.usedOurs[i]) this.mergeFresh(i);
    }
    for (let i = 0; i < theirs.length; i++) {
      if (!this.usedTheirs[i]) this.theirKeep[i] = true;
    }
    const merged = [];
    const gaps = [];
    for (let i = 0; i < ours.length; i++) {
      const at = merged.length + gaps.length;
      if (this.kept[i]) merged.push(ours[i]);
      else if (this.dropped[i]) gaps.push({ at, todo: ours[i] });
    }
    for (let i = 0; i < theirs.length && gaps.length; i++) {
      if (!this.theirKeep[i]) continue;
      const gap = gaps.shift();
      this.place(merged, gap.at, i, replaceTodo(gap.todo, theirs[i]));
    }
    for (let i = 0; i < theirs.length; i++) {
      if (!this.theirKeep[i]) continue;
      const at = this.theirPlace(merged, i);
      this.place(merged, at, i, adoptTodo(this.store, theirs[i]));
    }
    return merged;
  }
}

const sameNote = (left, right) =>
  left.text === right.text && !!left.done === !!right.done;

const cloneNote = (note, done) => {
  if (!!note.done === done) return note;
  return { ...note, done };
};

const pickNote = (ours, base, theirs) => {
  if (ours && theirs && ours.text === theirs.text) {
    const baseDone = base ? base.done === true : ours.done === true;
    const done = pickDone(baseDone, ours.done === true, theirs.done === true);
    return cloneNote(ours, done);
  }
  if (!base) return ours || theirs || null;
  if (!ours) {
    if (!theirs || sameNote(theirs, base)) return null;
    return theirs;
  }
  if (!theirs) {
    if (sameNote(ours, base)) return null;
    return ours;
  }
  if (sameNote(theirs, base)) return ours;
  if (sameNote(ours, base)) return theirs;
  return ours;
};

const mergeMap = (ours, base, theirs) => {
  const keys = new Set();
  for (const key of ours.keys()) keys.add(key);
  for (const key of base.keys()) keys.add(key);
  for (const key of theirs.keys()) keys.add(key);
  for (const key of keys) {
    const next = pickNote(ours.get(key), base.get(key), theirs.get(key));
    if (!next) ours.delete(key);
    else ours.set(key, next);
  }
};

const mergeReview = (store, disk) => {
  const base = store.baseline;
  const baseTodos = base ? base.todos : [];
  const baseStatus = base ? base.status : store.status;
  store.todos = new TodoMerge(store, snapList(disk.todos)).merge(baseTodos);
  const feedback = base ? base.feedback : new Map();
  const code = base ? base.code : new Map();
  mergeMap(store.feedback, feedback, disk.feedback);
  mergeMap(store.code, code, disk.code);
  if (store.status === baseStatus && disk.status) store.status = disk.status;
  store.baseline = snapshotSide(disk);
};

module.exports = { captureBaseline, mergeReview };
