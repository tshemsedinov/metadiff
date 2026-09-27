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

const findMerged = (merged, alias, text) => {
  const linked = alias.get(text);
  if (linked) {
    const at = merged.indexOf(linked);
    if (at >= 0) return at;
  }
  for (let i = 0; i < merged.length; i++) {
    if (liveText(merged[i]) === text) return i;
  }
  return -1;
};

const insertTheir = (store, merged, theirs, theirKeep, alias) => {
  for (let i = 0; i < theirs.length; i++) {
    if (!theirKeep[i]) continue;
    let at = merged.length;
    let placed = false;
    for (let j = i - 1; j >= 0 && !placed; j--) {
      const prev = findMerged(merged, alias, theirs[j].text);
      if (prev < 0) continue;
      at = prev + 1;
      placed = true;
    }
    for (let j = i + 1; j < theirs.length && !placed; j++) {
      const next = findMerged(merged, alias, theirs[j].text);
      if (next < 0) continue;
      at = next;
      placed = true;
    }
    const item = adoptTodo(store, theirs[i]);
    merged.splice(at, 0, item);
    alias.set(theirs[i].text, item);
  }
  return merged;
};

const keepOurs = (ours, kept, alias, index, text) => {
  kept[index] = true;
  alias.set(text, ours[index]);
};

const mergeBaseTodo = (
  base,
  ours,
  theirs,
  used,
  kept,
  dropped,
  theirKeep,
  alias,
) => {
  const text = base.text;
  const oi = claim(ours, used.ours, text, liveText);
  const ti = claim(theirs, used.theirs, text, snapText);
  if (oi >= 0 && ti >= 0) {
    const done = pickDone(base.done, ours[oi].done === true, theirs[ti].done);
    ours[oi] = withDone(ours[oi], done);
    keepOurs(ours, kept, alias, oi, text);
    return;
  }
  if (oi >= 0) {
    if (ours[oi].done === base.done) {
      dropped[oi] = true;
      return;
    }
    keepOurs(ours, kept, alias, oi, text);
    return;
  }
  if (ti >= 0 && theirs[ti].done !== base.done) theirKeep[ti] = true;
};

const replaceTodo = (todo, snap) => ({
  id: todo.id,
  file: todo.file,
  text: snap.text,
  done: snap.done,
});

const fillGaps = (merged, gaps, theirs, theirKeep, alias) => {
  let filled = 0;
  for (let i = 0; i < theirs.length && filled < gaps.length; i++) {
    if (!theirKeep[i]) continue;
    const gap = gaps[filled];
    const item = replaceTodo(gap.todo, theirs[i]);
    merged.splice(gap.at, 0, item);
    alias.set(theirs[i].text, item);
    theirKeep[i] = false;
    filled += 1;
  }
};

const mergeFreshTodo = (ours, theirs, used, kept, alias, index) => {
  const text = liveText(ours[index]);
  const ti = claim(theirs, used.theirs, text, snapText);
  if (ti < 0) {
    kept[index] = true;
    return;
  }
  const done = ours[index].done === true || theirs[ti].done === true;
  ours[index] = withDone(ours[index], done);
  keepOurs(ours, kept, alias, index, text);
};

const mergeTodos = (store, base, theirs) => {
  const ours = [];
  for (const todo of store.todos) {
    if (!liveText(todo)) continue;
    ours.push(todo);
  }
  const used = { ours: flags(ours.length), theirs: flags(theirs.length) };
  const kept = flags(ours.length);
  const dropped = flags(ours.length);
  const theirKeep = flags(theirs.length);
  const alias = new Map();
  for (const item of base) {
    mergeBaseTodo(item, ours, theirs, used, kept, dropped, theirKeep, alias);
  }
  for (let i = 0; i < ours.length; i++) {
    if (used.ours[i]) continue;
    mergeFreshTodo(ours, theirs, used, kept, alias, i);
  }
  for (let i = 0; i < theirs.length; i++) {
    if (!used.theirs[i]) theirKeep[i] = true;
  }
  const merged = [];
  const gaps = [];
  let cursor = 0;
  for (let i = 0; i < ours.length; i++) {
    if (kept[i]) {
      merged.push(ours[i]);
      cursor += 1;
      continue;
    }
    if (!dropped[i]) continue;
    gaps.push({ at: cursor, todo: ours[i] });
    cursor += 1;
  }
  fillGaps(merged, gaps, theirs, theirKeep, alias);
  store.todos = insertTheir(store, merged, theirs, theirKeep, alias);
};

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
  mergeTodos(store, baseTodos, snapList(disk.todos));
  const feedback = base ? base.feedback : new Map();
  const code = base ? base.code : new Map();
  mergeMap(store.feedback, feedback, disk.feedback);
  mergeMap(store.code, code, disk.code);
  if (store.status === baseStatus && disk.status) store.status = disk.status;
  store.baseline = snapshotSide(disk);
};

module.exports = { captureBaseline, mergeReview };
