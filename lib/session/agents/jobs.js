'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isHashObject } = require('metautil');
const { withNewline, listDir, readJson } = require('../../common/utilities.js');
const { logText, nextLogFile } = require('../../runs/logs.js');
const jobPart = require('./job.js');
const { OUTPUT_KEEP, readLog, textOf } = jobPart;
const { elapsedLabel, RUN_KEEP, restoreJobs, launchJob } = jobPart;
const { runStats } = jobPart;
const prefsPart = require('../prefs.js');
const { planPath, readPrefs, writePrefs } = prefsPart;
const { writeStored } = prefsPart;
const { LOG_DIR } = require('../../common/files.js');

const RUNS_FILE = '.runs';

const SESSIONS_FILE = '.sessions';

const AGENT_JSON = /-agent-\d+\.json$/;

const logNames = (root) => listDir(path.join(root, LOG_DIR));

const agentJsonNames = (root) =>
  logNames(root)
    .filter((name) => AGENT_JSON.test(name))
    .sort();

const jsonNameOf = (job) =>
  job.logName ? job.logName.replace(/\.log$/, '.json') : '';

const writeText = (file, text) => {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  } catch {
    // the log directory can be read-only
  }
};

const assignLog = (root, job) => {
  if (!root || job.logName) return;
  const when = Number(job.startedAt) || Date.now();
  try {
    const slot = nextLogFile(root, 'agent', new Date(when));
    job.logName = slot.name;
    job.rawName = slot.rawName;
  } catch {
    // the log directory can be unusable
  }
};

const stemOf = (name) => {
  const file = `${name ?? ''}`;
  if (file.endsWith('.log') || file.endsWith('.raw')) {
    return file.replace(/\.(?:log|raw)$/, '');
  }
  return file;
};

const writeJob = (root, job) => {
  if (!job.logName) return;
  const dir = path.join(root, LOG_DIR);
  const record = job.record();
  const json = `${JSON.stringify(record, null, 2)}\n`;
  writeText(path.join(dir, jsonNameOf(job)), json);
  if (job.held && !job.dirty) return;
  const plain = `${job.output ?? ''}`.slice(-OUTPUT_KEEP);
  const source = job.rawText ? job.rawText : plain;
  const clipped = `${source}`.slice(-OUTPUT_KEEP);
  writeText(path.join(dir, job.logName), logText(plain));
  writeText(path.join(dir, job.rawName), withNewline(clipped));
  job.held = true;
  job.dirty = false;
};

const readRunText = (root, job) => {
  const raw = readLog(root, job && job.rawName);
  if (raw) return raw;
  return readLog(root, job && job.logName);
};

const orderedSessions = (jobs, id) => {
  const runs = jobs.filter((job) => job.session === id);
  runs.sort((left, right) => {
    const at = (left.startedAt || 0) - (right.startedAt || 0);
    if (at) return at;
    return left.id - right.id;
  });
  return runs;
};

const runBlock = (root, job) => {
  const stem = stemOf(job.logName);
  const body = readRunText(root, job).replace(/\n$/, '');
  if (!stem) return body;
  if (!body) return stem;
  return `${stem}\n${body}`;
};

const replayLaunch = (job) => ({
  ok: true,
  cmd: job.cmd,
  args: job.args.slice(),
  prompt: '',
  plan: job.plan,
  id: job.cliId,
  name: job.name,
  kind: job.action || 'run',
  command: job.command,
  pty: job.pty === true,
  session: job.session,
});

const closeFinished = (job) => {
  if (job.action !== 'run' || job.pending !== 'idle' || !job.worked) return;
  if (job.closing || !job.child || !job.child.write) return;
  job.closing = true;
  job.child.write('\x04');
};

const pruneAgent = (root, jobs) => {
  const keep = new Set();
  for (const job of jobs) {
    const name = jsonNameOf(job);
    if (name) keep.add(name);
  }
  if (!keep.size) return;
  const dir = path.join(root, LOG_DIR);
  for (const name of agentJsonNames(root)) {
    if (keep.has(name)) continue;
    const stem = name.replace(/\.json$/, '');
    for (const suffix of ['.json', '.log', '.raw']) {
      fs.rmSync(path.join(dir, `${stem}${suffix}`), { force: true });
    }
  }
};

const byStart = (left, right) => {
  const start = (Number(left.startedAt) || 0) - (Number(right.startedAt) || 0);
  if (start) return start;
  return (Number(left.id) || 0) - (Number(right.id) || 0);
};

const readAgentItems = (root) => {
  const items = [];
  const dir = path.join(root, LOG_DIR);
  for (const name of agentJsonNames(root)) {
    const item = readJson(path.join(dir, name));
    if (isHashObject(item)) items.push(item);
  }
  items.sort(byStart);
  return items;
};

const legacyItems = (root) => {
  const planFile = planPath(root, RUNS_FILE);
  const fromPlan = readJson(planFile);
  const prefs = readPrefs(root);
  if (Array.isArray(fromPlan)) return { items: fromPlan, planFile, prefs };
  if (!Array.isArray(prefs.runs)) return null;
  return { items: prefs.runs, planFile: '', prefs };
};

const dropLegacy = (found, root) => {
  if (found.planFile) fs.rmSync(found.planFile, { force: true });
  if (found.prefs.runs) writePrefs(root, found.prefs);
};

const readSessions = (root) => {
  const saved = readJson(planPath(root, SESSIONS_FILE));
  return isHashObject(saved) ? saved : {};
};

const sessionEntry = (prev, job) => {
  const prior = isHashObject(prev) ? prev : {};
  const entry = { cli: job.cliId || prior.cli || '' };
  const name = stemOf(job.logName) || prior.name || '';
  const startedAt = Number(job.startedAt) || Number(prior.startedAt) || 0;
  const files = typeof job.files === 'number' ? job.files : prior.files;
  const tokens = typeof job.tokens === 'number' ? job.tokens : prior.tokens;
  if (name) entry.name = name;
  if (startedAt) entry.startedAt = startedAt;
  if (typeof files === 'number') entry.files = files;
  if (typeof tokens === 'number') entry.tokens = tokens;
  return entry;
};

const listSessions = (root, jobs, cliId) => {
  const saved = readSessions(root);
  const rows = new Map();
  for (const [id, entry] of Object.entries(saved)) {
    if (!isHashObject(entry) || entry.cli !== cliId) continue;
    rows.set(id, {
      id,
      name: textOf(entry.name),
      startedAt: Number(entry.startedAt) || 0,
    });
  }
  for (const job of jobs) {
    if (job.cliId !== cliId || !job.session) continue;
    const blank = { id: job.session, name: '', startedAt: 0 };
    const prev = rows.get(job.session) || blank;
    const stem = stemOf(job.logName);
    const at = Number(job.startedAt) || 0;
    if (at >= prev.startedAt) {
      prev.startedAt = at;
      if (stem) prev.name = stem;
    } else if (!prev.name && stem) {
      prev.name = stem;
    }
    rows.set(job.session, prev);
  }
  const list = [...rows.values()];
  list.sort((left, right) => {
    const at = right.startedAt - left.startedAt;
    if (at) return at;
    return right.name.localeCompare(left.name);
  });
  return list;
};

const panelSessions = (root, jobs, cliId) => {
  const found = cliId ? listSessions(root, jobs, cliId) : [];
  const rows = [{ id: '', name: '<new session>', fresh: true }];
  for (const session of found) {
    rows.push({
      id: session.id,
      name: session.name || session.id,
      session: true,
    });
  }
  return rows;
};

const runningJobs = (jobs, cliId) => {
  const runs = [];
  for (const job of jobs) {
    if (job.cliId !== cliId || job.status !== 'running') continue;
    if (job.action === 'login') continue;
    runs.push(job);
  }
  return runs;
};

const liveRun = (job, progress) => {
  const stem = stemOf(job.logName);
  const command = stem || job.command || job.name;
  return {
    id: job.session || '',
    jobId: job.id,
    name: command,
    status: job.status,
    elapsed: elapsedLabel(job),
    progress,
    command,
  };
};

const withLiveRuns = (saved, running, progressOf) => {
  const rows = saved.slice();
  for (const job of running) {
    if (!job.session) continue;
    const at = rows.findIndex((row) => row.id === job.session);
    if (at < 0) continue;
    rows[at] = liveRun(job, progressOf(job));
  }
  const pending = [];
  for (const job of running) {
    const shown = rows.some((row) => row.jobId === job.id);
    if (!shown) pending.push(job);
  }
  pending.sort((left, right) => right.id - left.id);
  if (!pending.length) return rows;
  const added = pending.map((job) => liveRun(job, progressOf(job)));
  return [...rows.slice(0, 1), ...added, ...rows.slice(1)];
};

const mergeSessions = (saved, jobs) => {
  const sessions = { ...saved };
  for (const job of jobs) {
    if (!job.session) continue;
    sessions[job.session] = sessionEntry(sessions[job.session], job);
  }
  return sessions;
};

const saveRunFiles = (root, jobs) => {
  const kept = jobs.slice(-RUN_KEEP);
  for (const job of kept) {
    assignLog(root, job);
    writeJob(root, job);
  }
  pruneAgent(root, kept);
  const sessions = mergeSessions(readSessions(root), jobs);
  const file = planPath(root, SESSIONS_FILE);
  const keep = Object.keys(sessions).length > 0 || fs.existsSync(file);
  if (keep) writeStored(file, sessions);
  const prefs = readPrefs(root);
  if (prefs.runs) writePrefs(root, prefs);
};

const migrateLegacy = (root) => {
  const found = legacyItems(root);
  if (!found) return;
  if (found.items.length) {
    const restored = restoreJobs(found.items);
    saveRunFiles(root, restored.jobs);
  }
  dropLegacy(found, root);
};

const readRunList = (root) => {
  migrateLegacy(root);
  return readAgentItems(root);
};

module.exports = {
  elapsedLabel,
  launchJob,
  restoreJobs,
  runStats,
  orderedSessions,
  runBlock,
  replayLaunch,
  closeFinished,
  panelSessions,
  runningJobs,
  withLiveRuns,
  saveRunFiles,
  readRunList,
};
