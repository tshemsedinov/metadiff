'use strict';

const render = require('./render/render.js');
const keys = require('./keys.js');
const review = require('./review.js');
const files = require('./files.js');
const { makeTodoItem } = files;
const { renderFrame } = render;
const { decodeChunk } = keys;
const { AUTOSAVE_MS, hasNotes } = review;
const capabilities = require('./capabilities.js');
const actions = require('./session/actions.js');
const { LIST_PANES } = actions;
const { sessionCapabilities } = capabilities;
const terminal = require('./session/terminal.js');
const { createTerminal, LEAVE_TERM } = terminal;
const load = require('./session/load.js');
const { createLoadCoordinator } = load;
const items = require('./session/items.js');
const { createItemCollection } = items;
const navigation = require('./session/navigation.js');
const { createNavigation } = navigation;
const sessionReview = require('./session/review.js');
const { createReviewController } = sessionReview;
const update = require('./session/update.js');
const { createUpdateCoordinator } = update;
const progress = require('./session/progress.js');
const { createProgress } = progress;
const compose = require('./session/compose.js');
const { createComposer } = compose;
const ops = require('./session/ops.js');
const { createOpsRunner } = ops;
const changeActions = require('./session/change-actions.js');
const { createChangeActions } = changeActions;
const commit = require('./session/commit.js');
const { createCommitController } = commit;
const branches = require('./session/branches.js');
const { createBranchController } = branches;
const npm = require('./session/npm.js');
const { createNpmController } = npm;
const accessors = require('./session/accessors.js');
const { bindAccessors, bindGetters, bindAlias } = accessors;
const view = require('./session/view.js');
const { createView } = view;
const filesPane = require('./session/files-pane.js');
const { createFilesPane } = filesPane;
const lifecycle = require('./session/lifecycle.js');
const { createLifecycle } = lifecycle;
const pointer = require('./session/pointer.js');
const { createPointer } = pointer;
const dispatch = require('./session/dispatch.js');
const { createDispatcher, createInput } = dispatch;

const CURSOR_BLINK_MS = 500;
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
  'todoOpen',
  'todoFocus',
];

const COMPOSER_FIELDS = [
  'editor',
  'composeKind',
  'commitKind',
  'composeTodoId',
  'composeBaseline',
  'templateIndex',
  'templateFocus',
  'blinkOn',
];

const assignOptions = (session, options) => {
  session.repo = options.repo;
  session.cwd = options.cwd;
  session.paths = options.paths ?? [];
  session.stdin = options.stdin ?? null;
  session.stdout = options.stdout;
  session.proc = options.proc ?? process;
  session.color = options.color ?? true;
  session.getSize = () => {
    const width = session.stdout.columns ?? 80;
    const height = session.stdout.rows ?? 24;
    return { width, height };
  };
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
  session.term = createTerminal({
    stdin: session.stdin,
    stdout: session.stdout,
    proc: session.proc,
  });
  session.loader = createLoadCoordinator();
  session.collection = createItemCollection();
  session.nav = createNavigation({
    startPane: options.startPane ?? 'files',
  });
  session.review = createReviewController();
  session.progress = createProgress(
    session.term,
    () => session.tickProgress(),
    PROGRESS_MS,
  );
};

const assignComposer = (session) => {
  session.composer = createComposer({
    nav: session.nav,
    review: session.review,
    ui: session,
    restartBlink: () => {
      if (!session.term.hasTimer('blink')) return;
      session.term.restartTimer(
        'blink',
        () => session.tickBlink(),
        CURSOR_BLINK_MS,
      );
    },
  });
};

const assignControllers = (session) => {
  session.ops = createOpsRunner(session);
  session.changeActions = createChangeActions(session);
  session.commits = createCommitController(session);
  session.gitBranches = createBranchController(session);
  session.npm = createNpmController(session);
};

const bindSessionAccessors = (session) => {
  bindAccessors(session, session.nav, NAV_FIELDS);
  bindAccessors(session, session.composer.state, COMPOSER_FIELDS);
  bindAccessors(session, session.loader, ['pendingExtras']);
  bindAlias(
    session,
    'loadPromise',
    () => session.loader.promise,
    (value) => {
      session.loader.promise = value;
    },
  );
  bindAccessors(session, session.collection, ['items']);
  bindGetters(session, session.collection, ['dismissed']);
  bindAccessors(session, session.updater, ['installPromise']);
  bindAccessors(session, session.ops, ['gitBusy', 'busy']);
  bindAccessors(session, session.gitBranches, ['branches', 'dropName']);
  bindGetters(session, session.term, ['lastFrame', 'lastSize']);
  bindAlias(session, 'loadGen', () => session.loader.gen);
  bindAlias(
    session,
    'didLoad',
    () => session.loader.didLoad,
    (value) => {
      session.loader.didLoad = value;
      if (value) session.updater.maybePrompt();
    },
  );
  bindAlias(session, 'notes', () => session.review.store);
  bindAlias(session, 'didResumeReview', () => session.review.didResume);
  bindAlias(
    session,
    'importedRemoteNotes',
    () => session.review.importedRemote,
  );
  bindAlias(
    session,
    'updateOffer',
    () => session.updater.offer,
    (value) => {
      session.updater.offer = value;
    },
  );
  bindAlias(session, 'updateFrom', () => session.updater.from);
  bindAlias(session, 'updateTo', () => session.updater.to);
  bindAlias(session, 'updatePromise', () => session.updater.checkPromise);
};

const bindViewer = (session) => {
  session.viewer = createView({
    nav: session.nav,
    composer: session.composer,
    collection: session.collection,
    review: session.review,
    gitBranches: session.gitBranches,
    commits: session.commits,
    npm: session.npm,
    updater: session.updater,
    ui: session,
  });
};

const bindLifecycle = (session) => {
  session.lifecycle = createLifecycle({
    loader: session.loader,
    collection: session.collection,
    review: session.review,
    nav: session.nav,
    ops: session.ops,
    updater: session.updater,
    loadConfig: {
      repo: session.repo,
      cwd: session.cwd,
      paths: session.paths,
      audit: session.audit,
      outdatedMap: session.outdatedMap,
      auditMap: session.auditMap,
    },
    ui: session,
  });
};

const bindDispatch = (session) => {
  session.dispatcher = createDispatcher(session);
  session.pointer = createPointer(session);
  session.input = createInput(session);
};

const composeSession = (session, options) => {
  assignOptions(session, options);
  session.updater = createUpdateCoordinator(session);
  assignComposer(session);
  assignControllers(session);
  bindSessionAccessors(session);
  bindViewer(session);
  session.filesPane = createFilesPane(session);
  bindLifecycle(session);
  bindDispatch(session);
};

class Session {
  constructor(options) {
    composeSession(this, options);
    this.resetState();
  }

  resetState() {
    if (this.collection) this.collection.reset();
    if (this.nav) this.nav.reset();
    if (this.review) this.review.reset();
    if (this.composer) this.composer.reset();
    if (this.ops) this.ops.reset();
    if (this.gitBranches) this.gitBranches.reset();
    if (this.commits) this.commits.reset();
    if (this.npm) this.npm.reset();
    this.top = this.cwd;
    this.branch = '';
    this.status = '';
    this.layout = 'unified';
    this.done = false;
    this.exitCode = 0;
    this.mode = 'review';
    this.todoItem = makeTodoItem();
    this.progressFrame = 0;
    this.emptyReview = false;
    this.loadError = null;
    this.uiOpen = false;
    this.finishReadLoop = null;
    if (this.lifecycle) this.lifecycle.stopWatch();
    if (this.lifecycle) this.lifecycle.clearNpmExtras();
    if (this.term) this.term.resetCache();
    if (this.loader) this.loader.reset();
    if (this.updater) this.updater.reset();
    if (this.progress) this.progress.clear();
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

  applyLoaded(loaded) {
    return this.lifecycle.applyLoaded(loaded);
  }

  paint() {
    if (!this.uiOpen) return;
    this.draw();
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
    if (this.nav.todoOpen) this.nav.scroll = frame.scroll;
    const composing = this.mode === 'compose';
    const cursor = composing && this.blinkOn ? frame.cursor : null;
    this.term.paint(frame, size, cursor);
  }

  view() {
    return this.viewer.view();
  }

  fileList() {
    return this.viewer.fileList();
  }

  counts() {
    return this.viewer.counts();
  }

  viewStatus() {
    return this.viewer.viewStatus();
  }

  current() {
    return this.nav.current(this.items, this.todoItem);
  }

  fileCursorEntry() {
    return this.changeActions.fileCursorEntry();
  }

  clampIndex() {
    this.filesPane.clampIndex();
  }

  syncReviewPath() {
    this.filesPane.syncReviewPath();
  }

  syncFileCursor() {
    this.filesPane.syncFileCursor();
  }

  showFiles() {
    this.filesPane.showFiles();
  }

  dispatch(action) {
    this.dispatcher.dispatch(action);
  }

  handleEvent(event) {
    this.input.handleEvent(event);
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
    if (this.lifecycle) this.lifecycle.noteReviewStamp();
    return result.wrote;
  }

  runComposeCommand(result) {
    if (!result) return;
    if (result.kind === 'commit') this.commits.finishGitCommit();
    if (result.kind === 'branch') this.gitBranches.finishCreateBranch();
    if (result.kind === 'npm') this.npm.finishEdit();
  }

  selectTemplate(index) {
    this.runComposeCommand(this.composer.selectTemplate(index));
  }

  idleNoteText() {
    return this.composer.idleNoteText();
  }

  shownTemplates() {
    return this.composer.shownTemplates();
  }

  startDraftCompose() {
    this.composer.startDraftCompose();
  }

  tickBlink() {
    this.composer.tickBlink();
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
      this.term.startListening({
        onData,
        onResize: () => this.draw(),
      });
      this.term.startTimer('save', () => this.autosave(), AUTOSAVE_MS);
      this.term.startTimer('blink', () => this.tickBlink(), CURSOR_BLINK_MS);
      this.lifecycle.startWatch();
    });
  }
}

module.exports = {
  LEAVE_TERM,
  Session,
};
