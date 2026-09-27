'use strict';

const manifest = require('./manifest.js');
const { listFilePath } = manifest;

const REVIEW_DIR = '.review';
const ORIGIN_ORDER = ['staged', 'unstaged', 'untracked', 'commit', 'pr'];
const TODO_FILE = 'TODOs';
const REPO_TODOS_LABEL = 'Repository TODOs and Issues';
const TOTAL_LABEL = 'total';

const isPathInScope = (rel, paths) => {
  if (!paths.length) return true;
  for (const spec of paths) {
    const norm = `${spec ?? ''}`.replaceAll('\\', '/').replace(/\/+$/, '');
    if (!norm || norm === '.') return true;
    if (rel === norm || rel.startsWith(`${norm}/`)) return true;
  }
  return false;
};

const itemPath = (item) => {
  if (!item || !item.file) return '';
  return item.file.newPath || item.file.oldPath || '';
};

const listPath = (item) => listFilePath(itemPath(item));

const isTodoItem = (item) => !!(item && item.origin === 'todo');

const isReadOnlyOrigin = (origin) => origin === 'commit' || origin === 'pr';

const isTodosEntry = (entry) => !!(entry && entry.kind === 'todos');

const isTotalEntry = (entry) => !!(entry && entry.kind === 'total');

const makeTodoItem = () => ({
  origin: 'todo',
  file: {
    oldPath: TODO_FILE,
    newPath: TODO_FILE,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    preamble: [],
    hunks: [],
  },
  hunk: null,
  blockId: 'todo',
  patchAdd: '',
  patchRevert: '',
});

const fileStatus = (origins) => {
  const present = new Set(origins);
  const seen = ORIGIN_ORDER.filter((origin) => present.has(origin));
  const key = seen.join('+');
  if (!key) return '';
  if (key === 'staged+unstaged') return 'partial';
  return key;
};

const lineDelta = ({ hunk, blockId }) => {
  const delta = { added: 0, removed: 0 };
  if (!hunk) return delta;
  const { lines } = hunk;
  if (!lines) return delta;
  const scoped = typeof blockId === 'number';
  for (const { type, blockId: lineBlock } of lines) {
    if (scoped && lineBlock !== blockId) continue;
    if (type === 'add') delta.added += 1;
    else if (type === 'del') delta.removed += 1;
  }
  return delta;
};

const AGE_UNIT = {
  second: 's',
  minute: 'm',
  hour: 'h',
  day: 'd',
  week: 'w',
  month: 'mo',
  year: 'y',
};

const AGE_AGO = /^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i;
const AGE_SHORT = /^(\d+)(mo|[smhdwy])(?: ago)?$/i;

const shortUnit = (n, unit) => `${n}${AGE_UNIT[unit]} ago`;

const shortAge = (text) => {
  const raw = `${text ?? ''}`.trim();
  if (!raw) return '';
  if (/^yesterday$/i.test(raw)) return '1d ago';
  const match = AGE_AGO.exec(raw);
  if (match) {
    const unit = AGE_UNIT[match[2].toLowerCase()];
    if (unit) return `${match[1]}${unit} ago`;
  }
  const brief = AGE_SHORT.exec(raw);
  if (brief) return `${brief[1]}${brief[2].toLowerCase()} ago`;
  return raw;
};

const relativeAge = (thenMs, nowMs = Date.now()) => {
  const diff = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (diff < 90) return shortUnit(diff, 'second');
  const minutes = Math.round(diff / 60);
  if (minutes < 90) return shortUnit(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 36) return shortUnit(hours, 'hour');
  const days = Math.round(hours / 24);
  if (days < 14) return shortUnit(days, 'day');
  if (days < 70) return shortUnit(Math.round(days / 7), 'week');
  if (days < 365) return shortUnit(Math.round(days / 30), 'month');
  return shortUnit(Math.round(days / 365), 'year');
};

const addLineDelta = (group, origin, delta) => {
  group.added += delta.added;
  group.removed += delta.removed;
  if (origin === 'staged') {
    group.stagedAdded += delta.added;
    group.stagedRemoved += delta.removed;
    return;
  }
  group.unstagedAdded += delta.added;
  group.unstagedRemoved += delta.removed;
};

const originLineDelta = (entry) => {
  if (entry.stagedAdded !== undefined || entry.unstagedAdded !== undefined) {
    return {
      stagedAdded: entry.stagedAdded ?? 0,
      stagedRemoved: entry.stagedRemoved ?? 0,
      unstagedAdded: entry.unstagedAdded ?? 0,
      unstagedRemoved: entry.unstagedRemoved ?? 0,
    };
  }
  const added = entry.added ?? 0;
  const removed = entry.removed ?? 0;
  if ((entry.status ?? '') === 'staged') {
    return {
      stagedAdded: added,
      stagedRemoved: removed,
      unstagedAdded: 0,
      unstagedRemoved: 0,
    };
  }
  return {
    stagedAdded: 0,
    stagedRemoved: 0,
    unstagedAdded: added,
    unstagedRemoved: removed,
  };
};

const fileEntries = (items) => {
  const groups = new Map();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (isTodoItem(item)) continue;
    const rel = listPath(item);
    if (!rel) continue;
    if (!groups.has(rel)) {
      groups.set(rel, {
        path: rel,
        origins: [],
        firstIndex: i,
        openIndex: i,
        remaining: 0,
        added: 0,
        removed: 0,
        stagedAdded: 0,
        stagedRemoved: 0,
        unstagedAdded: 0,
        unstagedRemoved: 0,
        staged: 0,
        unstaged: 0,
        date: '',
      });
    }
    const group = groups.get(rel);
    const { origin } = item;
    if (item.date && !group.date) group.date = item.date;
    group.origins.push(origin);
    group.remaining += 1;
    addLineDelta(group, origin, lineDelta(item));
    if (origin === 'staged') group.staged += 1;
    if (origin === 'unstaged') {
      if (group.unstaged === 0) group.openIndex = i;
      group.unstaged += 1;
    }
  }
  const entries = [...groups.values()];
  for (const group of entries) {
    group.status = fileStatus(group.origins);
  }
  entries.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  return entries;
};

const fileTotals = (files) => {
  const total = {
    path: TOTAL_LABEL,
    kind: 'total',
    status: '',
    remaining: 0,
    added: 0,
    removed: 0,
    stagedAdded: 0,
    stagedRemoved: 0,
    unstagedAdded: 0,
    unstagedRemoved: 0,
    staged: 0,
    unstaged: 0,
  };
  for (const entry of files) {
    if (isTodosEntry(entry) || isTotalEntry(entry)) continue;
    const remaining = entry.remaining ?? 0;
    const staged = entry.staged ?? 0;
    const added = entry.added ?? 0;
    const removed = entry.removed ?? 0;
    const lines = originLineDelta(entry);
    const listed = entry.unstaged ?? Math.max(0, remaining - staged);
    const untracked = (entry.status ?? '') === 'untracked';
    const unstaged = untracked && listed === 0 ? remaining : listed;
    total.remaining += remaining;
    total.added += added;
    total.removed += removed;
    total.stagedAdded += lines.stagedAdded;
    total.stagedRemoved += lines.stagedRemoved;
    total.unstagedAdded += lines.unstagedAdded;
    total.unstagedRemoved += lines.unstagedRemoved;
    total.staged += staged;
    total.unstaged += unstaged;
  }
  return total;
};

module.exports = {
  REVIEW_DIR,
  TODO_FILE,
  REPO_TODOS_LABEL,
  TOTAL_LABEL,
  isPathInScope,
  itemPath,
  listPath,
  isTodoItem,
  isReadOnlyOrigin,
  isTodosEntry,
  isTotalEntry,
  makeTodoItem,
  fileStatus,
  fileEntries,
  fileTotals,
  relativeAge,
  shortAge,
};
