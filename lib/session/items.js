'use strict';

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

const originOf = (item) => item.origin ?? '';

const hunkStart = (item) => (item.hunk ? item.hunk.newStart : 0);

const sameLinesIndex = (items, item) => {
  const lines = blockLinesKey(item);
  if (!lines) return -1;
  let any = -1;
  for (let i = 0; i < items.length; i++) {
    if (blockLinesKey(items[i]) !== lines) continue;
    if (originOf(items[i]) === originOf(item)) return i;
    if (any < 0) any = i;
  }
  return any;
};

const nearestHunkIndex = (items, item) => {
  const rel = itemPath(item);
  if (!rel) return -1;
  let fileMatch = -1;
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < items.length; i++) {
    const entry = items[i];
    if (itemPath(entry) !== rel) continue;
    if (fileMatch < 0) fileMatch = i;
    if (originOf(entry) !== originOf(item)) continue;
    const dist = Math.abs(hunkStart(entry) - hunkStart(item));
    if (dist >= bestDist) continue;
    bestDist = dist;
    best = i;
  }
  return best >= 0 ? best : fileMatch;
};

const restoredIndex = (items, item) => {
  if (!item || !item.file) return -1;
  const byLines = sameLinesIndex(items, item);
  if (byLines >= 0) return byLines;
  const key = itemKey(item);
  const exact = key ? items.findIndex((entry) => itemKey(entry) === key) : -1;
  if (exact >= 0) return exact;
  return nearestHunkIndex(items, item);
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

class ItemCollection {
  constructor() {
    this.items = [];
    this.dismissed = new Set();
  }

  reset() {
    this.items = [];
    this.dismissed = new Set();
  }

  isDismissed(item) {
    return this.dismissed.has(itemKey(item));
  }

  replace(items) {
    const aligned = alignLoadedItems(this.items, items);
    this.items = aligned.filter((item) => !this.isDismissed(item));
    return this.items;
  }

  dismiss(item) {
    this.dismissed.add(itemKey(item));
  }

  clearDismissed() {
    this.dismissed.clear();
  }

  findRestoredIndex(item) {
    return restoredIndex(this.items, item);
  }

  keepOrigin(item, origin) {
    const next = { ...item, origin };
    const replaced = this.items.map((entry) =>
      sameBlock(entry, item) ? next : entry,
    );
    if (next.dep) {
      this.items = replaced;
      return;
    }
    this.items = refreshIndexPatches(replaced, next);
  }
}

module.exports = {
  needsReload,
  npmBusyKind,
  itemFeedKey,
  alignLoadedItems,
  restoredIndex,
  sameBlock,
  canEditCode,
  ItemCollection,
};
