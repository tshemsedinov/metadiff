'use strict';

const LIST_PANES = [
  'files',
  'branches',
  'commits',
  'npm',
  'packages',
  'agents',
];

const ACTIONS = {
  add: ['a'],
  unstage: ['u'],
  revert: ['d'],
  ignore: ['i'],
  commit: ['c'],
  prev: ['left', 'p', 'k'],
  next: ['right', 'n', 'j'],
  check: [' '],
  layout: ['m'],
  feedback: [],
  tasks: ['t'],
  code: ['e'],
  branch: ['b'],
  file: ['f'],
  diff: ['d'],
  quit: ['ctrl-c'],
};
const ACTION_IDS = Object.keys(ACTIONS);

const BRANCH_ACTIONS = {
  newBranch: ['insert'],
  rebase: ['e'],
  drop: ['delete'],
  pull: ['p'],
  push: ['s'],
};

const COMMIT_ACTIONS = {
  newCommit: ['insert'],
  apply: ['p'],
  reword: ['e'],
  drop: ['delete'],
  view: ['v'],
};

const PACKAGE_ACTIONS = {
  packageNew: ['insert'],
  packageDrop: ['delete'],
  packageWanted: ['w'],
  packageLatest: ['l'],
};

const NPM_ACTIONS = {
  npm: ['n'],
  npmEdit: ['e'],
  npmNew: ['insert'],
  npmDrop: ['delete'],
  npmLogs: ['l'],
  npmStop: ['escape'],
  npmVerbose: ['v'],
  npmRerun: ['r'],
};

const AGENT_ACTIONS = {
  agentModel: ['m'],
  agentEffort: ['e'],
  agentFast: ['a'],
  agentContext: ['t'],
  agentReview: ['p'],
  agentStop: ['s'],
  agentRerun: ['r'],
};

const AGENT_LIST_ACTIONS = {
  agentModel: AGENT_ACTIONS.agentModel,
  agentEffort: AGENT_ACTIONS.agentEffort,
  agentFast: AGENT_ACTIONS.agentFast,
  agentContext: AGENT_ACTIONS.agentContext,
  agentReview: AGENT_ACTIONS.agentReview,
};

const DASH_ACTIONS = {
  dashFiles: ['f'],
  dashDiffs: ['d'],
  dashTasks: ['t'],
  dashBranches: ['b'],
  dashCommits: ['c'],
  dashRun: ['r'],
  dashNpm: ['n'],
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
  dashAgents: 'agents',
};
const DASH_ALLOWED = [
  ...DASH_IDS,
  'dashAgents',
  'pull',
  'push',
  'quit',
  'theme',
];
const REPOS_ALLOWED = [
  'repoLeft',
  'repoRight',
  'repoUp',
  'repoDown',
  'open',
  'quit',
  'theme',
];
const DASH_HIDDEN = ACTION_IDS.filter((id) => id !== 'quit');

const ACTION_HOT = {
  prev: '←',
  next: '→',
  drop: 'del',
  newBranch: 'ins',
  newCommit: 'ins',
  feedback: 'q',
  check: 'space',
  theme: 'l',
  npmNew: 'ins',
  npmDrop: 'del',
  npmStop: 'esc',
  packageNew: 'ins',
  packageDrop: 'del',
};

const ACTION_LABEL = {
  ...DASH_BLOCKS,
  revert: 'drop',
  check: 'space',
  theme: 'light',
  layout: 'mode',
  tasks: 'tasks',
  view: 'view',
  code: 'edit',
  reword: 'edit',
  drop: 'delete',
  newBranch: 'insert',
  newCommit: 'insert',
  feedback: 'quote',
  npmEdit: 'edit',
  npmNew: 'insert',
  npmDrop: 'delete',
  npmLogs: 'cleanup',
  packageNew: 'insert',
  packageDrop: 'delete',
  packageWanted: 'wanted',
  packageLatest: 'latest',
  npmStop: 'esc',
  npmVerbose: 'verbose',
  npmRerun: 're-run',
  agentModel: 'model',
  agentEffort: 'effort',
  agentFast: 'fast',
  agentContext: 'context',
  agentReview: 'plan',
  agentStop: 'stop',
  agentRerun: 're-run',
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
const UNIT_DISABLED = [...DIFF_DISABLED, 'layout', 'ignore'];
const FILES_DISABLED = ['layout', 'feedback'];
const FILES_HIDDEN = [
  ...FILES_DISABLED,
  'check',
  'prev',
  'next',
  'commit',
  'file',
  'diff',
  'tasks',
  'branch',
];
const FILES_GIT_DISABLED = ['add', 'unstage', 'revert', 'ignore'];
const FILES_TASKS_DISABLED = [...FILES_GIT_DISABLED, ...FILES_DISABLED, 'code'];
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
const AGENTS_DISABLED = NPM_DISABLED;

const isTasksTarget = (item) =>
  !!(item && (item.kind === 'tasks' || item.origin === 'task'));

const DIFF_MOVE_IDS = ['add', 'unstage', 'revert'];

const entryHasDiff = (entry) => {
  if (!entry || entry.kind === 'tasks') return false;
  const keys = [
    'added',
    'removed',
    'stagedAdded',
    'stagedRemoved',
    'unstagedAdded',
    'unstagedRemoved',
    'remaining',
  ];
  let total = 0;
  for (const key of keys) total += entry[key] ?? 0;
  return total > 0;
};

const lineHasDiff = (line) =>
  !!line && (line.type === 'add' || line.type === 'del');

const withoutMoves = (off, hasDiff) => {
  if (hasDiff) return off;
  const next = off.slice();
  for (const id of DIFF_MOVE_IDS) {
    if (!next.includes(id)) next.push(id);
  }
  return next;
};

const diffGitDisabled = (item) => {
  if (!item || isTasksTarget(item)) return [];
  if (item.origin === 'staged') return ['add'];
  return ['unstage'];
};

const branchGitDisabled = (item) =>
  item && !item.current ? [] : ['rebase', 'drop'];

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

const commitChord = (item) => {
  if (!item || item.pending || !item.sha) return 'commit';
  if (item.head) return 'amend';
  return 'fixup';
};

const commitGitDisabled = (item) => {
  const off = [...commitWriteDisabled(item)];
  if (!isFixupCommit(item)) off.push('apply');
  const chord = commitChord(item);
  const ready = item && item.canCommit === true;
  if (chord === 'amend') return off;
  if (!ready) off.push('commit');
  return off;
};

const disabledActions = (pane, item) => {
  const onTodos = isTasksTarget(item);
  if (pane === 'dashboard' || pane === 'repos') return [];
  if (pane === 'files') {
    const base = onTodos ? FILES_TASKS_DISABLED : FILES_DISABLED;
    if (onTodos) return base;
    return withoutMoves(base, entryHasDiff(item));
  }
  if (pane === 'unit') {
    const off = [...UNIT_DISABLED, ...diffGitDisabled(item)];
    const onDiff = !item || item.lineDiff !== false;
    return withoutMoves(off, onDiff);
  }
  if (pane === 'branches') {
    return [...BRANCHES_DISABLED, ...branchGitDisabled(item)];
  }
  if (pane === 'commits') {
    return [...COMMITS_DISABLED, ...commitWriteDisabled(item)];
  }
  if (pane === 'npm' || pane === 'packages' || pane === 'agents') {
    return NPM_DISABLED;
  }
  if (pane === 'tasks' || onTodos) return TASKS_DISABLED;
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
const REVIEW_DROP = { d: 'revert' };
const DIFF_KEYS = { ...REVIEW_DROP, q: 'feedback' };
const BRANCH_KEYS = keysForActions(BRANCH_ACTIONS);
const COMMIT_KEYS = { ...keysForActions(COMMIT_ACTIONS), s: 'push' };
const NPM_KEYS = {
  e: 'npmEdit',
  insert: 'npmNew',
  delete: 'npmDrop',
  l: 'npmLogs',
};
const DASH_KEYS = keysForActions(DASH_ACTIONS);
const SCREEN_KEYS = DASH_KEYS;
const PANE_KEYS = {
  dashboard: { ...DASH_KEYS, a: 'dashAgents', p: 'pull', s: 'push' },
  files: REVIEW_DROP,
  diff: DIFF_KEYS,
  unit: DIFF_KEYS,
  branches: BRANCH_KEYS,
  commits: COMMIT_KEYS,
  npm: NPM_KEYS,
  packages: keysForActions(PACKAGE_ACTIONS),
  agents: keysForActions(AGENT_LIST_ACTIONS),
  tasks: { delete: 'drop' },
  repos: {
    left: 'repoLeft',
    right: 'repoRight',
    up: 'repoUp',
    down: 'repoDown',
    k: 'repoUp',
    j: 'repoDown',
    p: 'repoLeft',
    n: 'repoRight',
  },
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

const actionFromKey = (key, pane) => {
  if (LIST_PANES.includes(pane) && (key === 'left' || key === 'right')) {
    return null;
  }
  const paneKeys = PANE_KEYS[pane];
  if (paneKeys && paneKeys[key]) return paneKeys[key];
  if (pane && SCREEN_KEYS[key]) return SCREEN_KEYS[key];
  return KEY_TO_ACTION[key] ?? null;
};

const actionKeys = (id) =>
  ACTIONS[id] ??
  BRANCH_ACTIONS[id] ??
  COMMIT_ACTIONS[id] ??
  NPM_ACTIONS[id] ??
  PACKAGE_ACTIONS[id] ??
  AGENT_ACTIONS[id] ??
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
  confirmCommit: {
    choices: [
      { letter: 'esc', label: 'esc cancel', lead: '  ' },
      { letter: 'c', label: 'commit', lead: '  ' },
      { letter: 'a', label: 'amend', lead: '  ' },
      { letter: 'f', label: 'fixup', lead: '  ' },
    ],
    prefix: ' what do you want to do?',
    keys: {
      esc: 'cancel',
      escape: 'cancel',
      c: 'commit',
      a: 'amend',
      f: 'fixup',
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
  REPOS_ALLOWED,
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
  AGENTS_DISABLED,
  disabledActions,
  entryHasDiff,
  lineHasDiff,
  withoutMoves,
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
