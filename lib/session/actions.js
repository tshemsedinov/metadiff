'use strict';

const LIST_PANES = ['files', 'branches', 'commits', 'npm'];

const ACTIONS = {
  add: ['a'],
  unstage: ['u'],
  revert: ['d'],
  ignore: ['i'],
  commit: ['c'],
  prev: ['left', 'p', 'k'],
  next: ['right', 'n', 'j'],
  check: ['x', ' '],
  layout: ['m'],
  feedback: ['f'],
  tasks: ['t'],
  code: ['e'],
  branch: ['b'],
  file: ['f'],
  diff: ['d'],
  quit: ['q', 'ctrl-c'],
};
const ACTION_IDS = Object.keys(ACTIONS);

const BRANCH_ACTIONS = {
  newBranch: ['n'],
  rebase: ['r'],
  drop: ['d'],
  pull: ['p'],
  push: ['s'],
};

const COMMIT_ACTIONS = {
  amend: ['a'],
  apply: ['a'],
  reword: ['r'],
  fixup: ['f'],
  drop: ['d'],
  view: ['v'],
  pull: ['p'],
  push: ['s'],
};

const NPM_ACTIONS = {
  npm: ['n'],
  npmEdit: ['e'],
  npmNew: ['n'],
  npmDrop: ['d'],
  npmLogs: ['c'],
  npmStop: ['escape'],
  npmVerbose: ['v'],
  npmRerun: ['r'],
};

const DASH_ACTIONS = {
  dashFiles: ['f'],
  dashDiffs: ['d'],
  dashCommits: ['c'],
  dashBranches: ['b'],
  dashNpm: ['n'],
  dashRun: ['r'],
  dashTasks: ['t'],
};
const DASH_IDS = Object.keys(DASH_ACTIONS);
const DASH_BLOCKS = {
  dashFiles: 'files',
  dashDiffs: 'diffs',
  dashCommits: 'commits',
  dashBranches: 'branches',
  dashNpm: 'npm',
  dashRun: 'run',
  dashTasks: 'tasks',
};
const DASH_ALLOWED = [...DASH_IDS, 'quit', 'theme'];
const DASH_HIDDEN = ACTION_IDS.filter((id) => id !== 'quit');

const ACTION_HOT = {
  prev: '←',
  next: '→',
  npmStop: 'esc',
};

const ACTION_LABEL = {
  ...DASH_BLOCKS,
  revert: 'drop',
  check: 'x',
  layout: 'mode',
  tasks: 'tasks',
  view: 'view',
  code: 'edit',
  newBranch: 'new',
  npmEdit: 'edit',
  npmNew: 'new',
  npmDrop: 'delete',
  npmLogs: 'cleanup',
  npmStop: 'esc',
  npmVerbose: 'verbose',
  npmRerun: 're-run',
  quit: 'q',
  prev: '←',
  next: '→',
};

const DIFF_DISABLED = [
  'check',
  'commit',
  'branch',
  'pull',
  'push',
  'file',
  'diff',
  'ignore',
];
const UNIT_DISABLED = [...DIFF_DISABLED, 'layout'];
const FILES_DISABLED = ['layout', 'feedback', 'code'];
const FILES_HIDDEN = [
  ...FILES_DISABLED,
  'check',
  'prev',
  'next',
  'commit',
  'file',
  'diff',
];
const FILES_GIT_DISABLED = ['add', 'unstage', 'revert', 'ignore'];
const FILES_TASKS_DISABLED = [...FILES_GIT_DISABLED, ...FILES_DISABLED];
const TASKS_DISABLED = [
  'add',
  'unstage',
  'revert',
  'ignore',
  'commit',
  'layout',
  'feedback',
  'tasks',
  'code',
  'branch',
  'file',
  'diff',
  'pull',
  'push',
];
const BRANCHES_DISABLED = [
  'add',
  'unstage',
  'revert',
  'ignore',
  'commit',
  'layout',
  'feedback',
  'tasks',
  'code',
  'check',
  'branch',
  'file',
  'diff',
  'prev',
  'next',
];
const COMMITS_DISABLED = BRANCHES_DISABLED.filter((id) => id !== 'commit');
const NPM_DISABLED = [...BRANCHES_DISABLED, 'pull', 'push'];

const isTasksTarget = (item) =>
  !!(item && (item.kind === 'tasks' || item.origin === 'task'));

const diffGitDisabled = (item) => {
  if (!item || isTasksTarget(item)) return [];
  if (item.origin === 'staged') return ['add'];
  return ['unstage'];
};

const BRANCH_REMOTE = ['pull', 'push'];

const branchGitDisabled = (item) => {
  const off = item && !item.current ? [] : ['rebase', 'drop'];
  if (!item || !item.current) return [...off, ...BRANCH_REMOTE];
  return off;
};

const isFixupCommit = (item) =>
  `${item && item.subject ? item.subject : ''}`.startsWith('fixup!');

const commitWriteDisabled = (item) => {
  const pending = Boolean(item && item.pending);
  const unstaged = Boolean(item && item.unstagedCurrent);
  if (!item || !item.sha) {
    const off = ['reword', 'fixup', 'drop'];
    if (pending) return off;
    return ['amend', 'apply', ...off];
  }
  if (unstaged) return [];
  if (isFixupCommit(item)) return ['amend'];
  return ['amend', 'apply'];
};

const commitGitDisabled = (item) => {
  const off = [...commitWriteDisabled(item)];
  if (!isFixupCommit(item)) off.push('apply');
  if (item && item.canCommit === true) return off;
  return [...off, 'commit', 'fixup'];
};

const disabledActions = (pane, item) => {
  const onTodos = isTasksTarget(item);
  if (pane === 'files') return onTodos ? FILES_TASKS_DISABLED : FILES_DISABLED;
  if (pane === 'unit') return [...UNIT_DISABLED, ...diffGitDisabled(item)];
  if (pane === 'branches') {
    return [...BRANCHES_DISABLED, ...branchGitDisabled(item)];
  }
  if (pane === 'commits') {
    return [...COMMITS_DISABLED, ...commitWriteDisabled(item)];
  }
  if (pane === 'npm') return NPM_DISABLED;
  if (onTodos) return TASKS_DISABLED;
  return [...DIFF_DISABLED, ...diffGitDisabled(item)];
};

const HIDDEN_KEYS = {
  l: 'theme',
};

const SCROLL = {
  up: 'scrollUp',
  down: 'scrollDown',
  'ctrl-y': 'scrollUp',
  'ctrl-e': 'scrollDown',
  'ctrl-b': 'pageUp',
  'ctrl-f': 'pageDown',
  'ctrl-u': 'halfUp',
  'ctrl-d': 'halfDown',
  pageUp: 'pageUp',
  pageDown: 'pageDown',
  home: 'home',
  end: 'end',
  enter: 'open',
  backspace: 'removeTask',
  delete: 'removeTask',
};

const keysForActions = (actions) => {
  const keys = {};
  for (const [id, shortcuts] of Object.entries(actions)) {
    for (const key of shortcuts) keys[key] = id;
  }
  return keys;
};

const PANE_ONLY = ['branch', 'file', 'diff'];
const FILES_KEYS = keysForActions({
  branch: ACTIONS.branch,
  pull: BRANCH_ACTIONS.pull,
  push: BRANCH_ACTIONS.push,
  npm: NPM_ACTIONS.npm,
});
const BRANCH_KEYS = keysForActions(BRANCH_ACTIONS);
const COMMIT_KEYS = keysForActions(COMMIT_ACTIONS);
const NPM_KEYS = {
  e: 'npmEdit',
  n: 'npmNew',
  d: 'npmDrop',
  c: 'npmLogs',
};
const DASH_KEYS = keysForActions(DASH_ACTIONS);
const PANE_KEYS = {
  dashboard: DASH_KEYS,
  files: FILES_KEYS,
  branches: BRANCH_KEYS,
  commits: COMMIT_KEYS,
  npm: NPM_KEYS,
};

const KEY_TO_ACTION = {
  ...keysForActions(
    Object.fromEntries(
      Object.entries(ACTIONS).filter(([id]) => !PANE_ONLY.includes(id)),
    ),
  ),
  ...SCROLL,
  ...HIDDEN_KEYS,
};

const actionFromKey = (key, pane, fileScope) => {
  if (LIST_PANES.includes(pane) && (key === 'left' || key === 'right')) {
    return null;
  }
  const paneKeys = PANE_KEYS[pane];
  if (paneKeys && paneKeys[key]) return paneKeys[key];
  if (pane === 'files') {
    if (key === 'f' && fileScope !== 'file') return 'file';
    if (key === 'd' && fileScope === 'file') return 'diff';
  }
  return KEY_TO_ACTION[key] ?? null;
};

const actionKeys = (id) =>
  ACTIONS[id] ??
  BRANCH_ACTIONS[id] ??
  COMMIT_ACTIONS[id] ??
  NPM_ACTIONS[id] ??
  DASH_ACTIONS[id] ??
  [];

const actionLetter = (id) => ACTION_HOT[id] ?? actionKeys(id)[0];

const buttonWord = (id) => {
  const word = ACTION_LABEL[id] ?? ACTION_HOT[id] ?? id;
  const mark = actionLetter(id);
  if (word.includes(mark)) return word;
  return `${mark}${word}`;
};

const YES_NO = [
  { letter: 'y', label: 'y', lead: ' ' },
  { letter: 'n', label: 'n', lead: '/' },
];

const CONFIRM = {
  confirmQuit: {
    choices: [
      { letter: 'f', label: 'finish as ready', lead: ' ' },
      { letter: 'c', label: 'continue next time', lead: '  ' },
    ],
    keys: {
      f: 'ready',
      c: 'editing',
      'ctrl-c': 'ready',
      escape: 'cancel',
    },
  },
  confirmUpdate: {
    choices: YES_NO,
    prefix: (view) => {
      const from = view.updateFrom ?? '';
      const to = view.updateTo ?? '';
      return ` update reslop ${from} → ${to}?`;
    },
    keys: {
      y: 'accept',
      n: 'decline',
      escape: 'decline',
    },
  },
  confirmDrop: {
    choices: YES_NO,
    prefix: (view) => ` drop ${view.dropName ?? ''}?`,
    keys: {
      y: 'confirm',
      n: 'cancel',
      escape: 'cancel',
    },
  },
  confirmPush: {
    choices: [{ letter: 'f', label: 'force push', lead: ' ' }],
    prefix: ' Need force-push?',
    keys: {
      f: 'force',
      escape: 'cancel',
    },
  },
};

const CONFIRM_MODE = Object.keys(CONFIRM);

const confirmKey = (mode, key) => {
  const spec = CONFIRM[mode];
  if (!spec) return null;
  const norm = key.length === 1 ? key.toLowerCase() : key;
  return spec.keys[norm] ?? null;
};

const confirmPrefix = (spec, view) => {
  if (typeof spec.prefix === 'function') return spec.prefix(view);
  return spec.prefix ?? '';
};

const promptFromChoices = (choices) =>
  choices.map((choice) => `${choice.lead}${choice.label}`).join('');

module.exports = {
  LIST_PANES,
  DASH_IDS,
  DASH_BLOCKS,
  DASH_ALLOWED,
  DASH_HIDDEN,
  ACTIONS,
  ACTION_IDS,
  BRANCH_ACTIONS,
  COMMIT_ACTIONS,
  DIFF_DISABLED,
  UNIT_DISABLED,
  FILES_DISABLED,
  FILES_HIDDEN,
  FILES_GIT_DISABLED,
  FILES_TASKS_DISABLED,
  TASKS_DISABLED,
  BRANCHES_DISABLED,
  COMMITS_DISABLED,
  NPM_DISABLED,
  disabledActions,
  diffGitDisabled,
  branchGitDisabled,
  commitGitDisabled,
  isFixupCommit,
  actionFromKey,
  actionLetter,
  buttonWord,
  CONFIRM,
  CONFIRM_MODE,
  confirmKey,
  confirmPrefix,
  promptFromChoices,
};
