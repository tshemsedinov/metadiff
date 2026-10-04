'use strict';

const tree = require('./tree.js');
const { folderOf, extOf } = tree;
const files = require('../files.js');
const { TASK_KINDS, taskKind } = files;

const MINUTE_MS = 60_000;
const RUNS_SHOWN = 6;
const CHAIN_GAP_MS = 2000;
const NPM_NAMED = /^npm (?:run|exec)(?:\s+-s)?\s+(\S+)/;
const NPM_ALIAS = /^npm (test|start|stop|restart)(?:\s|$)/;
const AGE_TEXT = /^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i;
const AGE_SEC = {
  second: 1,
  minute: 60,
  hour: 3600,
  day: 86400,
  week: 604800,
  month: 2592000,
  year: 31536000,
};
const STATUS_RANK = { running: 3, failed: 2, aborted: 1, passed: 0 };

const namedScript = (command) => {
  const text = `${command ?? ''}`.trim();
  const named = NPM_NAMED.exec(text);
  if (named) return named[1];
  const alias = NPM_ALIAS.exec(text);
  return alias ? alias[1] : '';
};

const scriptName = (command) => {
  const named = namedScript(command);
  if (named) return named;
  const text = `${command ?? ''}`.trim();
  const token = text.split(/\s+/)[0];
  const slash = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'));
  return token.slice(slash + 1) || text;
};

const runName = (record) => {
  const command = `${record.command ?? ''}`.trim();
  const script = `${record.script ?? ''}`.trim();
  return namedScript(command) || script || command;
};

const ageSeconds = (text) => {
  const raw = `${text ?? ''}`.trim();
  if (/^yesterday$/i.test(raw)) return AGE_SEC.day;
  const match = AGE_TEXT.exec(raw);
  if (!match) return Number.POSITIVE_INFINITY;
  return Number(match[1]) * AGE_SEC[match[2].toLowerCase()];
};

const newerDate = (current, next) => {
  if (!next) return current;
  if (!current || ageSeconds(next) < ageSeconds(current)) return next;
  return current;
};

const groupOf = (map, key) => {
  let group = map.get(key);
  if (!group) {
    group = {
      key,
      added: 0,
      removed: 0,
      stagedAdded: 0,
      stagedRemoved: 0,
      staged: 0,
      remaining: 0,
      date: '',
    };
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
  for (const entry of entries) {
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
  };
};

const npmRunStatus = (run) => {
  if (run.running) return 'running';
  if (run.exit === 0) return 'passed';
  if (run.exit === '' || run.exit === null) return 'aborted';
  return 'failed';
};

const externalRun = (record) => {
  const progress = record.progress ?? {};
  return {
    source: 'reslop t',
    name: runName(record),
    status: record.status,
    exit: record.exit,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    done: progress.done ?? 0,
    failed: progress.failed ?? 0,
    expected: progress.expected ?? 0,
    result: record.result ?? null,
  };
};

const internalRun = (run) => ({
  source: 'reslop',
  name: scriptName(run.label),
  status: npmRunStatus(run),
  exit: run.exit,
  startedAt: run.startedAt,
  endedAt: run.endedAt,
  done: 0,
  failed: 0,
  expected: 0,
  result: null,
});

const rankOf = (status) => STATUS_RANK[status] ?? 0;

const isOpen = (run) => run.status === 'running' || !run.endedAt;

const addNum = (left, right) => {
  if (typeof left !== 'number') return typeof right === 'number' ? right : null;
  return typeof right === 'number' ? left + right : left;
};

const mergeResult = (left, right) => {
  if (!left || !right) return left || right;
  const tools = new Set(left.tools);
  for (const tool of right.tools ?? []) tools.add(tool);
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
  return next.startedAt <= prev.endedAt + CHAIN_GAP_MS;
};

const absorbRun = (prev, next) => {
  const open = isOpen(prev) || isOpen(next);
  if (rankOf(next.status) >= rankOf(prev.status)) {
    prev.exit = next.exit;
    prev.status = next.status;
  }
  prev.endedAt = open ? 0 : Math.max(prev.endedAt, next.endedAt);
  prev.done += next.done;
  prev.failed += next.failed;
  prev.expected = Math.max(prev.expected, next.expected);
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
  return groups.sort((left, right) => right.startedAt - left.startedAt);
};

const mergeRuns = (records, npmRun) => {
  const list = records.map(externalRun);
  if (npmRun) list.push(internalRun(npmRun));
  return collapseRuns(list).slice(0, RUNS_SHOWN);
};

const taskKindCounts = (store) => {
  const kinds = TASK_KINDS.map((kind) => ({
    id: kind.id,
    title: kind.title,
    done: 0,
    total: 0,
  }));
  const byId = new Map(kinds.map((row) => [row.id, row]));
  let done = 0;
  let total = 0;
  if (!store) return { kinds, done, total };
  for (const task of store.tasks) {
    if (!`${task.text ?? ''}`.trim()) continue;
    const row = byId.get(taskKind(task));
    row.total += 1;
    total += 1;
    if (!task.done) continue;
    row.done += 1;
    done += 1;
  }
  return { kinds, done, total };
};

const versionFields = (pkg, outdatedMap) => {
  const hit = outdatedMap ? outdatedMap.get(pkg.name) : null;
  const current = (hit && hit.current) || pkg.version;
  if (!outdatedMap) return { current, wanted: '', latest: '' };
  if (!hit) return { current, wanted: current, latest: current };
  return { current, wanted: hit.wanted, latest: hit.latest };
};

const auditFields = (pkg, auditMap) => {
  const finding = auditMap ? auditMap.get(pkg.name) : null;
  return {
    audit: Boolean(finding),
    fix: finding && finding.fix ? finding.fix : '',
    range: finding && finding.range ? finding.range : '',
    severity: finding && finding.severity ? finding.severity : '',
    title: finding && finding.title ? finding.title : '',
  };
};

const modulesModel = (modules, auditMap, outdatedMap) => {
  const packages = modules.packages.map((pkg) => ({
    name: pkg.name,
    bytes: pkg.bytes,
    dev: pkg.dev,
    transitive: Boolean(pkg.transitive),
    chain: pkg.chain || '',
    ...auditFields(pkg, auditMap),
    ...versionFields(pkg, outdatedMap),
  }));
  return { ...modules, packages };
};

const npmModel = (input) => {
  const info = input.npm;
  const extras = input.npmExtras;
  const auditMap = extras ? extras.auditMap : null;
  const outdatedMap = extras ? extras.outdatedMap : null;
  const npmRun = input.npmRun;
  return {
    ready: Boolean(info),
    hasManifest: info ? info.hasManifest : false,
    deps: info ? info.deps : 0,
    dev: info ? info.dev : 0,
    modules: info ? modulesModel(info.modules, auditMap, outdatedMap) : null,
    audit: auditMap ? auditMap.size : null,
    outdated: outdatedMap ? outdatedMap.size : null,
    running: npmRun && npmRun.running ? npmRun.label : '',
  };
};

const minuteOf = (at) => Math.floor((at || 0) / MINUTE_MS);

const filesModel = (input) => {
  const index = input.index;
  const ready = Boolean(index && index.ready);
  const summary = ready ? index.summary() : null;
  const cold = { dirs: new Set(), exts: new Set() };
  return {
    ready,
    total: summary ? summary.total : { files: 0, bytes: 0, lines: 0 },
    dirs: summary ? summary.dirs : [],
    exts: summary ? summary.exts : [],
    hot: index ? index.hot(input.now) : cold,
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
    activity: input.activity ?? { minutes: [], live: false },
    delta: input.diffDelta,
  };
};

const commitsModel = (input) => {
  const git = input.git;
  return {
    ready: Boolean(git),
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
    rebase: git ? git.rebase : null,
    switches: input.switches,
    hot: input.branchAt,
  };
};

const tasksModel = (input) => taskKindCounts(input.store);

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
  agents: input.agents ?? { ready: true, installed: 0, total: 0, items: [] },
});

module.exports = {
  MINUTE_MS,
  minuteOf,
  groupChanges,
  mergeRuns,
  scriptName,
  runName,
  npmModel,
  buildModel,
};
