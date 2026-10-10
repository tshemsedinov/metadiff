'use strict';

const { THEME_NAMES, setTheme, themeName } = require('../ansi.js');
const { isTasksEntry, TASKS_FILE } = require('../files.js');
const { logViewRows } = require('../render/npm.js');
const { setFileScope, openUnitFile, moveUnitBlock } = require('./unit.js');
const { LIST_PANES } = require('./actions.js');
const { saveUiPrefs, LAYOUT_LABEL } = require('./agent-jobs.js');

const LAYOUTS = ['unified', 'mixed', 'side'];

const fileCursorEntry = (ui) => ui.fileList()[ui.nav.fileCursor] ?? null;

const clampIndex = (ui) => ui.nav.clampIndex(ui.items.length);

const syncReviewPath = (ui) => ui.nav.syncReviewPath(ui.current());

const clampFileCursor = (ui) => ui.nav.clampFileCursor(ui.fileList().length);

const followReviewPath = (ui) =>
  ui.nav.followReviewPath(ui.fileList(), ui.current());

const syncFileCursor = (ui) => {
  if (ui.nav.pane === 'files') return void clampFileCursor(ui);
  followReviewPath(ui);
};

const showFiles = (ui) => {
  const nav = ui.nav;
  const held =
    nav.tasksOpen === true ||
    nav.pane === 'branches' ||
    nav.pane === 'commits' ||
    nav.pane === 'npm' ||
    nav.pane === 'packages' ||
    nav.pane === 'agents';
  nav.pane = 'files';
  nav.resetListScroll('files');
  nav.clearSelection();
  followReviewPath(ui);
  nav.tasksOpen = false;
  if (held) ui.lifecycle.catchUpWatch();
};

const viewingCommit = (ui) => !ui.change && Boolean(ui.rev || ui.revShort);

const releaseCommit = (ui) => {
  if (!viewingCommit(ui)) return;
  ui.rev = '';
  ui.revShort = '';
  ui.refreshFromRepo({ keepEmpty: true });
};

const showDashboard = (ui) => {
  const nav = ui.nav;
  const held = nav.pane !== 'dashboard';
  nav.pane = 'dashboard';
  nav.tasksOpen = false;
  nav.scroll = 0;
  nav.clearSelection();
  ui.status = '';
  releaseCommit(ui);
  if (held) ui.lifecycle.catchUpWatch();
  ui.dashboard.enter();
};

const HOME_CHILDREN = [
  'files',
  'branches',
  'commits',
  'npm',
  'packages',
  'agents',
];

const returnsHome = (ui) => {
  if (!ui.dashboardHome) return false;
  const { pane, tasksOpen } = ui.nav;
  return HOME_CHILDREN.includes(pane) || tasksOpen === true;
};

const onEscape = (ui) => {
  if (ui.nav.pane === 'agents' && ui.agents.pick) {
    return void ui.agents.closePick();
  }
  if (ui.nav.pane === 'agents' && ui.agents.viewing) {
    return void ui.agents.closeView();
  }
  if (ui.nav.pane === 'repos') return void ui.onQuit();
  if (ui.nav.pane === 'dashboard' && ui.workspaceRoot) {
    return void ui.workspace.show();
  }
  if (ui.nav.pane === 'dashboard') return void ui.onQuit();
  const commitDiff = ui.nav.pane === 'diff' && viewingCommit(ui);
  if (returnsHome(ui) || (ui.dashboardHome && commitDiff)) {
    return void showDashboard(ui);
  }
  if (ui.nav.pane === 'files') return void ui.onQuit();
  showFiles(ui);
};

const onFiles = (ui) => {
  if (ui.nav.pane === 'files') {
    if (!ui.nav.reviewPath) return;
    if (ui.nav.fileScope === 'file') {
      const list = ui.fileList();
      const entry = list[ui.nav.fileCursor];
      if (entry && !isTasksEntry(entry)) openUnitFile(ui, entry);
      return;
    }
    ui.nav.pane = 'diff';
    ui.nav.clearSelection();
    return;
  }
  showFiles(ui);
};

const onOpenFile = (ui) => {
  if (ui.nav.pane === 'packages') return;
  if (ui.nav.pane === 'branches') {
    return void ui.gitBranches.onCheckoutBranch();
  }
  if (ui.nav.pane === 'commits') return void ui.commits.onShowDiff();
  if (ui.nav.pane === 'npm') return void ui.npm.run();
  if (ui.nav.pane === 'agents') return void ui.agents.start();
  if (ui.nav.pane !== 'files') {
    if (ui.nav.tasksOpen) ui.composer.tasks.editFocusedTask();
    return;
  }
  const list = ui.fileList();
  const entry = list[ui.nav.fileCursor];
  if (!entry) return;
  if (isTasksEntry(entry)) {
    ui.composer.tasks.openTasksPage();
    ui.status = '';
    return;
  }
  ui.nav.tasksOpen = false;
  ui.nav.index = entry.openIndex ?? entry.firstIndex;
  if (ui.nav.fileScope === 'file') {
    return void openUnitFile(ui, entry);
  }
  ui.nav.pane = 'diff';
  ui.nav.scroll = 0;
  ui.status = '';
  ui.nav.clearSelection();
  syncReviewPath(ui);
};

const onFileMove = (ui, delta) => {
  const list = ui.fileList();
  if (!list.length) {
    ui.status = 'nothing to review';
    return;
  }
  const last = list.length - 1;
  const moved = ui.nav.fileCursor + delta;
  const next = Math.min(last, Math.max(0, moved));
  if (next === ui.nav.fileCursor) return;
  ui.nav.fileCursor = next;
  const entry = list[next];
  if (isTasksEntry(entry)) {
    ui.nav.reviewPath = TASKS_FILE;
  } else {
    ui.nav.reviewPath = entry.path;
    ui.nav.index = entry.firstIndex;
  }
  ui.status = '';
};

const moveRemaining = (ui, step) => {
  const list = ui.items;
  if (!list.length) {
    ui.status = 'nothing to review';
    return;
  }
  const next = ui.nav.index + step;
  if (next < 0 || next >= list.length) return;
  ui.nav.index = next;
  ui.nav.scroll = 0;
  ui.status = '';
  ui.nav.clearSelection();
  syncReviewPath(ui);
};

const onNext = (ui) => {
  if (ui.nav.pane === 'unit') return void moveUnitBlock(ui, 1);
  if (ui.nav.pane === 'tasks') return void ui.composer.tasks.moveTaskFocus(1);
  moveRemaining(ui, 1);
};

const onPrev = (ui) => {
  if (ui.nav.pane === 'unit') return void moveUnitBlock(ui, -1);
  if (ui.nav.pane === 'tasks') return void ui.composer.tasks.moveTaskFocus(-1);
  moveRemaining(ui, -1);
};

const scrollStep = (ui, fraction) => {
  const frame = ui.lastFrame;
  const size = ui.lastSize ?? ui.getSize();
  const rows = size.height ?? 24;
  const fallback = Math.max(1, rows - 4);
  const bodyH = frame?.bodyH ?? fallback;
  const viewing = ui.nav.pane === 'npm' && ui.npm.viewing;
  const agentLog = ui.nav.pane === 'agents' && ui.agents.viewing;
  const viewRows = viewing || agentLog ? logViewRows(bodyH) : bodyH;
  const height = Math.max(1, viewRows);
  const span = Math.floor(height * Math.abs(fraction));
  const n = Math.max(1, span);
  if (fraction < 0) return -n;
  return n;
};

const onScroll = (ui, delta) => {
  if (ui.nav.planOpen && ui.nav.pane === 'tasks') {
    const step = delta < 0 ? -1 : 1;
    return void ui.composer.tasks.movePlan(step);
  }
  if (ui.nav.pane === 'dashboard') return;
  if (ui.nav.pane === 'files') return void onFileMove(ui, delta);
  if (ui.nav.pane === 'branches') {
    return void ui.gitBranches.onBranchMove(delta);
  }
  if (ui.nav.pane === 'commits') {
    return void ui.commits.onCommitMove(delta);
  }
  if (ui.nav.pane === 'npm') return void ui.npm.move(delta);
  if (ui.nav.pane === 'agents') return void ui.agents.move(delta);
  if (ui.nav.pane === 'packages') {
    const count = ui.dashboard.packageCount();
    const nav = ui.nav;
    const next = nav.packagesCursor + delta;
    const last = Math.max(0, count - 1);
    nav.packagesCursor = Math.max(0, Math.min(last, next));
    ui.status = '';
    return;
  }
  if (ui.nav.tasksOpen && ui.composer.tasks.taskRowCount() > 1) {
    return void ui.composer.tasks.moveTaskFocus(delta);
  }
  const frame = ui.lastFrame;
  const max = frame ? frame.scrollMax : null;
  const scroll = ui.nav.scroll;
  const current = max === null ? scroll : Math.min(scroll, max);
  const moved = current + delta;
  const next = max === null ? moved : Math.min(max, moved);
  ui.nav.scroll = Math.max(0, next);
  ui.nav.clearSelection();
};

const onJump = (ui, toEnd) => {
  if (ui.nav.pane === 'dashboard') return;
  if (LIST_PANES.includes(ui.nav.pane)) {
    const delta = toEnd ? Number.MAX_SAFE_INTEGER : -Number.MAX_SAFE_INTEGER;
    return void onScroll(ui, delta);
  }
  if (ui.nav.tasksOpen && ui.composer.tasks.taskRowCount() > 0) {
    const last = ui.composer.tasks.taskRowCount() - 1;
    const target = toEnd ? last : 0;
    const at = ui.composer.tasks.clampedTaskFocus();
    return void ui.composer.tasks.moveTaskFocus(target - at);
  }
  const frame = ui.lastFrame;
  const max = frame ? frame.scrollMax : 0;
  ui.nav.scroll = toEnd ? max : 0;
  ui.nav.clearSelection();
};

const onLayout = (ui) => {
  const i = LAYOUTS.indexOf(ui.layout);
  const next = (i < 0 ? 0 : i + 1) % LAYOUTS.length;
  ui.layout = LAYOUTS[next];
  ui.status = LAYOUT_LABEL[ui.layout] || ui.layout;
  ui.nav.scroll = 0;
  ui.nav.clearSelection();
  saveUiPrefs(ui.top || ui.cwd, { layout: ui.layout });
};

const saveLineNumbers = (ui) => {
  const shown = ui.lineNumbers === true;
  saveUiPrefs(ui.top || ui.cwd, { lineNumbers: shown });
};

const onLineNumbers = (ui) => {
  ui.lineNumbers = ui.lineNumbers !== true;
  ui.status = ui.lineNumbers ? 'line numbers' : 'no line numbers';
  saveLineNumbers(ui);
  ui.composer.syncCodeScroll();
};

const onTheme = (ui) => {
  const i = THEME_NAMES.indexOf(themeName());
  const next = THEME_NAMES[(i + 1) % THEME_NAMES.length];
  setTheme(next);
  ui.status = next;
  saveUiPrefs(ui.top || ui.cwd, { theme: next });
};

const onHome = (ui) => onJump(ui, false);
const onEnd = (ui) => onJump(ui, true);
const onFileScope = (ui) => setFileScope(ui, 'file');
const onDiffScope = (ui) => setFileScope(ui, 'diff');

module.exports = {
  fileCursorEntry,
  clampIndex,
  syncReviewPath,
  syncFileCursor,
  showFiles,
  onEscape,
  onFiles,
  onOpenFile,
  onNext,
  onPrev,
  scrollStep,
  onScroll,
  onHome,
  onEnd,
  onLayout,
  onLineNumbers,
  onTheme,
  onFileScope,
  onDiffScope,
};
