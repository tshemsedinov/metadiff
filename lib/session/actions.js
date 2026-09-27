'use strict';

const LIST_PANES = ['files', 'branches', 'commits', 'npm'];

const ACTIONS = {
  add: ['a'],
  unstage: ['u'],
  revert: ['d'],
  commit: ['c'],
  prev: ['left', 'p', 'k'],
  next: ['right', 'n', 'j'],
  check: ['x', ' '],
  layout: ['m'],
  feedback: ['f'],
  todo: ['t'],
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
  npmStop: ['escape'],
  npmRerun: ['r'],
};

const ACTION_HOT = {
  prev: '←',
  next: '→',
  npmStop: 'esc',
};

const ACTION_LABEL = {
  revert: 'drop',
  check: 'x',
  layout: 'mode',
  view: 'view',
  code: 'edit',
  newBranch: 'new',
  npmEdit: 'edit',
  npmNew: 'new',
  npmStop: 'esc',
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
const FILES_GIT_DISABLED = ['add', 'unstage', 'revert'];
const FILES_TODO_DISABLED = [...FILES_GIT_DISABLED, ...FILES_DISABLED];
const TODO_DISABLED = [
  'add',
  'unstage',
  'revert',
  'commit',
  'layout',
  'feedback',
  'todo',
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
  'commit',
  'layout',
  'feedback',
  'todo',
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

const isTodosTarget = (item) =>
  !!(item && (item.kind === 'todos' || item.origin === 'todo'));

const diffGitDisabled = (item) => {
  if (!item || isTodosTarget(item)) return [];
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
  if (!item || !item.sha) return ['amend', 'apply', 'reword', 'fixup', 'drop'];
  return [];
};

const commitGitDisabled = (item) => {
  const off = [...commitWriteDisabled(item)];
  if (!isFixupCommit(item)) off.push('apply');
  if (item && item.canCommit === true) return off;
  return [...off, 'commit', 'fixup'];
};

const disabledActions = (pane, item) => {
  const onTodos = isTodosTarget(item);
  if (pane === 'files') return onTodos ? FILES_TODO_DISABLED : FILES_DISABLED;
  if (pane === 'unit') return [...UNIT_DISABLED, ...diffGitDisabled(item)];
  if (pane === 'branches') {
    return [...BRANCHES_DISABLED, ...branchGitDisabled(item)];
  }
  if (pane === 'commits') {
    return [...COMMITS_DISABLED, ...commitWriteDisabled(item)];
  }
  if (pane === 'npm') return NPM_DISABLED;
  if (onTodos) return TODO_DISABLED;
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
  backspace: 'removeTodo',
  delete: 'removeTodo',
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
};
const PANE_KEYS = {
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
  [];

const actionHot = (id) => ACTION_HOT[id] ?? actionKeys(id)[0];

const actionLetter = actionHot;

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

const applyConfirm = (mode, key, handlers) => {
  const action = confirmKey(mode, key);
  if (!action) return;
  const handler = handlers[action];
  if (handler) handler();
};

const confirmPrefix = (spec, view) => {
  if (typeof spec.prefix === 'function') return spec.prefix(view);
  return spec.prefix ?? '';
};

const promptFromChoices = (choices) =>
  choices.map((choice) => `${choice.lead}${choice.label}`).join('');

module.exports = {
  LIST_PANES,
  ACTIONS,
  ACTION_IDS,
  BRANCH_ACTIONS,
  COMMIT_ACTIONS,
  NPM_ACTIONS,
  ACTION_HOT,
  ACTION_LABEL,
  DIFF_DISABLED,
  UNIT_DISABLED,
  FILES_DISABLED,
  FILES_HIDDEN,
  FILES_GIT_DISABLED,
  FILES_TODO_DISABLED,
  TODO_DISABLED,
  BRANCHES_DISABLED,
  COMMITS_DISABLED,
  NPM_DISABLED,
  SCROLL,
  PANE_ONLY,
  disabledActions,
  diffGitDisabled,
  branchGitDisabled,
  commitGitDisabled,
  isFixupCommit,
  actionFromKey,
  actionKeys,
  actionHot,
  actionLetter,
  buttonWord,
  CONFIRM,
  CONFIRM_MODE,
  confirmKey,
  applyConfirm,
  confirmPrefix,
  promptFromChoices,
};
