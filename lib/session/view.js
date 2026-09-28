'use strict';

const path = require('node:path');

const files = require('../files.js');
const commit = require('./commit.js');
const { listedCommits } = commit;
const { fileEntries, fileTotals, REPO_TODOS_LABEL } = files;
const review = require('../review.js');
const { noteCounts } = review;
const diff = require('../diff/diff.js');
const { unitLines, itemsForPath, splitEditor, mergeEditRows } = diff;

const relabelStatus = (entries, from, to) => {
  if (!to) return entries;
  return entries.map((entry) => {
    if (entry.status !== from) return entry;
    return { ...entry, status: to };
  });
};

const repoNameOf = (api) => {
  const { ui } = api;
  if (ui.repoName) return ui.repoName;
  return path.basename(ui.top || ui.cwd || '');
};

const todosEntry = (counts) => ({
  path: REPO_TODOS_LABEL,
  kind: 'todos',
  status: 'todos',
  remaining: counts.todo,
  staged: counts.todoDone,
  firstIndex: 0,
  openIndex: 0,
  added: 0,
  removed: 0,
  stagedAdded: 0,
  stagedRemoved: 0,
  unstagedAdded: 0,
  unstagedRemoved: 0,
  unstaged: 0,
});

const blankEntry = (rel) => ({
  path: rel,
  origins: [],
  firstIndex: 0,
  openIndex: 0,
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
  status: '',
});

const listedNames = (api) => {
  const repo = api.ui.repo;
  if (!repo || typeof repo.listFiles !== 'function') return [];
  try {
    return repo.listFiles(api.ui.top || api.ui.cwd, api.ui.paths ?? [], {
      commit: api.ui.rev,
    });
  } catch {
    return [];
  }
};

const mergeUnitFiles = (entries, names) => {
  const have = new Set();
  for (const entry of entries) have.add(entry.path);
  const extra = [];
  for (const rel of names) {
    if (!rel || have.has(rel)) continue;
    extra.push(blankEntry(rel));
  }
  const merged = [...entries, ...extra];
  merged.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  return merged;
};

const fileList = (api, notes = noteCounts(api.review.store)) => {
  const entries = fileEntries(api.collection.items);
  const sourceLabel = api.ui.sourceLabel;
  const from = sourceLabel ? 'pr' : 'commit';
  const to = sourceLabel || api.ui.revShort;
  const labeled = relabelStatus(entries, from, to);
  const names = listedNames(api);
  const scoped =
    api.nav.fileScope === 'file' ? mergeUnitFiles(labeled, names) : labeled;
  scoped.unshift(todosEntry(notes));
  return scoped;
};

const counts = (api, notes = noteCounts(api.review.store)) => {
  const next = {
    staged: 0,
    unstaged: 0,
    untracked: 0,
    commit: 0,
    pr: 0,
    todo: 0,
    feedback: 0,
    code: 0,
  };
  for (const item of api.collection.items) {
    if (!Object.hasOwn(next, item.origin)) continue;
    next[item.origin] += 1;
  }
  next.feedback = notes.feedback;
  next.todo = notes.todo;
  next.code = notes.code;
  return next;
};

const viewStatus = (api) => api.ui.status || api.ui.busy;

const unitFileText = (api) => {
  const rel = api.nav.reviewPath;
  if (!rel) return '';
  const repo = api.ui.repo;
  if (repo && typeof repo.fileText === 'function') {
    return repo.fileText(api.ui.top, rel, api.ui.rev);
  }
  return '';
};

const unitBodyLines = (api) => {
  if (api.nav.pane !== 'unit') return [];
  const rel = api.nav.reviewPath;
  const group = itemsForPath(api.collection.items, rel);
  const live = api.composer.liveFileText();
  if (live !== null) {
    const base = api.composer.fileEditRows();
    if (base && base.length) return mergeEditRows(base, splitEditor(live));
    return mergeEditRows(unitLines(live, group), splitEditor(live));
  }
  return unitLines(unitFileText(api), group);
};

const pendingLines = (items, rev, revShort) => {
  if (rev || revShort) return null;
  for (const item of items) {
    if (item.origin === 'commit' || item.origin === 'pr') return null;
  }
  return fileTotals(fileEntries(items));
};

const commitRows = (api) => {
  const rows = listedCommits(api.commits.commits);
  const lines = pendingLines(api.collection.items, api.ui.rev, api.ui.revShort);
  if (!lines || !rows[0]) return rows;
  rows[0] = {
    ...rows[0],
    added: lines.added,
    removed: lines.removed,
    stagedAdded: lines.stagedAdded,
    unstagedAdded: lines.unstagedAdded,
    stagedRemoved: lines.stagedRemoved,
    unstagedRemoved: lines.unstagedRemoved,
  };
  return rows;
};

const view = (api) => {
  const { composer, nav, ui, gitBranches, commits, npm, updater } = api;
  const templates = composer.shownTemplates();
  const change = ui.change;
  const sourceKind = (change && change.source) || '';
  const notes = noteCounts(api.review.store);
  return {
    item: ui.current(),
    index: nav.index,
    total: api.collection.items.length,
    scroll: nav.scroll,
    listScroll: nav.listScroll,
    status: viewStatus(api),
    progressFrame: ui.progressFrame,
    layout: ui.layout,
    counts: counts(api, notes),
    selection: nav.selection,
    pane: nav.pane,
    fileScope: nav.fileScope,
    files: fileList(api, notes),
    fileCursor: nav.fileCursor,
    reviewPath: nav.reviewPath,
    unitLine: nav.unitLine,
    unitLines: unitBodyLines(api),
    branch: ui.branch,
    branches: gitBranches.branches,
    branchCursor: nav.branchCursor,
    commits: commitRows(api),
    commitCursor: nav.commitCursor,
    commitView: commits.commitView,
    npmCommands: npm.commands,
    npmCursor: nav.npmCursor,
    npmView: npm.viewing,
    npmOutput: npm.output,
    npmFollow: npm.followEnd,
    npmScroll: npm.logScroll,
    npmEditName: npm.editName,
    npmRunning: npm.running,
    npmLogs: nav.pane === 'npm' ? npm.logLabel : '',
    repoName: repoNameOf(api),
    rev: ui.rev || '',
    revShort: ui.revShort || '',
    sourceLabel: ui.sourceLabel || '',
    sourceKind,
    mode: ui.mode,
    compose: composer.composeView(),
    noteText: composer.idleNoteText(),
    todos: composer.todoTexts(),
    todoFocus: composer.clampedTodoFocus(),
    todoEdit: composer.todoEditView(),
    codeOverlay: composer.codeOverlayView(),
    templates,
    templateIndex: composer.clampedTemplateIndex(templates),
    updateFrom: updater.from,
    updateTo: updater.to,
    dropName: gitBranches.dropName || commits.dropName || npm.dropName,
  };
};

const createView = (api) => ({
  fileList: () => fileList(api),
  counts: () => counts(api),
  viewStatus: () => viewStatus(api),
  view: () => view(api),
});

module.exports = { relabelStatus, createView };
