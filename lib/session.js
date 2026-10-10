'use strict';

const { renderFrame } = require('./render/render.js');
const { decodeChunk } = require('./keys.js');
const { AUTOSAVE_MS, hasNotes } = require('./review.js');
const { makeTaskItem } = require('./files.js');
const { sessionCapabilities } = require('./capabilities.js');
const { LIST_PANES } = require('./session/actions.js');
const { Terminal, LEAVE_TERM } = require('./session/terminal.js');
const { LoadCoordinator } = require('./session/load.js');
const { ItemCollection } = require('./session/items.js');
const { Navigation } = require('./session/navigation.js');
const { ReviewController } = require('./session/review.js');
const { UpdateCoordinator } = require('./session/update.js');
const { Progress } = require('./session/progress.js');
const { Composer } = require('./session/compose.js');
const { OpsRunner } = require('./session/ops.js');
const { CommitController } = require('./session/commit.js');
const { BranchController } = require('./session/branches.js');
const { NpmController } = require('./session/npm.js');
const { PackageController } = require('./session/packages.js');
const { AgentsController } = require('./session/agents.js');
const { bindAccessors, bindGetters } = require('./session/accessors.js');
const view = require('./session/view.js');
const filesPane = require('./session/files-pane.js');
const { Lifecycle } = require('./session/lifecycle.js');
const dispatch = require('./session/dispatch.js');
const { dispatchAction, confirmChoice, handleEvent } = dispatch;
const { Dashboard } = require('./session/dashboard.js');
const { Workspace } = require('./session/workspace.js');

const PROGRESS_MS = 160;

const NAV_FIELDS = [
  'pane',
  'index',
  'fileCursor',
  'branchCursor',
  'commitCursor',
  'npmCursor',
  'packagesCursor',
  'agentCursor',
  'scroll',
  'listScroll',
  'reviewPath',
  'fileScope',
  'unitLine',
  'selection',
  'mouseAnchor',
  'pendingClick',
  'tasksOpen',
  'tasksFocus',
  'planOpen',
  'planCursor',
];

const COMPOSER_FIELDS = [
  'editor',
  'composeKind',
  'commitKind',
  'composeTaskId',
  'templateIndex',
  'templateFocus',
];

const assignOptions = (session, options) => {
  session.repo = options.repo;
  session.cwd = options.cwd;
  session.paths = options.paths ?? [];
  session.stdin = options.stdin ?? null;
  session.stdout = options.stdout;
  session.proc = options.proc ?? process;
  session.color = options.color ?? true;
  session.rev = options.rev ?? null;
  session.revShort = '';
  session.sourceLabel = options.sourceLabel ?? '';
  session.repoName = options.repoName ?? '';
  session.change = options.change ?? null;
  session.forceNewReview = options.newReview === true;
  session.readOnly = options.readOnly === true;
  session.capabilities = sessionCapabilities(options);
  session.audit = options.audit === true;
  session.outdatedMap = options.outdatedMap;
  session.auditMap = options.auditMap;
  session.updateOpts = options.update;
  session.dashboardHome = options.startPane === 'dashboard';
  session.workspaceRoot = options.workspace ? options.workspace.root : '';
  session.workspaceInfo = options.workspace ?? null;
  session.loadPullRequest = options.loadPullRequest ?? null;
  session.loadMergeRequest = options.loadMergeRequest ?? null;
  session.loadGithubIssue = options.loadGithubIssue ?? null;
  session.loadGitlabIssue = options.loadGitlabIssue ?? null;
  session.fetchImpl = options.fetch ?? null;
};

const assignParts = (session, options) => {
  const { stdin, stdout, proc } = session;
  session.term = new Terminal({ stdin, stdout, proc });
  session.loader = new LoadCoordinator();
  session.collection = new ItemCollection();
  session.nav = new Navigation({ startPane: options.startPane ?? 'files' });
  session.review = new ReviewController();
  const tick = () => session.tickProgress();
  session.progress = new Progress(session.term, tick, PROGRESS_MS);
  session.updater = new UpdateCoordinator(session);
  session.composer = new Composer(session);
  session.ops = new OpsRunner(session);
  session.commits = new CommitController(session);
  session.gitBranches = new BranchController(session);
  session.npm = new NpmController(session);
  session.packages = new PackageController(session);
  session.agents = new AgentsController(session);
  session.dashboard = new Dashboard(session);
  session.workspace = new Workspace(session);
  session.lifecycle = new Lifecycle(session);
};

const bindFields = (session) => {
  bindAccessors(session, session.nav, NAV_FIELDS);
  bindAccessors(session, session.composer, COMPOSER_FIELDS);
  bindAccessors(session, session.loader, ['pendingExtras']);
  bindGetters(session, session.loader, ['didLoad']);
  bindAccessors(session, session.collection, ['items']);
  bindGetters(session, session.collection, ['dismissed']);
  bindGetters(session, session.updater, ['installPromise']);
  bindAccessors(session, session.ops, ['gitBusy', 'busy']);
  bindAccessors(session, session.gitBranches, ['branches', 'dropName']);
  bindGetters(session, session.term, ['lastFrame', 'lastSize']);
};

class Session {
  constructor(options) {
    assignOptions(this, options);
    assignParts(this, options);
    bindFields(this);
    this.resetState();
  }

  get notes() {
    return this.review.store;
  }

  getSize() {
    const width = this.stdout.columns ?? 80;
    const height = this.stdout.rows ?? 24;
    return { width, height };
  }

  resetState() {
    this.collection.reset();
    this.nav.reset();
    this.review.reset();
    this.composer.reset();
    this.ops.reset();
    this.gitBranches.reset();
    this.commits.reset();
    this.npm.reset();
    this.agents.reset();
    this.dashboard.reset();
    this.workspace.reset();
    this.top = this.cwd;
    this.branch = '';
    this.status = '';
    this.layout = 'unified';
    this.lineNumbers = false;
    this.done = false;
    this.exitCode = 0;
    this.mode = 'review';
    this.quitWarning = '';
    this.tasksItem = makeTaskItem();
    this.progressFrame = 0;
    this.emptyReview = false;
    this.loadError = null;
    this.uiOpen = false;
    this.finishReadLoop = null;
    this.lifecycle.stopWatch();
    this.lifecycle.clearNpmExtras();
    this.term.resetCache();
    this.loader.reset();
    this.updater.reset();
    this.progress.clear();
  }

  ensureRepo() {
    if (!this.repo.toplevel) return;
    this.top = this.repo.toplevel(this.cwd);
  }

  load() {
    this.lifecycle.load();
  }

  loadReady() {
    return this.lifecycle.loadReady();
  }

  openLoad() {
    return this.lifecycle.openLoad();
  }

  refreshFromRepo(options) {
    return this.lifecycle.refreshFromRepo(options);
  }

  reloadAfterChange(afterLoad) {
    this.lifecycle.reloadAfterChange(afterLoad);
  }

  ignoreWatch(ms) {
    this.lifecycle.ignoreWatch(ms);
  }

  paint() {
    if (this.uiOpen) this.draw();
  }

  draw() {
    if (this.term.disposed) return;
    const size = this.getSize();
    const frame = renderFrame(this.view(), {
      width: size.width,
      height: size.height,
      color: this.color,
    });
    if (LIST_PANES.includes(this.pane)) {
      this.nav.listScroll = frame.listScroll;
    }
    const menuScroll = frame.menuScroll;
    if (this.agents.pick && typeof menuScroll === 'number') {
      this.agents.pick.scroll = menuScroll;
    }
    const planPick = this.composer.tasks.planPick;
    if (planPick && typeof menuScroll === 'number') {
      planPick.scroll = menuScroll;
    }
    if (typeof frame.runScroll === 'number') {
      this.agents.runScroll = frame.runScroll;
    }
    if (this.nav.tasksOpen) this.nav.scroll = frame.scroll;
    const editScroll = frame.cursor && frame.cursor.scroll;
    if (this.editor && typeof editScroll === 'number') {
      this.editor.scrollCol = editScroll;
    }
    const composing = this.mode === 'compose';
    this.term.paint(frame, size, composing ? frame.cursor : null);
    this.agents.fitPty(size.width, frame.bodyH);
    this.scheduleAutosave();
    this.dashboard.afterDraw();
    this.workspace.afterDraw();
  }

  scheduleAutosave() {
    if (!this.finishReadLoop) return;
    const dirty = this.notes && this.notes.dirty;
    if (!dirty && this.composeKind === null) return;
    this.term.later('save', () => this.autosave(), AUTOSAVE_MS);
  }

  view() {
    return view.view(this);
  }

  fileList() {
    return view.fileList(this);
  }

  current() {
    return this.nav.current(this.items, this.tasksItem);
  }

  fileCursorEntry() {
    return filesPane.fileCursorEntry(this);
  }

  clampIndex() {
    filesPane.clampIndex(this);
  }

  syncReviewPath() {
    filesPane.syncReviewPath(this);
  }

  syncFileCursor() {
    filesPane.syncFileCursor(this);
  }

  showFiles() {
    filesPane.showFiles(this);
  }

  dispatch(action) {
    dispatchAction(this, action);
  }

  confirmChoice(key) {
    confirmChoice(this, key);
  }

  handleEvent(event) {
    handleEvent(this, event);
  }

  pushInput(text) {
    const decoded = decodeChunk(text, this.term.carry);
    this.term.carry = decoded.carry;
    for (const event of decoded.events) {
      this.handleEvent(event);
      if (this.done) return;
    }
    if (this.term.carry === '\x1b') {
      this.term.carry = '';
      this.handleEvent({ type: 'key', key: 'escape' });
    }
  }

  initReview() {
    this.review.init(this.top, new Date(), {
      forceNew: this.forceNewReview,
    });
  }

  flushReview(force) {
    const result = this.review.flush(force === true);
    if (!result.ok) {
      this.status = result.error.message;
      return false;
    }
    this.lifecycle.noteReviewStamp();
    return result.wrote;
  }

  runComposeCommand(result) {
    if (!result) return;
    if (result.kind === 'commit') this.commits.finishGitCommit();
    if (result.kind === 'branch') this.gitBranches.finishCreateBranch();
    if (result.kind === 'npm') this.npm.finishEdit();
    if (result.kind === 'package') this.packages.finishAdd();
  }

  selectTemplate(index) {
    this.runComposeCommand(this.composer.templates.selectTemplate(index));
  }

  autosave() {
    this.composer.autosave();
  }

  childWarning() {
    const tests = this.npm && this.npm.running === true;
    const agents = this.agents && this.agents.runningCount() > 0;
    if (tests && agents) return ' exit will terminate tests and agents';
    if (agents) return ' exit will terminate agents';
    if (tests) return ' exit will terminate tests';
    return '';
  }

  liveChildren() {
    return this.childWarning() !== '';
  }

  stopChildren() {
    if (this.npm && this.npm.child) this.npm.child.kill();
    if (this.agents) this.agents.killAll();
  }

  exitNow() {
    this.flushReview();
    this.done = true;
    this.exitCode = 0;
  }

  onQuit() {
    if (this.mode === 'compose') {
      this.composer.commitCompose();
      this.composer.closeCompose();
    }
    if (this.liveChildren()) {
      this.quitWarning = this.childWarning();
      this.mode = 'confirmQuit';
      this.status = '';
      return;
    }
    this.exitNow();
  }

  confirmQuit() {
    this.stopChildren();
    this.exitNow();
  }

  cancelQuit() {
    this.quitWarning = '';
    this.mode = 'review';
    this.status = '';
  }

  startProgress() {
    this.progress.start('busy');
  }

  stopProgress() {
    this.progress.stop('busy');
  }

  tickProgress() {
    this.progressFrame += 1;
    this.paint();
  }

  openUpdate() {
    return this.updater.open();
  }

  async startUi() {
    const empty = !this.items.length;
    const notes = this.notes && hasNotes(this.notes);
    const worktree = !this.rev && !this.change;
    if (this.didLoad && empty && !notes && !worktree) {
      this.emptyReview = true;
      return 0;
    }
    this.uiOpen = true;
    this.term.enter();
    try {
      if (this.nav.pane === 'repos') this.workspace.start();
      this.openLoad();
      this.openUpdate();
      this.draw();
      await this.readLoop();
    } finally {
      this.uiOpen = false;
      this.term.close();
      this.loader.abort();
      if (this.installPromise) {
        try {
          await this.installPromise;
        } catch {
          // ignore install errors after the UI closes
        }
      }
    }
    return this.exitCode;
  }

  readLoop() {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.lifecycle.stopWatch();
        this.dashboard.stop();
        this.workspace.stop();
        this.term.stopListening();
        this.progress.clear();
        this.term.clearTimers();
        this.finishReadLoop = null;
        resolve();
      };
      this.finishReadLoop = finish;
      if (this.done) {
        finish();
        return;
      }
      const onData = (chunk) => {
        this.pushInput(chunk.toString('utf8'));
        if (this.done) return void finish();
        this.draw();
      };
      this.term.startListening({ onData, onResize: () => this.draw() });
      this.lifecycle.startWatch();
      if (this.dashboardHome) this.dashboard.start();
      if (this.nav.pane === 'repos') this.workspace.start();
    });
  }
}

module.exports = { LEAVE_TERM, Session };
