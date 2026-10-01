'use strict';

const render = require('./render/render.js');
const { renderFrame } = render;
const keys = require('./keys.js');
const { decodeChunk } = keys;
const review = require('./review.js');
const { AUTOSAVE_MS, hasNotes } = review;
const files = require('./files.js');
const { makeTaskItem } = files;
const capabilities = require('./capabilities.js');
const { sessionCapabilities } = capabilities;
const actions = require('./session/actions.js');
const { LIST_PANES } = actions;
const terminal = require('./session/terminal.js');
const { Terminal, LEAVE_TERM } = terminal;
const load = require('./session/load.js');
const { LoadCoordinator } = load;
const items = require('./session/items.js');
const { ItemCollection } = items;
const navigation = require('./session/navigation.js');
const { Navigation } = navigation;
const sessionReview = require('./session/review.js');
const { ReviewController } = sessionReview;
const update = require('./session/update.js');
const { UpdateCoordinator } = update;
const progress = require('./session/progress.js');
const { Progress } = progress;
const compose = require('./session/compose.js');
const { Composer } = compose;
const ops = require('./session/ops.js');
const { OpsRunner } = ops;
const commit = require('./session/commit.js');
const { CommitController } = commit;
const branches = require('./session/branches.js');
const { BranchController } = branches;
const npm = require('./session/npm.js');
const { NpmController } = npm;
const accessors = require('./session/accessors.js');
const { bindAccessors, bindGetters } = accessors;
const view = require('./session/view.js');
const filesPane = require('./session/files-pane.js');
const lifecycle = require('./session/lifecycle.js');
const { Lifecycle } = lifecycle;
const dispatch = require('./session/dispatch.js');
const { dispatchAction, confirmChoice, handleEvent } = dispatch;
const dashboard = require('./session/dashboard.js');
const { Dashboard } = dashboard;

const PROGRESS_MS = 160;

const NAV_FIELDS = [
  'pane',
  'index',
  'fileCursor',
  'branchCursor',
  'commitCursor',
  'npmCursor',
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
  session.dashboard = new Dashboard(session);
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
    this.dashboard.reset();
    this.top = this.cwd;
    this.branch = '';
    this.status = '';
    this.layout = 'unified';
    this.done = false;
    this.exitCode = 0;
    this.mode = 'review';
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
    if (this.nav.tasksOpen) this.nav.scroll = frame.scroll;
    const editScroll = frame.cursor && frame.cursor.scroll;
    if (this.editor && typeof editScroll === 'number') {
      this.editor.scrollCol = editScroll;
    }
    const composing = this.mode === 'compose';
    this.term.paint(frame, size, composing ? frame.cursor : null);
    this.scheduleAutosave();
    this.dashboard.afterDraw();
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
  }

  selectTemplate(index) {
    this.runComposeCommand(this.composer.templates.selectTemplate(index));
  }

  autosave() {
    this.composer.autosave();
  }

  onQuit() {
    if (this.mode === 'compose') {
      this.composer.commitCompose();
      this.composer.closeCompose();
    }
    if (hasNotes(this.notes)) {
      this.mode = 'confirmQuit';
      this.status = '';
      return;
    }
    this.done = true;
    this.exitCode = 0;
  }

  finishQuit(status) {
    const result = this.review.finishQuit(status);
    if (!result.ok) this.status = result.error.message;
    this.done = true;
    this.exitCode = 0;
  }

  cancelQuit() {
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
    });
  }
}

module.exports = { LEAVE_TERM, Session };
