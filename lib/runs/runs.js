'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readJson, listDir, trimText } = require('../common/utilities.js');
const { isHashObject } = require('metautil');
const { LOG_DIR } = require('../common/files.js');

const { stripAnsi } = require('../term/ansi.js');
const { isPassingTest } = require('./output.js');
const { nextLogFile } = require('./logs.js');

const RUNS_REL = `${LOG_DIR}/.runs`;
const RUNS_KEEP = 24;
const WRITE_MS = 150;
const FAILING_TEST = /^\s*(?:not ok \d+|[✖✗×]) /;
const LIFECYCLE_EVENT = 'npm_lifecycle_event';

const logDir = (root) => path.join(root, LOG_DIR);

const runsDir = (root) => path.join(root, RUNS_REL);

const isRunsRel = (rel) => {
  if (rel === LOG_DIR || rel === RUNS_REL || rel.startsWith(`${RUNS_REL}/`)) {
    return true;
  }
  if (!rel.startsWith(`${LOG_DIR}/`)) return false;
  const name = rel.slice(LOG_DIR.length + 1);
  if (name.includes('/')) return false;
  return name.endsWith('.json') || name.endsWith('.log');
};

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
  const record = readJson(file);
  return isHashObject(record) && record.id ? record : null;
};

const listJson = (dir) => listDir(dir).filter((name) => name.endsWith('.json'));

const isCommandRun = (record) =>
  Boolean(record && record.id && record.progress && !record.cliId);

const settleRecord = (record, alive = pidAlive) => {
  if (record.status !== 'running' || alive(record.pid)) return record;
  return { ...record, status: 'aborted' };
};

const pushRuns = (records, dir, names) => {
  for (const name of names) {
    const record = readRecord(path.join(dir, name));
    if (isCommandRun(record)) records.push(settleRecord(record));
  }
};

const readRuns = (root) => {
  const records = [];
  const dir = logDir(root);
  pushRuns(records, dir, listJson(dir));
  pushRuns(records, runsDir(root), listJson(runsDir(root)));
  return records.sort((left, right) => right.startedAt - left.startedAt);
};

const writeRecord = (file, record) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  const text = JSON.stringify(record);
  try {
    fs.writeFileSync(temp, text);
    fs.renameSync(temp, file);
  } catch {
    fs.writeFileSync(file, text);
  }
};

const removeStem = (dir, jsonName) => {
  const stem = jsonName.replace(/\.json$/, '');
  const suffixes = ['.json', '.log', '.raw', '.raw.log'];
  for (const suffix of suffixes) {
    fs.rmSync(path.join(dir, `${stem}${suffix}`), { force: true });
  }
};

const commandJson = (root) => {
  const dir = logDir(root);
  const names = [];
  for (const name of listJson(dir)) {
    if (/-agent-\d+\.json$/.test(name)) continue;
    const record = readRecord(path.join(dir, name));
    if (isCommandRun(record)) names.push(name);
  }
  names.sort();
  return names;
};

const pruneRuns = (root) => {
  const dir = logDir(root);
  const names = commandJson(root);
  const extra = names.length - RUNS_KEEP;
  for (let i = 0; i < extra; i++) removeStem(dir, names[i]);
  const legacy = runsDir(root);
  const old = listJson(legacy).sort();
  const leftover = old.length - RUNS_KEEP;
  for (let i = 0; i < leftover; i++) {
    fs.rmSync(path.join(legacy, old[i]), { force: true });
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
    this.slot = Object.hasOwn(options, 'slot') ? options.slot : null;
    if (!Object.hasOwn(options, 'slot')) {
      try {
        this.slot = nextLogFile(root, command);
      } catch {
        this.slot = null;
      }
    }
    const startedAt = this.clock();
    const env = options.env || process.env;
    this.record = {
      v: 1,
      id: `${startedAt}-${process.pid}`,
      pid: process.pid,
      command,
      script: trimText(env[LIFECYCLE_EVENT]),
      cwd: root,
      startedAt,
      endedAt: 0,
      status: 'running',
      exit: null,
      progress: { ...this.tracker.progress, expected: 0 },
      result: null,
    };
    if (this.slot) {
      this.record.log = this.slot.name;
      this.record.raw = this.slot.rawName;
    }
    safely(() => {
      this.record.progress.expected = previousTotal(root, command);
      pruneRuns(root);
      this.write();
    });
  }

  write() {
    if (!this.slot) return;
    Object.assign(this.record.progress, this.tracker.progress);
    writeRecord(this.slot.jsonFull, this.record);
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
  logDir,
  runsDir,
  isRunsRel,
  commandLabel,
  Tracker,
  settleRecord,
  readRuns,
  summarizeDocument,
  RunRecorder,
};
