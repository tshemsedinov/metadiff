'use strict';

const tree = require('./tree.js');
const { folderOf, extOf } = tree;

const RUNS_SHOWN = 6;
const TASKS_SHOWN = 8;
const NPM_NAMED = /^npm (?:run|exec)(?:\s+-s)?\s+(\S+)/;
const NPM_ALIAS = /^npm (test|start|stop|restart)(?:\s|$)/;

const scriptName = (command) => {
  const text = `${command ?? ''}`.trim();
  const named = NPM_NAMED.exec(text);
  if (named) return named[1];
  const alias = NPM_ALIAS.exec(text);
  if (alias) return alias[1];
  const token = text.split(/\s+/)[0];
  const slash = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'));
  const base = slash >= 0 ? token.slice(slash + 1) : token;
  return base || text;
};

const emptyGroup = (key) => ({
  key,
  files: 0,
  bytes: 0,
  added: 0,
  removed: 0,
  stagedAdded: 0,
  stagedRemoved: 0,
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

const groupChanges = (entries, sizeOf) => {
  const dirs = new Map();
  const exts = new Map();
  for (const entry of entries) {
    const bytes = sizeOf(entry.path);
    const groups = [
      groupOf(dirs, folderOf(entry.path)),
      groupOf(exts, extOf(entry.path)),
    ];
    for (const group of groups) {
      group.files += 1;
      group.bytes += bytes;
      group.added += entry.added ?? 0;
      group.removed += entry.removed ?? 0;
      group.stagedAdded += entry.stagedAdded ?? 0;
      group.stagedRemoved += entry.stagedRemoved ?? 0;
    }
  }
  return {
    dirs: [...dirs.values()].sort(byChange),
    exts: [...exts.values()].sort(byChange),
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
  const script = `${record.script ?? ''}`.trim();
  if (script) return script;
  return scriptName(record.command);
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

const mergeRuns = (records, npmRun) => {
  const list = records.map(externalRun);
  if (npmRun) list.push(internalRun(npmRun));
  list.sort((left, right) => right.startedAt - left.startedAt);
  return list.slice(0, RUNS_SHOWN);
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

const npmModel = (input) => {
  const info = input.npm;
  const extras = input.npmExtras;
  return {
    ready: Boolean(info),
    hasManifest: info ? info.hasManifest : false,
    deps: info ? info.deps : 0,
    dev: info ? info.dev : 0,
    optional: info ? info.optional : 0,
    scripts: info ? info.scripts : [],
    modules: info ? info.modules : null,
    audit: extras ? mapSize(extras.auditMap) : null,
    outdated: extras ? mapSize(extras.outdatedMap) : null,
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
  const groups = groupChanges(input.entries, input.sizeOf);
  return {
    totals: input.totals,
    dirs: groups.dirs,
    exts: groups.exts,
    files: input.entries.length,
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
