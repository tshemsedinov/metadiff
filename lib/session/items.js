'use strict';

const accessors = require('./accessors.js');
const { stateView } = accessors;

const files = require('../files.js');
const { itemPath, TODO_FILE, isTodoItem } = files;
const review = require('../review.js');
const { feedbackKey } = review;
const diff = require('../diff/diff.js');
const { refreshIndexPatches } = diff;

const depChangeKey = (item) => {
  const change = item.dep && item.dep.change;
  if (!change) return '';
  return `${change.section}/${change.name}`;
};

const needsReload = (item) => item.reload === true;

const npmBusyKind = (item) => {
  const change = item && item.dep && item.dep.change;
  if (!change || !change.propose) return '';
  if (change.unused) return 'npm uninstall';
  if (change.section === 'resolved') return 'npm audit fix';
  return 'npm i';
};

const blockKey = (item) => {
  if (!item || !item.file) return '';
  const rel = itemPath(item);
  if (isTodoItem(item)) return `todo:${TODO_FILE}`;
  const depId = depChangeKey(item);
  if (depId) return `${rel}:dep:${depId}`;
  if (!item.hunk) {
    const block = item.blockId ?? '-';
    return `${rel}:file:${block}`;
  }
  const oldStart = item.hunk.oldStart;
  const newStart = item.hunk.newStart;
  const block = item.blockId ?? '-';
  return `${rel}:${oldStart}:${newStart}:${block}`;
};

const itemKey = (item) => {
  const key = blockKey(item);
  if (!key || isTodoItem(item)) return key;
  const origin = item.origin ?? '';
  return `${origin}:${key}`;
};

const blockLinesKey = (item) => {
  if (!item || !item.file || isTodoItem(item)) return '';
  if (!item.hunk) return '';
  const parts = [itemPath(item)];
  for (const line of item.hunk.lines) {
    if (line.blockId !== item.blockId) continue;
    if (line.type === 'ctx') continue;
    parts.push(`${line.type}:${line.text}`);
  }
  return parts.join('\0');
};

const pushBucket = (map, key, item) => {
  if (!key) return;
  const list = map.get(key) ?? [];
  list.push(item);
  map.set(key, list);
};

const takeBucket = (map, key, used) => {
  if (!key) return null;
  const list = map.get(key);
  if (!list || !list.length) return null;
  while (list.length) {
    const item = list.shift();
    if (!used.has(item)) return item;
  }
  return null;
};

const groupByPath = (items) => {
  const groups = new Map();
  for (const item of items) {
    const rel = itemPath(item) || '';
    const list = groups.get(rel) ?? [];
    list.push(item);
    groups.set(rel, list);
  }
  return groups;
};

const alignGroup = (prev, next) => {
  if (!prev.length) return next;
  if (!next.length) return [];
  const byBlock = new Map();
  const byLines = new Map();
  for (const item of next) {
    pushBucket(byBlock, blockKey(item), item);
    pushBucket(byLines, blockLinesKey(item), item);
  }
  const used = new Set();
  const ordered = [];
  for (const item of prev) {
    const byText = takeBucket(byLines, blockLinesKey(item), used);
    const taken = byText ?? takeBucket(byBlock, blockKey(item), used);
    if (!taken) continue;
    used.add(taken);
    ordered.push(taken);
  }
  for (const item of next) {
    if (used.has(item)) continue;
    ordered.push(item);
  }
  return ordered;
};

const alignLoadedItems = (prev, next) => {
  if (!prev.length || !next.length) return next;
  const nextGroups = groupByPath(next);
  const seen = new Set();
  const ordered = [];
  for (const [rel, list] of groupByPath(prev)) {
    seen.add(rel);
    const aligned = alignGroup(list, nextGroups.get(rel) ?? []);
    for (const item of aligned) ordered.push(item);
  }
  for (const [rel, list] of nextGroups) {
    if (seen.has(rel)) continue;
    for (const item of list) ordered.push(item);
  }
  return ordered;
};

const restoredIndex = (items, item) => {
  if (!item || !item.file) return -1;
  const origin = item.origin ?? '';
  const lines = blockLinesKey(item);
  if (lines) {
    let any = -1;
    for (let i = 0; i < items.length; i++) {
      if (blockLinesKey(items[i]) !== lines) continue;
      if (any < 0) any = i;
      if ((items[i].origin ?? '') === origin) return i;
    }
    if (any >= 0) return any;
  }
  const key = itemKey(item);
  if (key) {
    const exact = items.findIndex((entry) => itemKey(entry) === key);
    if (exact >= 0) return exact;
  }
  const rel = itemPath(item);
  if (!rel) return -1;
  const start = item.hunk ? item.hunk.newStart : 0;
  let fileMatch = -1;
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < items.length; i++) {
    const entry = items[i];
    if (itemPath(entry) !== rel) continue;
    if (fileMatch < 0) fileMatch = i;
    if ((entry.origin ?? '') !== origin) continue;
    const at = entry.hunk ? entry.hunk.newStart : 0;
    const dist = Math.abs(at - start);
    if (dist >= bestDist) continue;
    bestDist = dist;
    best = i;
  }
  if (best >= 0) return best;
  return fileMatch;
};

const itemFeedKey = (item) => {
  if (!item || !item.file || isTodoItem(item)) return '';
  const hunk = item.hunk;
  const depId = depChangeKey(item);
  const file = depId ? `${itemPath(item)}#${depId}` : itemPath(item);
  const oldStart = hunk ? hunk.oldStart : 0;
  const newStart = hunk ? hunk.newStart : 0;
  const blockId = item.blockId ?? 0;
  return feedbackKey({ file, oldStart, newStart, blockId });
};

const sameBlock = (left, right) => {
  if (left === right) return true;
  if (left.file !== right.file) return false;
  if (left.hunk !== right.hunk) return false;
  return left.blockId === right.blockId;
};

const canEditCode = (item) => {
  if (!item || isTodoItem(item)) return false;
  if (!item.hunk || !item.file) return false;
  if (item.file.isBinary) return false;
  return true;
};

const createItemCollection = () => {
  const state = {
    items: [],
    dismissed: new Set(),
  };

  const reset = () => {
    state.items = [];
    state.dismissed = new Set();
  };

  const isDismissed = (item) => state.dismissed.has(itemKey(item));

  const replace = (items) => {
    const aligned = alignLoadedItems(state.items, items);
    const next = [];
    for (const item of aligned) {
      if (isDismissed(item)) continue;
      next.push(item);
    }
    state.items = next;
    return next;
  };

  const dismiss = (item) => {
    state.dismissed.add(itemKey(item));
  };

  const clearDismissed = () => {
    state.dismissed.clear();
  };

  const findRestoredIndex = (item) => restoredIndex(state.items, item);

  const keepOrigin = (item, origin) => {
    const next = { ...item, origin };
    const { length } = state.items;
    const replaced = new Array(length);
    for (let i = 0; i < length; i++) {
      const entry = state.items[i];
      replaced[i] = sameBlock(entry, item) ? next : entry;
    }
    if (next.dep) {
      state.items = replaced;
      return;
    }
    state.items = refreshIndexPatches(replaced, next);
  };

  return stateView(
    state,
    {
      reset,
      replace,
      dismiss,
      clearDismissed,
      isDismissed,
      findRestoredIndex,
      keepOrigin,
    },
    ['items'],
    ['dismissed'],
  );
};

module.exports = {
  depChangeKey,
  needsReload,
  npmBusyKind,
  blockKey,
  itemKey,
  itemFeedKey,
  blockLinesKey,
  alignLoadedItems,
  restoredIndex,
  sameBlock,
  canEditCode,
  createItemCollection,
};
