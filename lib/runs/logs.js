'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { jsonParse } = require('metautil');
const { stripAnsi } = require('../term/ansi.js');
const utilities = require('../common/utilities.js');
const { dateStamp, readText } = utilities;

const logFileName = (command, date, index) => {
  const safe = `${command}`.replace(/[^A-Za-z0-9._-]+/g, '-');
  const n = `${index}`.padStart(2, '0');
  return `${date}-${safe}-${n}.log`;
};

const LOG_DIR = '.log';

const LOG_STALE_DAYS = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

const LOG_DATE = /^(\d{4})-(\d{2})-(\d{2})-/;

const logDay = (name) => {
  const match = LOG_DATE.exec(name);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return Date.UTC(year, month - 1, day) / DAY_MS;
};

const todayIndex = (now) =>
  Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY_MS;

const isStaleLog = (name, now) => {
  const day = logDay(name);
  if (day === null) return false;
  return todayIndex(now) - day > LOG_STALE_DAYS;
};

const readLogNames = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
};

const staleLogFiles = (root, now = new Date()) => {
  const dir = path.join(root, LOG_DIR);
  const files = [];
  let bytes = 0;
  for (const name of readLogNames(dir)) {
    if (!/\.(?:log|raw|json)$/.test(name) || !isStaleLog(name, now)) continue;
    const full = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isFile()) continue;
    bytes += stat.size;
    files.push(full);
  }
  return { bytes, files };
};

const removeStaleLogs = (root, now = new Date()) => {
  const found = staleLogFiles(root, now);
  for (const full of found.files) fs.rmSync(full, { force: true });
  return found.bytes;
};

const logSlot = (dir, name) => {
  const stem = name.replace(/\.log$/, '');
  const rawName = `${stem}.raw`;
  const jsonName = `${stem}.json`;
  const full = path.join(dir, name);
  const rawFull = path.join(dir, rawName);
  const jsonFull = path.join(dir, jsonName);
  const legacy = path.join(dir, `${stem}.raw.log`);
  return { name, full, dir, rawName, rawFull, jsonName, jsonFull, legacy };
};

const slotTaken = (slot) =>
  fs.existsSync(slot.full) ||
  fs.existsSync(slot.rawFull) ||
  fs.existsSync(slot.jsonFull) ||
  fs.existsSync(slot.legacy);

const nextLogFile = (root, command, now = new Date()) => {
  const date = dateStamp(now);
  const dir = path.join(root, LOG_DIR);
  let slot = null;
  for (let index = 1; index <= 100; index++) {
    slot = logSlot(dir, logFileName(command, date, index));
    if (!slotTaken(slot)) break;
  }
  return slot;
};

const logText = (text) =>
  stripAnsi(text)
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n');

const RUN_MARK = 'npm-run';

const LOG_FILE = /^(\d{4}-\d{2}-\d{2})-(.+)-(\d{2})\.log$/;

const AGENT_LOG = /-agent-\d{2}\.log$/;

const safeName = (name) => `${name}`.replace(/[^A-Za-z0-9._-]+/g, '-');

const fileName = (name) => {
  const file = `${name ?? ''}`;
  if (!file || file.includes('/') || file.includes('\\')) return '';
  return file;
};

const runMeta = (run, slot) => ({
  reslop: RUN_MARK,
  name: run.name,
  kind: run.kind === 'bin' ? 'bin' : 'script',
  command: `${run.command ?? ''}`,
  status: run.status === 'stopped' ? 'stopped' : 'exited',
  exit: run.status === 'stopped' ? '' : run.exit,
  startedAt: Number(run.startedAt) || 0,
  endedAt: Number(run.endedAt) || 0,
  log: slot.name,
  raw: slot.rawName,
  result: run.result ?? null,
  progress: run.progress ?? null,
});

const saveLogs = async (slot, reduced, raw, run) => {
  await fs.promises.mkdir(slot.dir, { recursive: true });
  const writes = [
    fs.promises.writeFile(slot.full, logText(reduced)),
    fs.promises.writeFile(slot.rawFull, logText(raw)),
  ];
  if (run) {
    const body = `${JSON.stringify(runMeta(run, slot), null, 2)}\n`;
    writes.push(fs.promises.writeFile(slot.jsonFull, body));
  }
  await Promise.all(writes);
};

const readJson = (file) => {
  const text = readText(file);
  if (!text) return null;
  try {
    const data = jsonParse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    return data;
  } catch {
    return null;
  }
};

const storedExit = (data) => {
  if (data.status === 'stopped') return '';
  if (typeof data.exit === 'number' && Number.isInteger(data.exit)) {
    return data.exit;
  }
  if (typeof data.exit === 'string' && /^-?\d+$/.test(data.exit)) {
    return Number(data.exit);
  }
  return '';
};

const savedFromRecord = (data) => {
  if (!data || data.reslop !== RUN_MARK) return null;
  const name = `${data.name ?? ''}`;
  const logName = fileName(data.log);
  if (!name || !logName) return null;
  const startedAt = Number(data.startedAt) || 0;
  const endedAt = Number(data.endedAt) || startedAt;
  return {
    name,
    kind: data.kind === 'bin' ? 'bin' : 'script',
    command: `${data.command ?? ''}`,
    status: data.status === 'stopped' ? 'stopped' : 'exited',
    exit: storedExit(data),
    startedAt,
    endedAt,
    logName,
    rawName: fileName(data.raw),
    result: data.result ?? null,
    progress: data.progress ?? null,
  };
};

const exitOf = (text) => {
  const lines = `${text ?? ''}`.split('\n');
  while (lines.length && lines.at(-1) === '') lines.pop();
  const last = lines.at(-1) ?? '';
  if (last === 'terminated') return { status: 'stopped', exit: '' };
  const match = /^exit (.+)$/.exec(last);
  if (!match) return { status: 'exited', exit: '' };
  if (match[1] === 'null') return { status: 'stopped', exit: '' };
  const code = Number(match[1]);
  if (!Number.isInteger(code)) return { status: 'exited', exit: '' };
  return { status: 'exited', exit: code };
};

const commandFor = (commands, safe) => {
  const hits = [];
  for (const entry of commands) {
    if (safeName(entry.name) === safe) hits.push(entry);
  }
  for (const entry of hits) {
    if (entry.name === safe && entry.kind === 'script') return entry;
  }
  for (const entry of hits) {
    if (entry.kind === 'script') return entry;
  }
  return hits[0] || null;
};

const legacyRun = (dir, name, names, commands) => {
  const match = LOG_FILE.exec(name);
  if (!match) return null;
  const stem = name.replace(/\.log$/, '');
  const linked = commandFor(commands, match[2]);
  const text = readText(path.join(dir, name));
  const outcome = exitOf(text);
  let endedAt;
  try {
    endedAt = fs.statSync(path.join(dir, name)).mtimeMs;
  } catch {
    endedAt = 0;
  }
  const rawFile = `${stem}.raw`;
  return {
    name: linked ? linked.name : match[2],
    kind: linked ? linked.kind : 'script',
    command: linked ? `${linked.command ?? ''}` : '',
    status: outcome.status,
    exit: outcome.exit,
    startedAt: endedAt,
    endedAt,
    logName: name,
    rawName: names.includes(rawFile) ? rawFile : '',
  };
};

const readSavedRuns = (root, commands = []) => {
  const dir = path.join(root, LOG_DIR);
  const names = readLogNames(dir);
  const runs = [];
  const seen = new Set();
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const saved = savedFromRecord(readJson(path.join(dir, name)));
    if (!saved || seen.has(saved.logName)) continue;
    seen.add(saved.logName);
    runs.push(saved);
  }
  for (const name of names) {
    if (!LOG_FILE.test(name) || AGENT_LOG.test(name) || seen.has(name)) {
      continue;
    }
    const stem = name.replace(/\.log$/, '');
    if (names.includes(`${stem}.json`)) continue;
    const saved = legacyRun(dir, name, names, commands);
    if (!saved) continue;
    seen.add(saved.logName);
    runs.push(saved);
  }
  runs.sort((left, right) => {
    const at = left.startedAt - right.startedAt;
    if (at) return at;
    return left.logName.localeCompare(right.logName);
  });
  return runs;
};

const readLogPair = (root, logName, rawName) => {
  const dir = path.join(root, LOG_DIR);
  const log = fileName(logName);
  const raw = fileName(rawName);
  return {
    output: log ? readText(path.join(dir, log)) : '',
    raw: raw ? readText(path.join(dir, raw)) : '',
  };
};

module.exports = {
  logFileName,
  staleLogFiles,
  removeStaleLogs,
  nextLogFile,
  logText,
  saveLogs,
  readSavedRuns,
  readLogPair,
};
