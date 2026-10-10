'use strict';

const { isReadOnlyOrigin } = require('../files.js');
const { saveUiPrefs } = require('./agent-jobs.js');
const { isFixupCommit } = require('./actions.js');
const { pickRepoWrite } = require('./ops.js');
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

const joinMessage = (line, rest) => (rest ? `${line}\n${rest}` : line);

const tidyCommitMessage = (message) => {
  const lines = `${message ?? ''}`.split('\n').map((line) => line.trim());
  while (lines.length && lines[0] === '') lines.shift();
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
};

const fixupMessage = (entry) => {
  const subject = commitLine(entry).trim();
  if (!subject) return 'fixup!';
  return `fixup! ${subject}`;
};

const hasStagedChanges = (ui) => {
  const repo = ui.repo;
  if (repo.hasStaged) return repo.hasStaged(ui.top);
  return ui.items.some((item) => item.origin === 'staged');
};

class CommitController {
  constructor(ui) {
    this.ui = ui;
    this.reset();
  }

  reset() {
    this.commits = [];
    this.dropName = '';
    this.dropSha = '';
    this.commitView = 'brief';
  }

  get brief() {
    return this.commitView !== 'full';
  }

  canCommit() {
    const ui = this.ui;
    const readOnly =
      !ui.capabilities.branches ||
      ui.items.some((item) => isReadOnlyOrigin(item.origin));
    if (readOnly) ui.status = 'read only';
    return !readOnly;
  }

  canWrite() {
    return this.ui.nav.pane === 'commits' && this.canCommit();
  }

  selected() {
    return listedCommits(this.commits)[this.ui.nav.commitCursor] ?? null;
  }

  loadCommits() {
    const ui = this.ui;
    try {
      this.commits = ui.repo.listCommits(ui.top);
      return true;
    } catch (error) {
      ui.status = error.message;
      return false;
    }
  }

  refresh() {
    if (!this.ui.repo.listCommits || !this.loadCommits()) return;
    const last = listedCommits(this.commits).length - 1;
    const nav = this.ui.nav;
    if (nav.commitCursor > last) nav.commitCursor = Math.max(0, last);
  }

  refreshAfterWrite(extra = {}) {
    this.refresh();
    this.ui.refreshFromRepo({ keepEmpty: true, ...extra });
  }

  indexForView() {
    const ui = this.ui;
    if (hasStagedChanges(ui)) return 0;
    const list = listedCommits(this.commits);
    const want = `${ui.rev ?? ''}`;
    const short = `${ui.revShort ?? ''}`;
    if (!want && !short) return 0;
    for (let i = 0; i < list.length; i++) {
      const entry = list[i];
      if (entry.pending) continue;
      const sha = `${entry.sha ?? ''}`;
      const brief = `${entry.shortSha ?? ''}`;
      if (want && sha === want) return i;
      if (short && (brief === short || sha.startsWith(short))) return i;
    }
    return 0;
  }

  show() {
    const ui = this.ui;
    if (ui.mode === 'compose') return;
    if (!ui.repo.listCommits) {
      ui.status = 'read only';
      return;
    }
    if (!this.loadCommits()) return;
    const nav = ui.nav;
    nav.commitCursor = this.indexForView();
    nav.pane = 'commits';
    nav.resetListScroll('commits');
    ui.status = '';
    nav.clearSelection();
  }

  onCommitMove(delta) {
    const nav = this.ui.nav;
    if (this.ui.mode === 'compose') return;
    const last = listedCommits(this.commits).length - 1;
    const next = Math.min(last, Math.max(0, nav.commitCursor + delta));
    if (next === nav.commitCursor) return;
    nav.commitCursor = next;
    this.ui.status = '';
  }

  messageFor(kind) {
    const ui = this.ui;
    if (kind === 'fixup') return fixupMessage(this.selected());
    if (kind === 'amend') {
      const headAt = this.commits.findIndex((entry) => entry.head);
      const at = headAt < 0 ? 0 : headAt;
      ui.nav.commitCursor = this.commits.length ? at + 1 : 0;
      if (ui.repo.lastMessage) return ui.repo.lastMessage(ui.top) ?? '';
      return '';
    }
    if (kind === 'reword') {
      const entry = this.selected();
      if (!entry || !entry.sha) return null;
      if (!ui.repo.commitMessage) return commitText(entry);
      return ui.repo.commitMessage(ui.top, entry.sha) ?? '';
    }
    ui.nav.commitCursor = 0;
    return '';
  }

  start(kind) {
    const ui = this.ui;
    const composer = ui.composer;
    if (!isInPlaceCommit(kind) && !hasStagedChanges(ui)) {
      ui.mode = 'review';
      composer.commitKind = null;
      ui.status = 'nothing to commit';
      return;
    }
    let text = this.messageFor(kind);
    if (text === null) return;
    composer.commitBody = '';
    if (isInPlaceCommit(kind) && this.brief) {
      const parts = splitMessage(text);
      composer.commitBody = parts.rest;
      text = parts.line;
    }
    composer.commitKind = kind;
    ui.composer.openCompose('commit', text);
    const editor = composer.editor;
    const lineEnd = editor.text.indexOf('\n');
    editor.cursor = lineEnd < 0 ? editor.text.length : lineEnd;
  }

  onInsert() {
    const entry = this.selected();
    if (!entry || entry.pending || !entry.sha) {
      if (this.canCommit()) this.start('commit');
      return;
    }
    if (!this.canWrite()) return;
    this.ui.status = '';
    this.ui.mode = 'confirmCommit';
  }

  chooseCommit(kind) {
    this.ui.mode = 'review';
    if (kind === 'update') return void this.onUpdate();
    if (kind === 'amend') {
      this.onAmend();
      return;
    }
    if (kind === 'fixup') {
      this.onFixup();
      return;
    }
    this.start('commit');
  }

  onUpdate() {
    if (!this.canWrite()) return;
    const entry = this.selected();
    if (!entry || !entry.sha) return;
    if (!hasStagedChanges(this.ui)) {
      this.ui.status = 'nothing to commit';
      return;
    }
    if (!this.ui.repo.updateCommit) {
      this.ui.status = 'read only';
      return;
    }
    const after = (extra) => this.refreshAfterWrite(extra);
    this.ui.ops.runWrite(
      'updateCommit',
      [entry.sha],
      'updating',
      'updated',
      after,
    );
  }

  cancelCommitChoice() {
    this.ui.mode = 'review';
  }

  onCommit() {
    if (this.ui.nav.pane === 'commits') return;
    this.show();
  }

  onShowDiff() {
    const ui = this.ui;
    if (ui.mode === 'compose') return;
    const entry = this.selected();
    if (!entry) return;
    const viewingCommit = Boolean(ui.rev || ui.revShort);
    if (entry.pending && !viewingCommit) return void this.onInsert();
    const sha = entry.pending ? '' : entry.sha || '';
    ui.rev = sha;
    ui.revShort = sha ? entry.shortSha || '' : '';
    const afterLoad = () => {
      const nav = ui.nav;
      nav.tasksOpen = false;
      nav.scroll = 0;
      nav.index = 0;
      nav.pane = ui.items.length ? 'diff' : 'files';
      ui.syncReviewPath();
      ui.syncFileCursor();
      ui.status = '';
    };
    ui.refreshFromRepo({ keepEmpty: true, afterLoad });
  }

  onAmend() {
    if (this.canWrite()) this.start('amend');
  }

  onReword() {
    if (this.canWrite()) this.start('reword');
  }

  onFixup() {
    if (this.canWrite()) this.start('fixup');
  }

  onApply() {
    if (!this.canWrite()) return;
    const entry = this.selected();
    if (!isFixupCommit(entry)) return void this.start('amend');
    if (!entry.sha) return;
    if (!this.ui.repo.applyFixup) {
      this.ui.status = 'read only';
      return;
    }
    const after = (extra) => this.refreshAfterWrite(extra);
    this.ui.ops.runWrite(
      'applyFixup',
      [entry.sha],
      'applying',
      'applied',
      after,
    );
  }

  runAsync(kind, done, run) {
    this.ui.composer.closeCompose();
    const after = () => this.refreshAfterWrite({ doneStatus: done });
    this.ui.ops.runBusy(kind, done, run, after);
  }

  finishReword(message) {
    const ui = this.ui;
    const entry = this.selected();
    if (!entry || !entry.sha || !ui.repo.reword) {
      ui.status = 'read only';
      return;
    }
    const done = COMMIT_STATUS.reword;
    const picked = pickRepoWrite(ui.repo, 'reword', ui.uiOpen);
    if (picked.async) {
      const run = (top) => picked.write(top, entry.sha, message);
      return void this.runAsync('rewording', done, run);
    }
    try {
      ui.repo.reword(ui.top, entry.sha, message);
    } catch (error) {
      ui.status = error.message;
      return;
    }
    ui.composer.closeCompose();
    this.refreshAfterWrite();
    if (!ui.status) ui.status = done;
  }

  finishGitCommit() {
    const ui = this.ui;
    const composer = ui.composer;
    const kind = composer.commitKind;
    let message = composer.editor ? composer.editor.text : '';
    if (isInPlaceCommit(kind) && this.brief) {
      message = joinMessage(message, composer.commitBody);
    }
    message = tidyCommitMessage(message);
    if (!message.trim()) {
      ui.status = 'empty commit message';
      return;
    }
    if (!isInPlaceCommit(kind) && !hasStagedChanges(ui)) {
      ui.composer.closeCompose();
      ui.status = 'nothing to commit';
      return;
    }
    if (kind === 'reword') return void this.finishReword(message);
    const done = COMMIT_STATUS[kind] ?? 'committed';
    const picked = pickRepoWrite(ui.repo, 'commit', ui.uiOpen);
    if (picked.async) {
      const run = (top) => picked.write(top, kind, message);
      return void this.runAsync('committing', done, run);
    }
    try {
      ui.repo.commit(ui.top, kind, message);
    } catch (error) {
      ui.status = error.message;
      return;
    }
    ui.composer.closeCompose();
    ui.collection.clearDismissed();
    this.refreshAfterWrite();
    if (!ui.done && !ui.pendingExtras) ui.status = done;
  }

  onDropCommit() {
    if (!this.canWrite()) return;
    const entry = this.selected();
    if (!entry) return;
    this.dropName = entry.shortSha || entry.sha;
    this.dropSha = entry.sha;
    this.ui.mode = 'confirmDrop';
    this.ui.status = '';
  }

  cancelDropCommit() {
    this.ui.mode = 'review';
    this.dropName = '';
    this.dropSha = '';
    this.ui.status = '';
  }

  confirmDropCommit() {
    const sha = this.dropSha;
    const done = `dropped ${this.dropName}`;
    this.ui.mode = 'review';
    this.dropName = '';
    this.dropSha = '';
    if (!sha) return;
    if (!this.ui.repo.dropCommit) {
      this.ui.status = 'read only';
      return;
    }
    const after = (extra) => this.refreshAfterWrite(extra);
    this.ui.ops.runWrite('dropCommit', [sha], 'dropping', done, after);
  }

  onView() {
    if (this.ui.nav.pane !== 'commits') return;
    this.commitView = this.brief ? 'full' : 'brief';
    this.ui.nav.listScroll = 0;
    this.ui.status = this.commitView;
    const root = this.ui.top || this.ui.cwd;
    saveUiPrefs(root, { commitView: this.commitView });
  }
}

module.exports = { hasStagedChanges, listedCommits, CommitController };
