'use strict';

const accessors = require('./accessors.js');
const { stateView } = accessors;

const files = require('../files.js');
const { isReadOnlyOrigin } = files;
const actions = require('./actions.js');
const { isFixupCommit } = actions;
const ops = require('./ops.js');
const { pickRepoWrite } = ops;
const commits = require('../render/commits.js');
const { commitLine, commitText, splitMessage } = commits;

const COMMIT_STATUS = {
  commit: 'committed',
  amend: 'amended',
  fixup: 'fixup',
  reword: 'reworded',
};

const isInPlaceCommit = (kind) => kind === 'amend' || kind === 'reword';

const PENDING_COMMIT = {
  pending: true,
  subject: 'uncommitted changes',
  sha: '',
  shortSha: '',
  author: '',
  email: '',
  date: '',
  when: '',
  refs: '',
  body: '',
  head: false,
};

const listedCommits = (commits) => [PENDING_COMMIT].concat(commits ?? []);

const isPending = (entry) => Boolean(entry && entry.pending);

const briefCommit = (ui) => ui.commits.commitView !== 'full';

const joinMessage = (line, rest) => (rest ? `${line}\n${rest}` : line);

const keepBriefBody = (ui, text) => {
  if (!briefCommit(ui)) return text;
  const parts = splitMessage(text);
  ui.composer.state.commitBody = parts.rest;
  return parts.line;
};

const fixupMessage = (entry) => {
  const subject = commitLine(entry).trim();
  if (!subject) return 'fixup!';
  return `fixup! ${subject}`;
};

const canCommit = (ui) => {
  const caps = ui.capabilities;
  if (!caps.branches) {
    ui.status = 'read only';
    return false;
  }
  for (const item of ui.items) {
    if (isReadOnlyOrigin(item.origin)) {
      ui.status = 'read only';
      return false;
    }
  }
  return true;
};

const hasStagedChanges = (ui) => {
  const repo = ui.repo;
  if (repo.hasStaged) return repo.hasStaged(ui.top);
  for (const item of ui.items) {
    if (item.origin === 'staged') return true;
  }
  return false;
};

const selectedCommit = (api) => {
  const cursor = api.ui.nav.commitCursor;
  return listedCommits(api.state.commits)[cursor] ?? null;
};

const clampCommitCursor = (api) => {
  const last = listedCommits(api.state.commits).length - 1;
  const nav = api.ui.nav;
  if (nav.commitCursor > last) nav.commitCursor = Math.max(0, last);
};

const refreshCommitList = (api) => {
  const repo = api.ui.repo;
  if (!repo.listCommits) return;
  try {
    api.state.commits = repo.listCommits(api.ui.top);
  } catch (error) {
    api.ui.status = error.message;
    return;
  }
  clampCommitCursor(api);
};

const refreshAfterWrite = (api, extra = {}) => {
  refreshCommitList(api);
  api.ui.refreshFromRepo({ keepEmpty: true, ...extra });
};

const showCommits = (api) => {
  if (api.ui.mode === 'compose') return;
  const repo = api.ui.repo;
  if (!repo.listCommits) {
    api.ui.status = 'read only';
    return;
  }
  try {
    api.state.commits = repo.listCommits(api.ui.top);
  } catch (error) {
    api.ui.status = error.message;
    return;
  }
  api.ui.nav.commitCursor = 0;
  api.ui.nav.pane = 'commits';
  api.ui.status = '';
  api.ui.nav.clearSelection();
};

const onCommitMove = (api, delta) => {
  if (api.ui.mode === 'compose') return;
  const commits = listedCommits(api.state.commits);
  const next = Math.min(
    commits.length - 1,
    Math.max(0, api.ui.nav.commitCursor + delta),
  );
  if (next === api.ui.nav.commitCursor) return;
  api.ui.nav.commitCursor = next;
  api.ui.status = '';
};

const startGitCommit = (api, kind) => {
  const ui = api.ui;
  if (!isInPlaceCommit(kind) && !hasStagedChanges(ui)) {
    ui.mode = 'review';
    ui.composer.state.commitKind = null;
    ui.status = 'nothing to commit';
    return;
  }
  let text = '';
  if (kind === 'fixup') text = fixupMessage(selectedCommit(api));
  if (kind === 'commit') api.ui.nav.commitCursor = 0;
  if (kind === 'amend') {
    const headAt = api.state.commits.findIndex((entry) => entry.head);
    const at = headAt < 0 ? 0 : headAt;
    api.ui.nav.commitCursor = api.state.commits.length ? at + 1 : 0;
    if (ui.repo.lastMessage) text = ui.repo.lastMessage(ui.top) ?? '';
  }
  if (kind === 'reword') {
    const entry = selectedCommit(api);
    if (!entry || !entry.sha) return;
    if (typeof ui.repo.commitMessage === 'function') {
      text = ui.repo.commitMessage(ui.top, entry.sha) ?? '';
    } else {
      text = commitText(entry);
    }
  }
  ui.composer.state.commitBody = '';
  if (isInPlaceCommit(kind)) text = keepBriefBody(ui, text);
  ui.composer.state.commitKind = kind;
  ui.composer.openCompose('commit', text);
  const editor = ui.composer.state.editor;
  if (!editor) return;
  const lineEnd = editor.text.indexOf('\n');
  editor.cursor = lineEnd < 0 ? editor.text.length : lineEnd;
};

const onCommit = (api) => {
  if (api.ui.nav.pane !== 'commits') return void showCommits(api);
  if (!canCommit(api.ui)) return;
  api.ui.nav.commitCursor = 0;
  startGitCommit(api, 'commit');
};

const showSelectedDiff = (api) => {
  if (api.ui.mode === 'compose') return;
  const entry = selectedCommit(api);
  if (!entry) return;
  const ui = api.ui;
  if (isPending(entry) || !entry.sha) {
    ui.rev = '';
    ui.revShort = '';
  } else {
    ui.rev = entry.sha;
    ui.revShort = entry.shortSha || '';
  }
  const openDiff = () => {
    ui.nav.todoOpen = false;
    ui.nav.scroll = 0;
    ui.nav.index = 0;
    ui.nav.pane = ui.items.length ? 'diff' : 'files';
    ui.syncReviewPath();
    ui.syncFileCursor();
    ui.status = '';
  };
  ui.refreshFromRepo({ keepEmpty: true, afterLoad: openDiff });
};

const onAmend = (api) => {
  if (api.ui.nav.pane !== 'commits') return;
  if (!canCommit(api.ui)) return;
  startGitCommit(api, 'amend');
};

const onReword = (api) => {
  if (api.ui.nav.pane !== 'commits') return;
  if (!canCommit(api.ui)) return;
  startGitCommit(api, 'reword');
};

const applyFixupNow = (api) => {
  const entry = selectedCommit(api);
  if (!entry || !entry.sha) return;
  const done = 'applied';
  const repo = api.ui.repo;
  if (!repo.applyFixup) {
    api.ui.status = 'read only';
    return;
  }
  api.ui.ops.runWrite('applyFixup', [entry.sha], 'applying', done, (extra) =>
    refreshAfterWrite(api, extra),
  );
};

const onApply = (api) => {
  if (api.ui.nav.pane !== 'commits') return;
  if (!canCommit(api.ui)) return;
  const entry = selectedCommit(api);
  if (isFixupCommit(entry)) return void applyFixupNow(api);
  startGitCommit(api, 'amend');
};

const onFixup = (api) => {
  if (api.ui.nav.pane !== 'commits') return;
  if (!canCommit(api.ui)) return;
  startGitCommit(api, 'fixup');
};

const cancelCommit = (api) => {
  api.ui.mode = 'review';
  api.ui.composer.state.commitKind = null;
  api.ui.status = '';
};

const finishAsyncCommit = (api, kind, message, done, write) => {
  const ui = api.ui;
  ui.composer.closeCompose();
  const run = (top) => write(top, kind, message);
  const after = () => refreshAfterWrite(api, { doneStatus: done });
  return void ui.ops.runBusy('committing', done, run, after);
};

const finishSyncCommit = (api, kind, message, done) => {
  const ui = api.ui;
  try {
    ui.repo.commit(ui.top, kind, message);
  } catch (error) {
    ui.status = error.message;
    return;
  }
  ui.composer.closeCompose();
  ui.collection.clearDismissed();
  refreshAfterWrite(api);
  if (!ui.done && !ui.pendingExtras) {
    ui.status = done;
  }
};

const finishReword = (api, message) => {
  const ui = api.ui;
  const entry = selectedCommit(api);
  if (!entry || !entry.sha) {
    ui.status = 'read only';
    return;
  }
  const done = COMMIT_STATUS.reword;
  const repo = ui.repo;
  if (!repo.reword) {
    ui.status = 'read only';
    return;
  }
  const picked = pickRepoWrite(repo, 'reword', ui.uiOpen);
  if (picked.async) {
    ui.composer.closeCompose();
    const run = (top) => picked.write(top, entry.sha, message);
    const after = () => refreshAfterWrite(api, { doneStatus: done });
    return void ui.ops.runBusy('rewording', done, run, after);
  }
  try {
    repo.reword(ui.top, entry.sha, message);
  } catch (error) {
    ui.status = error.message;
    return;
  }
  ui.composer.closeCompose();
  refreshAfterWrite(api);
  if (!ui.status) ui.status = done;
};

const finishGitCommit = (api) => {
  const ui = api.ui;
  const kind = ui.composer.state.commitKind;
  const editor = ui.composer.state.editor;
  let message = editor ? editor.text : '';
  if (isInPlaceCommit(kind) && briefCommit(ui)) {
    message = joinMessage(message, ui.composer.state.commitBody);
  }
  if (!message.trim()) {
    ui.status = 'empty commit message';
    return;
  }
  if (!isInPlaceCommit(kind) && !hasStagedChanges(ui)) {
    ui.composer.closeCompose();
    ui.status = 'nothing to commit';
    return;
  }
  if (kind === 'reword') return void finishReword(api, message);
  const done = COMMIT_STATUS[kind] ?? 'committed';
  const uiOpen = ui.uiOpen;
  const picked = pickRepoWrite(ui.repo, 'commit', uiOpen);
  if (picked.async) {
    return void finishAsyncCommit(api, kind, message, done, picked.write);
  }
  finishSyncCommit(api, kind, message, done);
};

const onDropCommit = (api) => {
  if (api.ui.nav.pane !== 'commits') return;
  if (!canCommit(api.ui)) return;
  const entry = selectedCommit(api);
  if (!entry) return;
  api.state.dropName = entry.shortSha || entry.sha;
  api.state.dropSha = entry.sha;
  api.ui.mode = 'confirmDrop';
  api.ui.status = '';
};

const cancelDropCommit = (api) => {
  api.ui.mode = 'review';
  api.state.dropName = '';
  api.state.dropSha = '';
  api.ui.status = '';
};

const confirmDropCommit = (api) => {
  const sha = api.state.dropSha;
  const name = api.state.dropName;
  api.ui.mode = 'review';
  api.state.dropName = '';
  api.state.dropSha = '';
  if (!sha) return;
  const done = `dropped ${name}`;
  const repo = api.ui.repo;
  if (!repo.dropCommit) {
    api.ui.status = 'read only';
    return;
  }
  api.ui.ops.runWrite('dropCommit', [sha], 'dropping', done, (extra) =>
    refreshAfterWrite(api, extra),
  );
};

const onView = (api) => {
  if (api.ui.nav.pane !== 'commits') return;
  const next = api.state.commitView === 'full' ? 'brief' : 'full';
  api.state.commitView = next;
  api.ui.nav.listScroll = 0;
  api.ui.status = next;
};

const reset = (state) => {
  state.commits = [];
  state.dropName = '';
  state.dropSha = '';
  state.commitView = 'brief';
};

const createCommitController = (ui) => {
  const state = {
    commits: [],
    dropName: '',
    dropSha: '',
    commitView: 'brief',
  };
  const api = { ui, state };
  return stateView(
    state,
    {
      reset: () => reset(state),
      canCommit: () => canCommit(ui),
      onCommit: () => onCommit(api),
      onAmend: () => onAmend(api),
      onReword: () => onReword(api),
      onApply: () => onApply(api),
      onFixup: () => onFixup(api),
      onCommitMove: (delta) => onCommitMove(api, delta),
      onShowDiff: () => showSelectedDiff(api),
      onView: () => onView(api),
      cancelCommit: () => cancelCommit(api),
      startGitCommit: (kind) => startGitCommit(api, kind),
      finishGitCommit: () => finishGitCommit(api),
      refresh: () => refreshCommitList(api),
      onDropCommit: () => onDropCommit(api),
      cancelDropCommit: () => cancelDropCommit(api),
      confirmDropCommit: () => confirmDropCommit(api),
    },
    ['commits', 'dropName', 'commitView'],
  );
};

module.exports = {
  COMMIT_STATUS,
  hasStagedChanges,
  createCommitController,
  listedCommits,
};
