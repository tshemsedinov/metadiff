'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ansi = require('./ansi.js');
const { stripAnsi } = ansi;
const commands = require('./npm-commands.js');
const { isPassingTest } = commands;

const LOG_DIR = '.log';
const RUNS_REL = `${LOG_DIR}/.runs`;
const RUNS_KEEP = 24;
const WRITE_MS = 150;
const FAILING_TEST = /^\s*(?:not ok \d+|[✖✗×]) /;
const LIFECYCLE_EVENT = 'npm_lifecycle_event';

const runsDir = (root) => path.join(root, RUNS_REL);

const isRunsRel = (rel) =>
  rel === LOG_DIR || rel === RUNS_REL || rel.startsWith(`${RUNS_REL}/`);

const commandLabel = (program, args) =>
  [path.basename(program), ...args].join(' ').trim();

const isFailingTest = (line) => FAILING_TEST.test(stripAnsi(line));

class Tracker {
  constructor() {
    this.progress = { done: 0, failed: 0, lines: 0 };
    this.carry = '';
  }

  feed(chunk) {
    const parts = `${this.carry}${chunk}`.split('\n');
    this.carry = parts.pop();
    const progress = this.progress;
    for (const line of parts) {
      progress.lines += 1;
      if (isPassingTest(line)) progress.done += 1;
      else if (isFailingTest(line)) progress.failed += 1;
    }
  }
}

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
  if (record.status !== 'running' || alive(record.pid)) return record;
  return { ...record, status: 'aborted' };
};

const readRuns = (root) => {
  const dir = runsDir(root);
  const records = [];
  for (const name of listRunNames(root)) {
    const record = readRecord(path.join(dir, name));
    if (record) records.push(settleRecord(record));
  }
  return records.sort((left, right) => right.startedAt - left.startedAt);
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

const pruneRuns = (root) => {
  const dir = runsDir(root);
  const names = listRunNames(root).sort();
  const extra = names.length - RUNS_KEEP;
  for (let i = 0; i < extra; i++) {
    fs.rmSync(path.join(dir, names[i]), { force: true });
  }
};

const previousTotal = (root, command) => {
  for (const record of readRuns(root)) {
    if (record.command !== command) continue;
    if (record.status === 'running' || record.status === 'aborted') continue;
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
  } catch {
    // run records are best effort
  }
};

class RunRecorder {
  constructor(root, command, options = {}) {
    this.root = root;
    this.clock = options.now ?? Date.now;
    this.tracker = new Tracker();
    this.lastWrite = 0;
    this.closed = false;
    const startedAt = this.clock();
    const env = options.env || process.env;
    this.record = {
      v: 1,
      id: `${startedAt}-${process.pid}`,
      pid: process.pid,
      command,
      script: `${env[LIFECYCLE_EVENT] ?? ''}`.trim(),
      cwd: root,
      startedAt,
      endedAt: 0,
      status: 'running',
      exit: null,
      progress: { ...this.tracker.progress, expected: 0 },
      result: null,
    };
    safely(() => {
      this.record.progress.expected = previousTotal(root, command);
      pruneRuns(root);
      this.write();
    });
  }

  write() {
    Object.assign(this.record.progress, this.tracker.progress);
    writeRecord(this.root, this.record);
  }

  feed(chunk) {
    if (this.closed) return;
    this.tracker.feed(chunk);
    const now = this.clock();
    if (now - this.lastWrite < WRITE_MS) return;
    this.lastWrite = now;
    safely(() => this.write());
  }

  finish(status, result = null) {
    if (this.closed) return;
    this.closed = true;
    const record = this.record;
    record.endedAt = this.clock();
    record.exit = status;
    record.status = status === 0 ? 'passed' : 'failed';
    record.result = result;
    safely(() => this.write());
  }
}

module.exports = {
  runsDir,
  isRunsRel,
  commandLabel,
  Tracker,
  settleRecord,
  readRuns,
  summarizeDocument,
  RunRecorder,
};
