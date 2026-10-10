'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { jsonParse, isHashObject } = require('metautil');
const { pad2 } = require('../utilities.js');
const { THEME_NAMES } = require('../ansi.js');
const { REVIEW_DIR } = require('../files.js');
const { logText, nextLogFile } = require('../npm-commands.js');

const PREFS = '.reslop';
const LAYOUT_LABEL = {
  unified: 'unified',
  mixed: 'mixed',
  side: 'side-by-side',
};
const LAYOUT_VALUE = {
  unified: 'unified',
  mixed: 'mixed',
  'side-by-side': 'side',
};
const LOG_DIR = '.log';
const RUNS_FILE = '.runs';
const SESSIONS_FILE = '.sessions';
const RUN_KEEP = 40;
const OUTPUT_KEEP = 100000;
const AGENT_JSON = /-agent-\d+\.json$/;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SESSION_MARK = new RegExp(`--resume[= ](${UUID})`, 'gi');
const FILES_MARK = /(\d[\d,]*)\s+files?\s+(?:edited|changed|modified)/gi;

const tokenPattern = (name) => {
  const word = `${name}[_ -]?tokens?`;
  const json = `"${name}_tokens"`;
  const body = `(?:${word}|${json})\\s*[:=]\\s*"?(\\d[\\d,]*)`;
  return new RegExp(body, 'gi');
};

const TOTAL_TOKEN = tokenPattern('total');
const INPUT_TOKEN = tokenPattern('input');
const OUTPUT_TOKEN = tokenPattern('output');

const prefsFile = (root) => path.join(root, PREFS);

const planPath = (root, name) => path.join(root, REVIEW_DIR, name);

const readPrefs = (root) => {
  try {
    const data = jsonParse(fs.readFileSync(prefsFile(root), 'utf8'));
    if (!isHashObject(data)) return { agents: {} };
    const agents = isHashObject(data.agents) ? data.agents : {};
    return { ...data, agents };
  } catch {
    return { agents: {} };
  }
};

const writePrefs = (root, data) => {
  const stored = { ...data };
  delete stored.runs;
  try {
    fs.writeFileSync(prefsFile(root), `${JSON.stringify(stored, null, 2)}\n`);
  } catch {
    // The repo root can be read-only.
  }
};

const section = (data, name) => {
  const value = data[name];
  if (!isHashObject(value)) return {};
  return { ...value };
};

const readUiPrefs = (root) => {
  const data = readPrefs(root);
  const editor = section(data, 'editor');
  const general = section(data, 'general');
  const commits = section(data, 'commits');
  let lineNumbers = false;
  if (typeof editor.lineNumbers === 'boolean') {
    lineNumbers = editor.lineNumbers;
  } else if (typeof data.lineNumbers === 'boolean') {
    lineNumbers = data.lineNumbers;
  }
  const layout = LAYOUT_VALUE[editor.mode] || 'unified';
  const theme = THEME_NAMES.includes(general.theme) ? general.theme : 'dark';
  const commitView = commits.view === 'full' ? 'full' : 'brief';
  return { lineNumbers, layout, theme, commitView };
};

const saveUiPrefs = (root, patch) => {
  if (!root) return;
  const data = readPrefs(root);
  const editor = section(data, 'editor');
  const legacy = typeof data.lineNumbers === 'boolean';
  if (legacy && editor.lineNumbers === undefined) {
    editor.lineNumbers = data.lineNumbers;
  }
  delete data.lineNumbers;
  if (patch.lineNumbers !== undefined) {
    editor.lineNumbers = patch.lineNumbers === true;
  }
  if (patch.layout) editor.mode = LAYOUT_LABEL[patch.layout] || 'unified';
  const next = { ...data, editor };
  if (patch.theme) {
    const general = section(data, 'general');
    general.theme = patch.theme;
    next.general = general;
  }
  if (patch.commitView) {
    const commits = section(data, 'commits');
    const full = patch.commitView === 'full';
    commits.view = full ? 'full' : 'brief';
    next.commits = commits;
  }
  writePrefs(root, next);
};

const readStored = (file) => {
  try {
    return jsonParse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const writeStored = (file, data) => {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  } catch {
    // The plan directory can be read-only.
  }
};

const withNotice = (text, notice) => {
  const body = `${text ?? ''}`;
  if (body.endsWith(`${notice}\n`)) return body;
  if (!body || body.endsWith('\n')) return `${body}${notice}\n`;
  return `${body}\n${notice}\n`;
};

const exitLabel = (status) => {
  if (status === null || status === undefined || status === '') {
    return 'stopped';
  }
  return `exit ${status}`;
};

const elapsedSeconds = (job, now = Date.now()) => {
  const start = Number(job && job.startedAt) || 0;
  if (!start) return 0;
  const end = job.status === 'running' ? now : Number(job.endedAt) || now;
  return Math.max(0, Math.floor((end - start) / 1000));
};

const elapsedLabel = (job, now = Date.now()) => {
  const start = Number(job && job.startedAt) || 0;
  if (!start) return '';
  const sec = elapsedSeconds(job, now);
  const hours = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const secs = pad2(sec % 60);
  if (hours) return `${hours}:${pad2(mins)}:${secs}`;
  return `${mins}:${secs}`;
};

const textOf = (value, fallback = '') => `${value ?? fallback}`;

const countOf = (value) => {
  const raw = `${value ?? ''}`.replaceAll(',', '');
  const number = Number(raw);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.floor(number);
};

const countField = (value) => {
  if (value === undefined || value === null || value === '') return null;
  return countOf(value);
};

const lastCount = (text, re) => {
  re.lastIndex = 0;
  let found = null;
  for (const match of `${text ?? ''}`.matchAll(re)) {
    const count = countOf(match[1]);
    if (count !== null) found = count;
  }
  return found;
};

const sessionOf = (text) => {
  SESSION_MARK.lastIndex = 0;
  let found = '';
  for (const match of `${text ?? ''}`.matchAll(SESSION_MARK)) found = match[1];
  return found;
};

const tokensOf = (text) => {
  const total = lastCount(text, TOTAL_TOKEN);
  if (total !== null) return total;
  const input = lastCount(text, INPUT_TOKEN);
  const output = lastCount(text, OUTPUT_TOKEN);
  if (input === null && output === null) return null;
  return (input ?? 0) + (output ?? 0);
};

const runStats = (text) => {
  const stats = {};
  const session = sessionOf(text);
  const files = lastCount(text, FILES_MARK);
  const tokens = tokensOf(text);
  if (session) stats.session = session;
  if (files !== null) stats.files = files;
  if (tokens !== null) stats.tokens = tokens;
  return stats;
};

const restoredState = (item) => {
  if (item.running === true || item.status === 'running') {
    return { status: 'running', exit: null };
  }
  if (item.stopped === true || item.status === 'stopped') {
    return { status: 'stopped', exit: null };
  }
  if (typeof item.exit === 'number') {
    return { status: `exit ${item.exit}`, exit: item.exit };
  }
  const status = textOf(item.status);
  const code = status.startsWith('exit ') ? Number(status.slice(5)) : NaN;
  if (Number.isFinite(code)) return { status, exit: code };
  return { status: status || 'stopped', exit: null };
};

const outcome = (job) => {
  if (job.status === 'running') return { running: true };
  if (typeof job.exit === 'number') return { exit: job.exit };
  return { stopped: true };
};

const applyElapsed = (job, item) => {
  if (job.endedAt || !job.startedAt) return;
  const elapsed = Number(item.elapsed);
  if (!Number.isFinite(elapsed)) return;
  job.endedAt = job.startedAt + elapsed * 1000;
};

const readLog = (root, name) => {
  if (!root || !name) return '';
  try {
    return fs.readFileSync(path.join(root, LOG_DIR, name), 'utf8');
  } catch {
    return '';
  }
};

class AgentJob {
  constructor(fields) {
    this.id = fields.id;
    this.cliId = fields.cliId;
    this.name = fields.name;
    this.model = fields.model;
    this.cmd = fields.cmd;
    this.args = fields.args;
    this.command = fields.command;
    this.plan = fields.plan;
    this.action = fields.action;
    this.status = fields.status;
    this.exit = fields.exit;
    this.output = fields.output;
    this.session = textOf(fields.session);
    this.files = countField(fields.files);
    this.tokens = countField(fields.tokens);
    this.child = null;
    this.startedAt = fields.startedAt;
    this.endedAt = fields.endedAt;
    this.stopping = false;
    this.pty = fields.pty === true;
    this.pending = '';
    this.worked = false;
    this.closing = false;
    this.transcript = '';
    this.logName = textOf(fields.logName);
    this.rawName = textOf(fields.rawName);
    this.rawText = textOf(fields.rawText);
    this.held = fields.held === true;
    this.dirty = fields.dirty === true;
    this.loggedAt = 0;
  }

  static launch(id, launch, model) {
    return new AgentJob({
      id,
      cliId: launch.id,
      name: launch.name,
      model,
      cmd: launch.cmd,
      args: launch.args,
      command: launch.command,
      plan: launch.plan,
      action: launch.kind,
      status: 'running',
      exit: null,
      output: '',
      session: launch.session,
      startedAt: Date.now(),
      endedAt: 0,
      pty: launch.pty === true,
      dirty: true,
    });
  }

  static restore(item, fallbackId) {
    const state = restoredState(item);
    const inline = textOf(item.output);
    const job = new AgentJob({
      id: Number(item.id) || fallbackId,
      cliId: textOf(item.cliId),
      name: textOf(item.name),
      model: textOf(item.model),
      cmd: textOf(item.cmd),
      args: Array.isArray(item.args) ? item.args : [],
      command: textOf(item.command),
      plan: textOf(item.plan),
      action: textOf(item.action, 'run'),
      status: state.status,
      exit: state.exit,
      output: inline,
      logName: item.log,
      rawName: item.raw,
      held: !inline,
      dirty: Boolean(inline),
      session: item.session,
      files: item.files,
      tokens: item.tokens,
      startedAt: Number(item.startedAt) || 0,
      endedAt: Number(item.endedAt) || 0,
    });
    if (state.status !== 'running') applyElapsed(job, item);
    if (job.status !== 'running') return job;
    job.status = 'stopped';
    job.output = withNotice(job.output, 'interrupted');
    job.endedAt ||= job.startedAt || Date.now();
    return job;
  }

  elapsed(now = Date.now()) {
    return elapsedLabel(this, now);
  }

  captureStats() {
    const stats = runStats(this.output);
    if (stats.session) this.session = stats.session;
    if (typeof stats.files === 'number') this.files = stats.files;
    if (typeof stats.tokens === 'number') this.tokens = stats.tokens;
  }

  record() {
    this.captureStats();
    const saved = {
      id: this.id,
      cliId: this.cliId,
      name: this.name,
      model: this.model,
      cmd: this.cmd,
      args: this.args,
      command: this.command,
      plan: this.plan,
      action: this.action,
      ...outcome(this),
      elapsed: elapsedSeconds(this),
      startedAt: this.startedAt,
    };
    if (this.logName) saved.log = this.logName;
    if (this.rawName) saved.raw = this.rawName;
    if (this.session) saved.session = this.session;
    if (typeof this.files === 'number') saved.files = this.files;
    return saved;
  }

  close(status, exit, output) {
    this.status = status;
    this.exit = exit;
    this.output = output;
    this.endedAt = Date.now();
    this.child = null;
    this.stopping = false;
  }

  stop() {
    this.close('stopped', null, withNotice(this.output, 'terminated'));
  }

  finish(result) {
    const note = this.transcript ? `${this.transcript}\n` : '';
    const text = `${note}${result.text ?? ''}`;
    this.close(exitLabel(result.status), result.status, text);
  }
}

const launchJob = (id, launch, model) => AgentJob.launch(id, launch, model);

const restoreJobs = (saved) => {
  const jobs = [];
  let nextId = 1;
  for (const item of Array.isArray(saved) ? saved : []) {
    if (!isHashObject(item)) continue;
    const job = AgentJob.restore(item, nextId);
    nextId = Math.max(nextId, job.id + 1);
    jobs.push(job);
  }
  return { jobs, nextId };
};

const jobRecords = (jobs) => jobs.slice(-RUN_KEEP).map((job) => job.record());

const logNames = (root) => {
  try {
    return fs.readdirSync(path.join(root, LOG_DIR));
  } catch {
    return [];
  }
};

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
  const raw = clipped.endsWith('\n') || !clipped ? clipped : `${clipped}\n`;
  writeText(path.join(dir, job.logName), logText(plain));
  writeText(path.join(dir, job.rawName), raw);
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
    const item = readStored(path.join(dir, name));
    if (isHashObject(item)) items.push(item);
  }
  items.sort(byStart);
  return items;
};

const legacyItems = (root) => {
  const planFile = planPath(root, RUNS_FILE);
  const fromPlan = readStored(planFile);
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
  const saved = readStored(planPath(root, SESSIONS_FILE));
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
  AgentJob,
  readPrefs,
  writePrefs,
  readUiPrefs,
  saveUiPrefs,
  LAYOUT_LABEL,
  elapsedLabel,
  launchJob,
  restoreJobs,
  jobRecords,
  runStats,
  stemOf,
  readRunText,
  orderedSessions,
  runBlock,
  replayLaunch,
  closeFinished,
  listSessions,
  panelSessions,
  runningJobs,
  withLiveRuns,
  saveRunFiles,
  readRunList,
};
