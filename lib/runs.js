'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ansi = require('./ansi.js');
const { stripAnsi } = ansi;
const commands = require('./npm-commands.js');
const { isPassingTest } = commands;

const LOG_DIR = '.log';
const RUNS_DIR = '.runs';
const RUNS_PREFIX = `${LOG_DIR}/${RUNS_DIR}/`;
const RUNS_KEEP = 24;
const WRITE_MS = 150;
const FAILING_TEST = /^\s*(?:not ok \d+|[✖✗×]) /;

const runsDir = (root) => path.join(root, LOG_DIR, RUNS_DIR);

const isRunsRel = (rel) => {
  const norm = `${rel ?? ''}`.replaceAll('\\', '/');
  if (norm === LOG_DIR || norm === `${LOG_DIR}/${RUNS_DIR}`) return true;
  return norm.startsWith(RUNS_PREFIX);
};

const commandLabel = (program, args = []) => {
  const name = path.basename(`${program ?? ''}`);
  return [name, ...args].join(' ').trim();
};

const isFailingTest = (line) => FAILING_TEST.test(stripAnsi(line));

const createTracker = () => {
  const progress = { done: 0, failed: 0, lines: 0 };
  let carry = '';
  const take = (line) => {
    progress.lines += 1;
    if (isPassingTest(line)) progress.done += 1;
    else if (isFailingTest(line)) progress.failed += 1;
  };
  const feed = (chunk) => {
    const parts = `${carry}${chunk}`.split('\n');
    carry = parts.pop();
    for (const line of parts) take(line);
    return progress;
  };
  return { progress, feed };
};

const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

const readRecord = (file) => {
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!record || typeof record !== 'object' || !record.id) return null;
    return record;
  } catch {
    return null;
  }
};

const listRunNames = (root) => {
  try {
    return fs.readdirSync(runsDir(root)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
};

const settleRecord = (record, alive = pidAlive) => {
  if (record.status !== 'running') return record;
  if (alive(record.pid)) return record;
  return { ...record, status: 'aborted' };
};

const readRuns = (root, alive = pidAlive) => {
  const dir = runsDir(root);
  const records = [];
  for (const name of listRunNames(root)) {
    const record = readRecord(path.join(dir, name));
    if (record) records.push(settleRecord(record, alive));
  }
  records.sort((left, right) => right.startedAt - left.startedAt);
  return records;
};

const writeRecord = (root, record) => {
  const dir = runsDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${record.id}.json`);
  const temp = `${file}.tmp`;
  const text = JSON.stringify(record);
  try {
    fs.writeFileSync(temp, text);
    fs.renameSync(temp, file);
  } catch {
    fs.writeFileSync(file, text);
  }
};

const pruneRuns = (root, keep = RUNS_KEEP) => {
  const dir = runsDir(root);
  const names = listRunNames(root).sort();
  const extra = names.length - keep;
  for (let i = 0; i < extra; i++) {
    fs.rmSync(path.join(dir, names[i]), { force: true });
  }
};

const previousTotal = (root, command) => {
  for (const record of readRuns(root)) {
    if (record.command !== command || record.status === 'running') continue;
    if (record.status === 'aborted') continue;
    const progress = record.progress ?? {};
    const total = (progress.done ?? 0) + (progress.failed ?? 0);
    if (total > 0) return total;
  }
  return 0;
};

const sumField = (reports, key) => {
  let total = null;
  for (const item of reports) {
    const value = item.summary[key];
    if (typeof value !== 'number') continue;
    total = (total ?? 0) + value;
  }
  return total;
};

const summarizeDocument = (doc) => {
  if (!doc || !Array.isArray(doc.reports)) return null;
  const reports = doc.reports;
  const durations = reports.map((item) => item.summary.duration);
  let problems = 0;
  for (const item of reports) problems += item.problems.length;
  return {
    tools: reports.map((item) => item.tool),
    tests: sumField(reports, 'tests'),
    passed: sumField(reports, 'passed'),
    failed: sumField(reports, 'failed'),
    skipped: sumField(reports, 'skipped'),
    errors: sumField(reports, 'errors'),
    warnings: sumField(reports, 'warnings'),
    duration: durations.find(Boolean) ?? '',
    problems,
  };
};

const safely = (fn) => {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
};

const startRun = (root, command, options = {}) => {
  const clock = options.now ?? Date.now;
  const startedAt = clock();
  const id = `${startedAt}-${process.pid}`;
  const tracker = createTracker();
  const record = {
    v: 1,
    id,
    pid: process.pid,
    command,
    cwd: root,
    startedAt,
    endedAt: 0,
    status: 'running',
    exit: null,
    progress: { ...tracker.progress, expected: 0 },
    result: null,
  };
  let lastWrite = 0;
  let closed = false;
  safely(() => {
    record.progress.expected = previousTotal(root, command);
    pruneRuns(root);
    writeRecord(root, record);
  });
  const sync = () => {
    const { expected } = record.progress;
    record.progress = { ...tracker.progress, expected };
  };
  const feed = (chunk) => {
    if (closed) return;
    tracker.feed(chunk);
    const now = clock();
    if (now - lastWrite < WRITE_MS) return;
    lastWrite = now;
    sync();
    safely(() => writeRecord(root, record));
  };
  const finish = (status, result = null) => {
    if (closed) return;
    closed = true;
    sync();
    record.endedAt = clock();
    record.exit = status;
    record.status = status === 0 ? 'passed' : 'failed';
    record.result = result;
    safely(() => writeRecord(root, record));
  };
  return { id, feed, finish };
};

module.exports = {
  RUNS_PREFIX,
  runsDir,
  isRunsRel,
  commandLabel,
  isFailingTest,
  createTracker,
  pidAlive,
  settleRecord,
  readRuns,
  summarizeDocument,
  startRun,
};
