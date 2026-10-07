'use strict';

const { COMPOSE_LEAVE } = require('./compose.js');
const { hasStagedChanges, listedCommits } = require('./commit.js');
const actions = require('./actions.js');
const { LIST_PANES, DASH_BLOCKS, DASH_ALLOWED, CONFIRM_MODE } = actions;
const { REPOS_ALLOWED } = actions;
const { disabledActions, actionFromKey, confirmKey, lineHasDiff } = actions;
const { onCommand } = require('./change-actions.js');
const filesPane = require('./files-pane.js');
const { handlePointer } = require('./pointer.js');
const { FIND_PANES, startFind, onFindKey } = require('./find.js');

const currentTarget = (ui) => {
  if (ui.pane === 'files') return ui.fileCursorEntry();
  if (ui.pane === 'branches') return ui.branches[ui.branchCursor];
  if (ui.pane === 'commits') {
    const entry = listedCommits(ui.commits.commits)[ui.commitCursor];
    const canCommit = hasStagedChanges(ui);
    const unstagedCurrent = !ui.rev && !ui.revShort;
    return { ...entry, canCommit, unstagedCurrent };
  }
  if (ui.pane !== 'unit') return ui.current();
  const item = ui.current();
  const lines = ui.view().unitLines ?? [];
  if (!lines.length) return item;
  const line = lines[ui.nav.unitLine] ?? null;
  const lineDiff = lineHasDiff(line);
  if (!item) return { lineDiff };
  return { ...item, lineDiff };
};

const scrollBy = (fraction) => (ui) =>
  filesPane.onScroll(ui, filesPane.scrollStep(ui, fraction));

const DASH_HANDLERS = Object.fromEntries(
  Object.entries(DASH_BLOCKS).map(([id, block]) => [
    id,
    (ui) => ui.dashboard.open(block),
  ]),
);

const HANDLERS = {
  add: (ui) => onCommand(ui, 'add'),
  unstage: (ui) => onCommand(ui, 'unstage'),
  revert: (ui) => onCommand(ui, 'revert'),
  ignore: (ui) => onCommand(ui, 'ignore'),
  next: filesPane.onNext,
  prev: filesPane.onPrev,
  layout: filesPane.onLayout,
  theme: filesPane.onTheme,
  files: filesPane.onFiles,
  open: (ui) => {
    if (ui.pane === 'repos') return void ui.workspace.openSelected();
    filesPane.onOpenFile(ui);
  },
  file: filesPane.onFileScope,
  diff: filesPane.onDiffScope,
  back: filesPane.onEscape,
  home: filesPane.onHome,
  end: filesPane.onEnd,
  scrollUp: (ui) => filesPane.onScroll(ui, -1),
  scrollDown: (ui) => filesPane.onScroll(ui, 1),
  pageUp: scrollBy(-1),
  pageDown: scrollBy(1),
  halfUp: scrollBy(-0.5),
  halfDown: scrollBy(0.5),
  feedback: (ui) => ui.composer.onFeedback(),
  code: (ui) => ui.composer.onCode(),
  tasks: (ui) => ui.composer.tasks.onTasks(),
  check: (ui) => ui.composer.tasks.toggleFocusedTask(),
  removeTask: (ui) => {
    if (ui.pane === 'npm') return void ui.npm.askDrop();
    if (ui.pane === 'packages') return;
    ui.composer.tasks.removeFocusedTask();
  },
  reload: (ui) => ui.lifecycle.onReload(),
  commit: (ui) => ui.commits.onCommit(),
  newCommit: (ui) => ui.commits.onInsert(),
  amend: (ui) => ui.commits.onAmend(),
  reword: (ui) => ui.commits.onReword(),
  apply: (ui) => ui.commits.onApply(),
  fixup: (ui) => ui.commits.onFixup(),
  view: (ui) => ui.commits.onView(),
  branch: (ui) => ui.gitBranches.onBranch(),
  pull: (ui) => ui.gitBranches.onPull(),
  push: (ui) => ui.gitBranches.onPush(),
  newBranch: (ui) => ui.gitBranches.onNewBranch(),
  rebase: (ui) => ui.gitBranches.onRebaseBranch(),
  drop: (ui) => {
    if (ui.pane === 'commits') return void ui.commits.onDropCommit();
    if (ui.pane === 'tasks') return void ui.composer.tasks.removeFocusedTask();
    ui.gitBranches.onDropBranch();
  },
  npm: (ui) => ui.npm.open(),
  npmEdit: (ui) => ui.npm.edit(),
  npmNew: (ui) => ui.npm.create(),
  npmDrop: (ui) => ui.npm.askDrop(),
  packageNew: (ui) => ui.packages.create(),
  packageDrop: (ui) => ui.packages.askDrop(),
  packageWanted: (ui) => ui.packages.updateWanted(),
  packageLatest: (ui) => ui.packages.updateLatest(),
  npmLogs: (ui) => ui.npm.askLogs(),
  npmStop: (ui) => ui.npm.closeView(),
  npmVerbose: (ui) => ui.npm.toggleVerbose(),
  npmRerun: (ui) => ui.npm.rerun(),
  agentModel: (ui) => ui.agents.openPick('model'),
  agentEffort: (ui) => ui.agents.openPick('effort'),
  agentFast: (ui) => ui.agents.toggleFast(),
  agentContext: (ui) => ui.agents.openPick('context'),
  agentReview: (ui) => ui.agents.openPick('plan'),
  agentLogin: (ui) => ui.agents.login(),
  agentStop: (ui) => ui.agents.stop(),
  quit: (ui) => ui.onQuit(),
  repoLeft: (ui) => ui.workspace.move(-1, 0),
  repoRight: (ui) => ui.workspace.move(1, 0),
  repoUp: (ui) => ui.workspace.move(0, -1),
  repoDown: (ui) => ui.workspace.move(0, 1),
  ...DASH_HANDLERS,
};

const dispatchAction = (ui, action) => {
  if (CONFIRM_MODE.includes(ui.mode)) return;
  if (ui.mode === 'compose') {
    if (!COMPOSE_LEAVE.includes(action)) return;
    const result = ui.composer.saveCompose();
    if (result && result.kind === 'error') return;
  }
  const pane = ui.pane;
  if (pane === 'repos' && !REPOS_ALLOWED.includes(action)) return;
  if (pane === 'dashboard' && !DASH_ALLOWED.includes(action)) return;
  if (LIST_PANES.includes(pane) && (action === 'next' || action === 'prev')) {
    return void filesPane.onScroll(ui, action === 'next' ? 1 : -1);
  }
  if (disabledActions(pane, currentTarget(ui)).includes(action)) return;
  const handler = HANDLERS[action];
  if (handler) handler(ui);
};

const CONFIRMATIONS = {
  confirmQuit: {
    ready: (ui) => ui.finishQuit('ready'),
    editing: (ui) => ui.finishQuit('editing'),
    cancel: (ui) => ui.cancelQuit(),
  },
  confirmUpdate: {
    accept: (ui) => ui.updater.accept(),
    decline: (ui) => ui.updater.decline(),
  },
  confirmDrop: {
    confirm: (ui) => {
      if (ui.packages.dropName) return void ui.packages.confirmDrop();
      if (ui.npm.dropName) return void ui.npm.confirmDrop();
      if (ui.commits.dropName) return void ui.commits.confirmDropCommit();
      ui.gitBranches.confirmDropBranch();
    },
    cancel: (ui) => {
      if (ui.packages.dropName) return void ui.packages.cancelDrop();
      if (ui.npm.dropName) return void ui.npm.cancelDrop();
      if (ui.commits.dropName) return void ui.commits.cancelDropCommit();
      ui.gitBranches.cancelDropBranch();
    },
  },
  confirmPush: {
    force: (ui) => ui.gitBranches.onForcePush(),
    cancel: (ui) => ui.gitBranches.cancelPush(),
  },
  confirmCommit: {
    commit: (ui) => ui.commits.chooseCommit('commit'),
    amend: (ui) => ui.commits.chooseCommit('amend'),
    fixup: (ui) => ui.commits.chooseCommit('fixup'),
    cancel: (ui) => ui.commits.cancelCommitChoice(),
  },
};

const confirmChoice = (ui, key) => {
  const handlers = CONFIRMATIONS[ui.mode];
  const action = handlers ? confirmKey(ui.mode, key) : null;
  if (action && handlers[action]) handlers[action](ui);
};

const NPM_VIEW_KEYS = {
  escape: (ui) => ui.npm.closeView(),
  r: (ui) => ui.npm.rerun(),
  v: (ui) => ui.npm.toggleVerbose(),
  e: () => {},
  i: () => {},
};

const NPM_LIST_KEYS = {
  'ctrl-up': (ui) => ui.npm.reorder(-1),
  'ctrl-down': (ui) => ui.npm.reorder(1),
  up: (ui) => ui.npm.move(-1),
  down: (ui) => ui.npm.move(1),
};

const AGENT_VIEW_KEYS = {
  escape: (ui) => ui.agents.closeView(),
  s: (ui) => ui.agents.stop(),
  l: (ui) => ui.agents.login(),
  e: () => {},
  m: () => {},
  a: () => {},
  o: () => {},
  f: () => {},
};

const AGENT_LIST_KEYS = {
  right: (ui) => ui.agents.focusRuns(),
  left: (ui) => ui.agents.focusCli(),
  tab: (ui) => ui.agents.toggleFocus(),
  'shift-tab': (ui) => ui.agents.toggleFocus(),
};

const npmKey = (ui, key) => {
  if (ui.pane !== 'npm') return null;
  if (ui.npm.viewing && Object.hasOwn(NPM_VIEW_KEYS, key)) {
    return NPM_VIEW_KEYS[key];
  }
  return Object.hasOwn(NPM_LIST_KEYS, key) ? NPM_LIST_KEYS[key] : null;
};

const agentKey = (ui, key) => {
  if (ui.pane !== 'agents') return null;
  if (ui.agents.pick) {
    if (key === 'ctrl-c') return null;
    return () => ui.agents.onPickKey(key);
  }
  const keys = ui.agents.viewing ? AGENT_VIEW_KEYS : AGENT_LIST_KEYS;
  return Object.hasOwn(keys, key) ? keys[key] : null;
};

const handleKey = (ui, key) => {
  if (CONFIRM_MODE.includes(ui.mode)) return void confirmChoice(ui, key);
  if (ui.mode === 'compose') {
    return void ui.runComposeCommand(ui.composer.handleKey(key));
  }
  if (ui.mode === 'find') return void onFindKey(ui, key);
  if (key === '/' && FIND_PANES.includes(ui.pane)) return void startFind(ui);
  const onNpmKey = npmKey(ui, key);
  if (onNpmKey) return void onNpmKey(ui);
  const onAgentKey = agentKey(ui, key);
  if (onAgentKey) return void onAgentKey(ui);
  if (key === 'escape') return void filesPane.onEscape(ui);
  const tasks = ui.composer.tasks;
  const toggle = key === ' ';
  if (toggle && tasks.toggleFocusedTask()) return;
  if (tasks.typeIntoTask(key)) return;
  const action = actionFromKey(key, ui.pane, ui.fileScope);
  if (action) ui.dispatch(action);
};

const handleEvent = (ui, event) => {
  if (event.type === 'key') return void handleKey(ui, event.key);
  if (event.type === 'mouse') handlePointer(ui, event);
};

module.exports = { dispatchAction, confirmChoice, handleEvent };
