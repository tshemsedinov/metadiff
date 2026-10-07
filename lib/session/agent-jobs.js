'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { jsonParse, isHashObject } = require('metautil');
const { pad2 } = require('../utilities.js');

const PREFS = '.reslop';
const RUN_KEEP = 40;
const OUTPUT_KEEP = 100000;

const prefsFile = (root) => path.join(root, PREFS);

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
  try {
    fs.writeFileSync(prefsFile(root), `${JSON.stringify(data, null, 2)}\n`);
  } catch {
    // The repo root can be read-only.
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

const elapsedLabel = (job, now = Date.now()) => {
  const start = Number(job && job.startedAt) || 0;
  if (!start) return '';
  const end = job.status === 'running' ? now : Number(job.endedAt) || now;
  const sec = Math.max(0, Math.floor((end - start) / 1000));
  const hours = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const secs = pad2(sec % 60);
  if (hours) return `${hours}:${pad2(mins)}:${secs}`;
  return `${mins}:${secs}`;
};

const textOf = (value, fallback = '') => `${value ?? fallback}`;

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
    this.child = null;
    this.startedAt = fields.startedAt;
    this.endedAt = fields.endedAt;
    this.stopping = false;
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
      startedAt: Date.now(),
      endedAt: 0,
    });
  }

  static restore(item, fallbackId) {
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
      status: textOf(item.status),
      exit: item.exit ?? null,
      output: textOf(item.output),
      startedAt: Number(item.startedAt) || 0,
      endedAt: Number(item.endedAt) || 0,
    });
    if (job.status !== 'running') return job;
    job.status = 'stopped';
    job.output = withNotice(job.output, 'interrupted');
    job.endedAt ||= job.startedAt || Date.now();
    return job;
  }

  elapsed(now = Date.now()) {
    return elapsedLabel(this, now);
  }

  record() {
    return {
      id: this.id,
      cliId: this.cliId,
      name: this.name,
      model: this.model,
      cmd: this.cmd,
      args: this.args,
      command: this.command,
      plan: this.plan,
      action: this.action,
      status: this.status,
      exit: this.exit,
      output: `${this.output ?? ''}`.slice(-OUTPUT_KEEP),
      startedAt: this.startedAt,
      endedAt: this.endedAt,
    };
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
    this.close(exitLabel(result.status), result.status, result.text);
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

module.exports = {
  AgentJob,
  readPrefs,
  writePrefs,
  elapsedLabel,
  launchJob,
  restoreJobs,
  jobRecords,
};
