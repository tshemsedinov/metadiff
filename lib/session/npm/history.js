'use strict';

const commands = require('../../runs/commands.js');
const { stripAnsi } = require('../../term/ansi.js');
const { buildDocument } = require('../../report/parse.js');
const report = require('../../report/render.js');
const { renderDocument, renderReport } = report;
const runStore = require('../../runs/runs.js');
const { Tracker, summarizeDocument } = runStore;
const { runName } = require('../../dashboard/model.js');
const { reduceOutput } = commands;

const TESTS_RE = /^(?:TAP version \d+|\s*(?:not )?ok\b|[ℹi]\s+tests\s+\d+)/m;

const filteredOutput = (raw, root, status, rawFile) => {
  const text = stripAnsi(`${raw ?? ''}`);
  if (status === '' || !TESTS_RE.test(text)) {
    const output = reduceOutput(raw, root, status);
    return { output, log: output, result: null };
  }
  const doc = buildDocument(raw, '', root, status, 'test');
  const result = summarizeDocument(doc);
  const output = renderReport(doc);
  const log = renderDocument(doc, rawFile);
  return { output, log, result };
};

const runLabel = (entry) =>
  entry.kind === 'bin' ? `npm exec ${entry.name}` : `npm run ${entry.name}`;

const historyMark = (run) => {
  if (run.status === 'running') return 'run';
  if (run.status === 'stopped') return 'stop';
  if (run.exit === 0 || run.exit === '0') return 'pass';
  return 'fail';
};

const historyCounts = (run) => {
  const result = run.result;
  if (result && typeof result.tests === 'number') {
    const fail = result.failed ?? 0;
    const ok = result.passed ?? Math.max(0, result.tests - fail);
    return { done: result.tests, ok, fail, total: result.tests };
  }
  const progress = run.progress;
  if (!progress) return null;
  const ok = progress.done ?? 0;
  const fail = progress.failed ?? 0;
  if (!ok && !fail && !(progress.expected > 0)) return null;
  const total = progress.expected > 0 ? progress.expected : null;
  return { done: ok + fail, ok, fail, total };
};

const countText = (value) => (typeof value === 'number' ? `${value}` : '');

const historyExit = (run, counts) => {
  if (counts || run.status !== 'exited') return '';
  if (run.exit === '' || run.exit === null || run.exit === undefined) return '';
  return `exit ${run.exit}`;
};

const earlierTotal = (list, run) => {
  let best = 0;
  let at = -1;
  for (const item of list) {
    if (item === run || item.name !== run.name) continue;
    if (item.status === 'running') continue;
    const counts = historyCounts(item);
    if (!counts || typeof counts.total !== 'number') continue;
    const started = item.startedAt || 0;
    if (started < at) continue;
    at = started;
    best = counts.total;
  }
  return best;
};

const noteTests = (run, list, text) => {
  const plain = stripAnsi(`${text ?? ''}`);
  if (!TESTS_RE.test(plain)) return;
  const tracker = new Tracker();
  tracker.feed(plain);
  if (!Object.hasOwn(run, 'expected')) run.expected = earlierTotal(list, run);
  run.progress = {
    done: tracker.progress.done,
    failed: tracker.progress.failed,
    expected: run.expected,
  };
};

const RUN_KEEP = 50;

const LOG_GAP_MS = 2000;

const RESLOP_RUN = /^reslop(?:\.js)?\s+t\s+--\s+/;

const RESLOP_T = /reslop(?:\.js)?\s+t\s+--/;

const launchedReslop = (run) =>
  !run.externalId && RESLOP_T.test(`${run.command ?? ''}`);

const historyName = (run) => {
  const script = `${run.name ?? ''}`.trim();
  if (script) return script;
  return `${run.command ?? ''}`.trim().replace(RESLOP_RUN, '');
};

const sameWindow = (left, right) => {
  const start = Number(left.startedAt) || 0;
  const end = Number(left.endedAt) || start;
  const at = Number(right.startedAt) || 0;
  const done = Number(right.endedAt) || at;
  return done >= start - LOG_GAP_MS && at <= end + LOG_GAP_MS;
};

const logBase = (name) => {
  const file = `${name ?? ''}`;
  if (!file || file.includes('/') || file.includes('\\')) return '';
  return file;
};

const externalStatus = (record) => {
  if (record.status === 'running') return 'running';
  if (record.status === 'aborted') return 'stopped';
  return 'exited';
};

const externalExit = (record) => {
  if (record.status === 'running' || record.status === 'aborted') return '';
  if (record.exit === null || record.exit === undefined) return '';
  return record.exit;
};

const progressCount = (progress, key) => {
  if (!progress || typeof progress[key] !== 'number') return 0;
  return progress[key];
};

const progressSame = (left, right) =>
  progressCount(left, 'done') === progressCount(right, 'done') &&
  progressCount(left, 'failed') === progressCount(right, 'failed') &&
  progressCount(left, 'expected') === progressCount(right, 'expected');

const resultSame = (left, right) => {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return (
    left.tests === right.tests &&
    left.passed === right.passed &&
    left.failed === right.failed &&
    left.errors === right.errors
  );
};

const applyExternal = (run, record) => {
  const status = externalStatus(record);
  const exit = externalExit(record);
  const endedAt = Number(record.endedAt) || 0;
  const progress = record.progress ?? null;
  const result = record.result ?? null;
  const same =
    run.status === status &&
    run.exit === exit &&
    (run.endedAt || 0) === endedAt &&
    progressSame(run.progress, progress) &&
    resultSame(run.result, result);
  if (same) return false;
  run.status = status;
  run.exit = exit;
  run.endedAt = endedAt;
  run.progress = progress;
  run.result = result;
  return true;
};

const recordedItem = (record) => {
  const script = `${record.script ?? ''}`.trim();
  const command = `${record.command ?? ''}`.trim();
  const name = runName({ command, script }).replace(RESLOP_RUN, '');
  return {
    name,
    kind: script ? 'script' : 'command',
    command,
    status: externalStatus(record),
    exit: externalExit(record),
    startedAt: Number(record.startedAt) || 0,
    endedAt: Number(record.endedAt) || 0,
    logName: logBase(record.log),
    rawName: logBase(record.raw),
    externalId: `${record.id ?? ''}`,
    result: record.result ?? null,
    progress: record.progress ?? null,
  };
};

const whenLabel = (ms) => {
  if (!ms) return '';
  const date = new Date(ms);
  const hh = `${date.getHours()}`.padStart(2, '0');
  const mm = `${date.getMinutes()}`.padStart(2, '0');
  const time = `${hh}:${mm}`;
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  if (sameDay) return time;
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${month}-${day} ${time}`;
};

const elapsedText = (run, now) => {
  const end = run.endedAt || now;
  const ms = Math.max(0, end - (run.startedAt || end));
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  return `${min}m${String(rest).padStart(2, '0')}s`;
};

module.exports = {
  filteredOutput,
  runLabel,
  historyMark,
  historyCounts,
  countText,
  historyExit,
  noteTests,
  RUN_KEEP,
  launchedReslop,
  historyName,
  sameWindow,
  logBase,
  applyExternal,
  recordedItem,
  whenLabel,
  elapsedText,
};
