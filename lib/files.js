'use strict';

const manifest = require('./manifest.js');
const { listFilePath } = manifest;

const REVIEW_DIR = '.review';
const ORIGIN_ORDER = ['staged', 'unstaged', 'untracked', 'commit', 'pr'];
const TASKS_FILE = 'TODOs';
const REPO_TASKS_LABEL = [
  'Project Tasks: Feature requests, Bug reports,',
  'Technical debt, Research, Security',
].join(' ');
const TASK_KINDS = [
  { id: 'features', title: 'Feature requests' },
  { id: 'bugs', title: 'Bug reports' },
  { id: 'debt', title: 'Technical debt' },
  { id: 'research', title: 'Research' },
  { id: 'security', title: 'Security' },
];
const TASK_KIND_IDS = new Set(TASK_KINDS.map((kind) => kind.id));
const TASK_KIND_ALIAS = { backlog: 'debt', issues: 'debt' };

const taskKind = (todo) => {
  const kind = todo && todo.kind;
  if (TASK_KIND_IDS.has(kind)) return kind;
  return TASK_KIND_ALIAS[kind] ?? 'debt';
};

const taskTitle = (id) => {
  for (const kind of TASK_KINDS) {
    if (kind.id === id) return kind.title;
  }
  return TASK_KINDS[0].title;
};
const TOTAL_LABEL = 'total';
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

const isPathInScope = (rel, paths) => {
  if (!paths.length) return true;
  for (const spec of paths) {
    const norm = `${spec ?? ''}`.replaceAll('\\', '/').replace(/\/+$/, '');
    if (!norm || norm === '.') return true;
    if (rel === norm || rel.startsWith(`${norm}/`)) return true;
  }
  return false;
};

const itemPath = (item) => item?.file?.newPath || item?.file?.oldPath || '';

const listPath = (item) => listFilePath(itemPath(item));

const isTaskItem = (item) => item?.origin === 'task';

const isReadOnlyOrigin = (origin) => origin === 'commit' || origin === 'pr';

const isTasksEntry = (entry) => entry?.kind === 'tasks';

const isTotalEntry = (entry) => entry?.kind === 'total';

const makeTaskItem = () => ({
  origin: 'task',
  file: {
    oldPath: TASKS_FILE,
    newPath: TASKS_FILE,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    preamble: [],
    hunks: [],
  },
  hunk: null,
  blockId: 'task',
  patchAdd: '',
  patchRevert: '',
});

const fileStatus = (origins) => {
  const seen = ORIGIN_ORDER.filter((origin) => origins.includes(origin));
  const key = seen.join('+');
  return key === 'staged+unstaged' ? 'partial' : key;
};

const lineDelta = ({ hunk, blockId }) => {
  const delta = { added: 0, removed: 0 };
  if (!hunk || !hunk.lines) return delta;
  const scoped = typeof blockId === 'number';
  for (const line of hunk.lines) {
    if (scoped && line.blockId !== blockId) continue;
    if (line.type === 'add') delta.added += 1;
    else if (line.type === 'del') delta.removed += 1;
  }
  return delta;
};

const shortUnit = (n, unit) => `${n}${AGE_UNIT[unit]} ago`;

const shortAge = (text) => {
  const raw = `${text ?? ''}`.trim();
  if (/^yesterday$/i.test(raw)) return '1d ago';
  const match = AGE_AGO.exec(raw);
  if (match) return shortUnit(match[1], match[2].toLowerCase());
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

const emptyCounts = () => ({
  remaining: 0,
  added: 0,
  removed: 0,
  stagedAdded: 0,
  stagedRemoved: 0,
  unstagedAdded: 0,
  unstagedRemoved: 0,
  staged: 0,
  unstaged: 0,
});

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
  const staged = entry.status === 'staged';
  return {
    stagedAdded: staged ? added : 0,
    stagedRemoved: staged ? removed : 0,
    unstagedAdded: staged ? 0 : added,
    unstagedRemoved: staged ? 0 : removed,
  };
};

const fileEntries = (items) => {
  const groups = new Map();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (isTaskItem(item)) continue;
    const rel = listPath(item);
    if (!rel) continue;
    if (!groups.has(rel)) {
      const fields = { origins: [], firstIndex: i, openIndex: i };
      groups.set(rel, { path: rel, ...fields, ...emptyCounts(), date: '' });
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
  for (const group of entries) group.status = fileStatus(group.origins);
  entries.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  return entries;
};

const fileTotals = (files) => {
  const total = { path: TOTAL_LABEL, kind: 'total', status: '' };
  Object.assign(total, emptyCounts());
  for (const entry of files) {
    if (isTasksEntry(entry) || isTotalEntry(entry)) continue;
    const remaining = entry.remaining ?? 0;
    const staged = entry.staged ?? 0;
    const lines = originLineDelta(entry);
    const listed = entry.unstaged ?? Math.max(0, remaining - staged);
    const untracked = entry.status === 'untracked';
    total.remaining += remaining;
    total.added += entry.added ?? 0;
    total.removed += entry.removed ?? 0;
    total.stagedAdded += lines.stagedAdded;
    total.stagedRemoved += lines.stagedRemoved;
    total.unstagedAdded += lines.unstagedAdded;
    total.unstagedRemoved += lines.unstagedRemoved;
    total.staged += staged;
    total.unstaged += untracked && listed === 0 ? remaining : listed;
  }
  return total;
};

module.exports = {
  REVIEW_DIR,
  TASKS_FILE,
  REPO_TASKS_LABEL,
  TASK_KINDS,
  taskKind,
  taskTitle,
  TOTAL_LABEL,
  isPathInScope,
  itemPath,
  listPath,
  isTaskItem,
  isReadOnlyOrigin,
  isTasksEntry,
  isTotalEntry,
  makeTaskItem,
  fileStatus,
  lineDelta,
  fileEntries,
  fileTotals,
  relativeAge,
  shortAge,
};
