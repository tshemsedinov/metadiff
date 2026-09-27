'use strict';

const compose = require('./compose.js');
const commit = require('./commit.js');
const { hasStagedChanges, listedCommits } = commit;
const { COMPOSE_LEAVE } = compose;
const actions = require('./actions.js');
const {
  LIST_PANES,
  CONFIRM_MODE,
  disabledActions,
  actionFromKey,
  applyConfirm,
} = actions;

const currentTarget = (ui) => {
  if (ui.pane === 'files') return ui.fileCursorEntry();
  if (ui.pane === 'branches') {
    return ui.branches[ui.branchCursor];
  }
  if (ui.pane === 'commits') {
    const entry = listedCommits(ui.commits.commits)[ui.commitCursor];
    const staged = hasStagedChanges(ui);
    if (!entry) return { canCommit: staged };
    return { ...entry, canCommit: staged };
  }
  return ui.current();
};

const createDispatcher = (ui) => {
  const handlers = {
    add: ui.changeActions.onAdd,
    unstage: ui.changeActions.onUnstage,
    revert: ui.changeActions.onRevert,
    next: ui.filesPane.onNext,
    prev: ui.filesPane.onPrev,
    layout: ui.filesPane.onLayout,
    theme: ui.filesPane.onTheme,
    files: ui.filesPane.onFiles,
    feedback: ui.composer.onFeedback,
    todo: ui.composer.onTodo,
    code: ui.composer.onCode,
    reload: ui.lifecycle.onReload,
    commit: ui.commits.onCommit,
    amend: ui.commits.onAmend,
    reword: ui.commits.onReword,
    apply: ui.commits.onApply,
    fixup: ui.commits.onFixup,
    view: () => ui.commits.onView(),
    branch: ui.gitBranches.onBranch,
    pull: ui.gitBranches.onPull,
    push: ui.gitBranches.onPush,
    newBranch: ui.gitBranches.onNewBranch,
    rebase: ui.gitBranches.onRebaseBranch,
    drop: () => {
      if (ui.pane === 'commits') {
        return void ui.commits.onDropCommit();
      }
      ui.gitBranches.onDropBranch();
    },
    open: ui.filesPane.onOpenFile,
    file: ui.filesPane.onFileScope,
    diff: ui.filesPane.onDiffScope,
    npm: ui.npm.open,
    npmEdit: ui.npm.edit,
    npmNew: ui.npm.create,
    npmStop: () => ui.npm.closeView(),
    npmRerun: () => ui.npm.rerun(),
    check: () => ui.composer.toggleFocusedTodo(),
    removeTodo: () => {
      if (ui.pane === 'npm') return void ui.npm.askDrop();
      ui.composer.removeFocusedTodo();
    },
    quit: () => ui.onQuit(),
    scrollUp: () => ui.filesPane.onScroll(-1),
    scrollDown: () => ui.filesPane.onScroll(1),
    pageUp: () => ui.filesPane.onScroll(ui.filesPane.scrollStep(-1)),
    pageDown: () => ui.filesPane.onScroll(ui.filesPane.scrollStep(1)),
    halfUp: () => ui.filesPane.onScroll(ui.filesPane.scrollStep(-0.5)),
    halfDown: () => ui.filesPane.onScroll(ui.filesPane.scrollStep(0.5)),
    home: ui.filesPane.onHome,
    end: ui.filesPane.onEnd,
  };

  const dispatch = (action) => {
    if (CONFIRM_MODE.includes(ui.mode)) return;
    if (ui.mode === 'compose') {
      if (!COMPOSE_LEAVE.includes(action)) return;
      const result = ui.composer.saveCompose();
      if (result && result.kind === 'error') return;
    }
    const pane = ui.pane;
    if (LIST_PANES.includes(pane) && (action === 'next' || action === 'prev')) {
      ui.filesPane.onScroll(action === 'next' ? 1 : -1);
      return;
    }
    const hidden = disabledActions(pane, currentTarget(ui));
    if (hidden.includes(action)) return;
    const handler = handlers[action];
    if (!handler) return;
    handler();
  };

  return { dispatch, handlers };
};

const createInput = (ui) => {
  const confirmations = {
    confirmQuit: {
      ready: () => ui.finishQuit('ready'),
      editing: () => ui.finishQuit('editing'),
      cancel: () => ui.cancelQuit(),
    },
    confirmUpdate: {
      accept: ui.updater.accept,
      decline: ui.updater.decline,
    },
    confirmDrop: {
      confirm: () => {
        if (ui.npm.dropName) return void ui.npm.confirmDrop();
        if (ui.commits.dropName) {
          return void ui.commits.confirmDropCommit();
        }
        ui.gitBranches.confirmDropBranch();
      },
      cancel: () => {
        if (ui.npm.dropName) return void ui.npm.cancelDrop();
        if (ui.commits.dropName) {
          return void ui.commits.cancelDropCommit();
        }
        ui.gitBranches.cancelDropBranch();
      },
    },
    confirmPush: {
      force: ui.gitBranches.onForcePush,
      cancel: ui.gitBranches.cancelPush,
    },
  };

  const confirmChoice = (key) => {
    const mode = ui.mode;
    if (!CONFIRM_MODE.includes(mode)) return;
    applyConfirm(mode, key, confirmations[mode]);
  };

  const handleKey = (key) => {
    const mode = ui.mode;
    if (CONFIRM_MODE.includes(mode)) return void confirmChoice(key);
    if (mode === 'compose') {
      if (key === 'ctrl-c') return void ui.onQuit();
      const command = ui.composer.handleKey(key);
      return void ui.runComposeCommand(command);
    }
    if (ui.pane === 'npm' && ui.npm.viewing) {
      if (key === 'escape') return void ui.npm.closeView();
      if (key === 'r') return void ui.npm.rerun();
      if (key === 'e' || key === 'n') return;
    }
    if (ui.pane === 'npm' && key === 'ctrl-up') return void ui.npm.reorder(-1);
    if (ui.pane === 'npm' && key === 'ctrl-down') {
      return void ui.npm.reorder(1);
    }
    if (ui.pane === 'npm' && (key === 'up' || key === 'down')) {
      return void ui.npm.move(key === 'up' ? -1 : 1);
    }
    if (key === 'escape') return void ui.filesPane.onEscape();
    const toggle = key === 'x' || key === ' ';
    if (toggle && ui.composer.toggleFocusedTodo()) return;
    if (ui.composer.typeIntoTodo(key)) return;
    const action = actionFromKey(key, ui.pane, ui.fileScope);
    if (action) ui.dispatch(action);
  };

  const handleEvent = (event) => {
    if (event.type === 'key') return void handleKey(event.key);
    if (event.type !== 'mouse') return;
    ui.pointer.handle(event);
  };

  return { handleEvent, confirmChoice };
};

module.exports = { createDispatcher, createInput };
