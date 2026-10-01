'use strict';

const tree = require('./tree.js');
const { folderOf, extOf } = tree;

const RUNS_SHOWN = 6;
const TASKS_SHOWN = 8;
const NPM_NAMED = /^npm (?:run|exec)(?:\s+-s)?\s+(\S+)/;
const NPM_ALIAS = /^npm (test|start|stop|restart)(?:\s|$)/;

const namedScript = (command) => {
  const text = `${command ?? ''}`.trim();
  const named = NPM_NAMED.exec(text);
  if (named) return named[1];
  const alias = NPM_ALIAS.exec(text);
  if (alias) return alias[1];
  return '';
};

const scriptName = (command) => {
  const named = namedScript(command);
  if (named) return named;
  const text = `${command ?? ''}`.trim();
  const token = text.split(/\s+/)[0];
  const slash = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'));
  const base = slash >= 0 ? token.slice(slash + 1) : token;
  return base || text;
};

const AGE_SEC = {
  second: 1,
  minute: 60,
  hour: 3600,
  day: 86400,
  week: 604800,
  month: 2592000,
  year: 31536000,
};

const AGE_TEXT = /^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i;

const ageSeconds = (text) => {
  const raw = `${text ?? ''}`.trim();
  if (/^yesterday$/i.test(raw)) return 86400;
  const match = AGE_TEXT.exec(raw);
  if (!match) return Number.POSITIVE_INFINITY;
  const unit = AGE_SEC[match[2].toLowerCase()];
  if (!unit) return Number.POSITIVE_INFINITY;
  return Number(match[1]) * unit;
};

const newerDate = (current, next) => {
  if (!next) return current;
  if (!current || ageSeconds(next) < ageSeconds(current)) return next;
  return current;
};

const emptyGroup = (key) => ({
  key,
  added: 0,
  removed: 0,
  stagedAdded: 0,
  stagedRemoved: 0,
  staged: 0,
  remaining: 0,
  date: '',
});

const groupOf = (map, key) => {
  let group = map.get(key);
  if (!group) {
    group = emptyGroup(key);
    map.set(key, group);
  }
  return group;
};

const byChange = (left, right) => {
  const lhs = left.added + left.removed;
  const rhs = right.added + right.removed;
  return rhs - lhs || left.key.localeCompare(right.key, 'en');
};

const groupChanges = (entries) => {
  const dirs = new Map();
  const exts = new Map();
  let newest = '';
  for (const entry of entries) {
    newest = newerDate(newest, entry.date);
    const groups = [
      groupOf(dirs, folderOf(entry.path)),
      groupOf(exts, extOf(entry.path)),
    ];
    for (const group of groups) {
      group.added += entry.added ?? 0;
      group.removed += entry.removed ?? 0;
      group.stagedAdded += entry.stagedAdded ?? 0;
      group.stagedRemoved += entry.stagedRemoved ?? 0;
      group.staged += entry.staged ?? 0;
      group.remaining += entry.remaining ?? 0;
      group.date = newerDate(group.date, entry.date);
    }
  }
  return {
    dirs: [...dirs.values()].sort(byChange),
    exts: [...exts.values()].sort(byChange),
    newest,
  };
};

const RUN_STATUS = { running: 'running', passed: 'passed', aborted: 'aborted' };

const npmRunStatus = (run) => {
  if (run.running) return RUN_STATUS.running;
  if (run.exit === 0) return RUN_STATUS.passed;
  if (run.exit === '' || run.exit === null) return RUN_STATUS.aborted;
  return 'failed';
};

const runName = (record) => {
  const command = `${record.command ?? ''}`.trim();
  const invoked = namedScript(command);
  if (invoked) return invoked;
  const script = `${record.script ?? ''}`.trim();
  if (script) return script;
  return command;
};

const externalRun = (record) => ({
  id: record.id,
  source: 'reslop t',
  command: record.command,
  name: runName(record),
  status: record.status,
  exit: record.exit,
  startedAt: record.startedAt,
  endedAt: record.endedAt,
  done: record.progress?.done ?? 0,
  failed: record.progress?.failed ?? 0,
  lines: record.progress?.lines ?? 0,
  expected: record.progress?.expected ?? 0,
  result: record.result ?? null,
});

const internalRun = (run) => ({
  id: `npm-${run.startedAt}`,
  source: 'reslop',
  command: run.label,
  name: scriptName(run.label),
  status: npmRunStatus(run),
  exit: run.exit,
  startedAt: run.startedAt,
  endedAt: run.endedAt,
  done: 0,
  failed: 0,
  lines: 0,
  expected: 0,
  result: null,
});

const CHAIN_GAP = 2000;

const STATUS_RANK = { running: 3, failed: 2, aborted: 1, passed: 0 };

const rankOf = (status) => STATUS_RANK[status] ?? 0;

const pickStatus = (left, right) =>
  rankOf(left) >= rankOf(right) ? left : right;

const isOpen = (run) => run.status === 'running' || !run.endedAt;

const addNum = (left, right) => {
  const hasLeft = typeof left === 'number';
  const hasRight = typeof right === 'number';
  if (!hasLeft) return hasRight ? right : null;
  if (!hasRight) return left;
  return left + right;
};

const mergeResult = (left, right) => {
  if (!left) return right;
  if (!right) return left;
  const leftTools = left.tools || [];
  const rightTools = right.tools || [];
  const tools = new Set([...leftTools, ...rightTools]);
  return {
    tools: [...tools],
    tests: addNum(left.tests, right.tests),
    passed: addNum(left.passed, right.passed),
    failed: addNum(left.failed, right.failed),
    skipped: addNum(left.skipped, right.skipped),
    errors: addNum(left.errors, right.errors),
    warnings: addNum(left.warnings, right.warnings),
    duration: left.duration || right.duration || '',
    problems: addNum(left.problems, right.problems),
  };
};

const continuesRun = (prev, next) => {
  if (prev.name !== next.name) return false;
  if (isOpen(prev)) return next.startedAt >= prev.startedAt;
  return next.startedAt <= prev.endedAt + CHAIN_GAP;
};

const absorbRun = (prev, next) => {
  const prevOpen = isOpen(prev);
  const nextOpen = isOpen(next);
  if (rankOf(next.status) >= rankOf(prev.status)) prev.exit = next.exit;
  prev.status = pickStatus(prev.status, next.status);
  const end = Math.max(prev.endedAt, next.endedAt);
  prev.endedAt = prevOpen || nextOpen ? 0 : end;
  prev.done += next.done;
  prev.failed += next.failed;
  prev.lines += next.lines;
  prev.expected = Math.max(prev.expected || 0, next.expected || 0);
  prev.result = mergeResult(prev.result, next.result);
};

const collapseRuns = (list) => {
  const ordered = [...list].sort(
    (left, right) => left.startedAt - right.startedAt,
  );
  const groups = [];
  for (const run of ordered) {
    const prev = groups.at(-1);
    if (prev && continuesRun(prev, run)) absorbRun(prev, run);
    else groups.push({ ...run });
  }
  groups.sort((left, right) => right.startedAt - left.startedAt);
  return groups;
};

const mergeRuns = (records, npmRun) => {
  const list = records.map(externalRun);
  if (npmRun) list.push(internalRun(npmRun));
  return collapseRuns(list).slice(0, RUNS_SHOWN);
};

const openTasks = (store) => {
  if (!store) return [];
  const texts = [];
  for (const task of store.tasks) {
    const text = task.text.trim();
    if (text && !task.done) texts.push(text.split('\n')[0]);
  }
  return texts.slice(0, TASKS_SHOWN);
};

const countProposals = (items) => {
  let count = 0;
  for (const item of items) {
    const change = item.dep && item.dep.change;
    if (change && change.propose) count += 1;
  }
  return count;
};

const mapSize = (map) => {
  if (!map) return null;
  return typeof map.size === 'number' ? map.size : Object.keys(map).length;
};

const outdatedEntry = (map, name) => {
  if (!map) return null;
  if (typeof map.get === 'function') return map.get(name) || null;
  return map[name] || null;
};

const versionFields = (pkg, outdatedMap) => {
  const known = Boolean(outdatedMap);
  const hit = known ? outdatedEntry(outdatedMap, pkg.name) : null;
  const installed = typeof pkg.version === 'string' ? pkg.version : '';
  const current = (hit && hit.current) || installed;
  if (!known) return { current, wanted: '', latest: '' };
  if (!hit) return { current, wanted: current, latest: current };
  const wanted = typeof hit.wanted === 'string' ? hit.wanted : '';
  const latest = typeof hit.latest === 'string' ? hit.latest : '';
  return { current, wanted, latest };
};

const modulesModel = (modules, outdatedMap, auditMap) => {
  if (!modules) return null;
  const source = Array.isArray(modules.packages) ? modules.packages : [];
  const packages = source.map((pkg) => ({
    name: pkg.name,
    bytes: pkg.bytes,
    dev: pkg.dev === true,
    audit: Boolean(outdatedEntry(auditMap, pkg.name)),
    ...versionFields(pkg, outdatedMap),
  }));
  return { ...modules, packages };
};

const npmModel = (input) => {
  const info = input.npm;
  const extras = input.npmExtras;
  const outdatedMap = extras ? extras.outdatedMap : null;
  const auditMap = extras ? extras.auditMap : null;
  return {
    ready: Boolean(info),
    hasManifest: info ? info.hasManifest : false,
    deps: info ? info.deps : 0,
    dev: info ? info.dev : 0,
    optional: info ? info.optional : 0,
    scripts: info ? info.scripts : [],
    modules: info ? modulesModel(info.modules, outdatedMap, auditMap) : null,
    audit: extras ? mapSize(extras.auditMap) : null,
    outdated: extras ? mapSize(outdatedMap) : null,
    proposals: countProposals(input.items),
    running: input.npmRun && input.npmRun.running ? input.npmRun.label : '',
    changedAt: input.marks.npm,
  };
};

const filesModel = (input) => {
  const index = input.index;
  const ready = Boolean(index && index.ready);
  const summary = ready ? index.summary() : null;
  const cold = { dirs: new Set(), exts: new Set() };
  const hot = index ? index.hot(input.now) : cold;
  return {
    ready,
    total: summary ? summary.total : { files: 0, bytes: 0, lines: 0 },
    dirs: summary ? summary.dirs : [],
    exts: summary ? summary.exts : [],
    hot,
    delta: input.fileDelta,
  };
};

const diffsModel = (input) => {
  const groups = groupChanges(input.entries);
  return {
    totals: input.totals,
    dirs: groups.dirs,
    exts: groups.exts,
    files: input.entries.length,
    newest: groups.newest,
    samples: input.samples,
    delta: input.diffDelta,
  };
};

const commitsModel = (input) => {
  const git = input.git;
  return {
    ready: Boolean(git),
    branch: git ? git.branch : input.branch,
    detached: git ? git.detached : false,
    rebase: git ? git.rebase : null,
    info: git ? git.commits : null,
    changedAt: input.marks.commit,
  };
};

const branchesModel = (input) => {
  const git = input.git;
  return {
    ready: Boolean(git),
    list: git ? git.branches : [],
    current: git ? git.branch : input.branch,
    detached: git ? git.detached : false,
    rebase: git ? git.rebase : null,
    switches: input.switches,
    hot: input.branchAt,
    changedAt: input.marks.branches,
  };
};

const tasksModel = (input) => ({
  total: input.notes.tasks,
  done: input.notes.tasksDone,
  feedback: input.notes.feedback,
  code: input.notes.code,
  open: openTasks(input.store),
});

const buildModel = (input) => ({
  now: input.now,
  frame: input.frame,
  busy: input.busy,
  files: filesModel(input),
  diffs: diffsModel(input),
  commits: commitsModel(input),
  branches: branchesModel(input),
  npm: npmModel(input),
  runs: mergeRuns(input.runs, input.npmRun),
  tasks: tasksModel(input),
});

module.exports = {
  groupChanges,
  mergeRuns,
  countProposals,
  scriptName,
  runName,
  buildModel,
};
