'use strict';

const fs = require('node:fs');
const path = require('node:path');
const agents = require('../agents.js');
const { detectAgents, emptyChoice, buildLaunch, buildLogin } = agents;
const { mergeModels, listModels, commandLine, startAgent } = agents;
const { needsAuth, planRef } = agents;
const review = require('../review.js');
const { listReviewNames, latestReviewName } = review;
const files = require('../files.js');
const { REVIEW_DIR } = files;
const npm = require('../render/npm.js');
const { logViewRows, expandLogLines } = npm;

const cacheKey = (row) => `${row.id}:${row.bin}`;

const withNotice = (text, notice) => {
  const body = `${text ?? ''}`;
  if (body.endsWith(`${notice}\n`)) return body;
  if (!body) return `${notice}\n`;
  if (body.endsWith('\n')) return `${body}${notice}\n`;
  return `${body}\n${notice}\n`;
};

const exitLabel = (status) => {
  if (status === 0 || status === '0') return 'exit 0';
  if (status === null || status === undefined || status === '') {
    return 'stopped';
  }
  return `exit ${status}`;
};

const logRowCount = (text, width, running) => {
  const visual = width > 0 ? expandLogLines(text, width).length : 0;
  const extra = running ? 1 : 0;
  if (visual) return visual + extra;
  const lines = `${text ?? ''}`.split('\n');
  const count = lines.at(-1) === '' ? lines.length - 1 : lines.length;
  return count + extra;
};

const canLogin = (row) => Boolean(row && row.bin && row.spec && row.spec.login);

class AgentsController {
  constructor(ui) {
    this.ui = ui;
    this.spawn = startAgent;
    this.listModels = listModels;
    this.reset();
  }

  reset() {
    this.killAll();
    this.list = [];
    this.choices = new Map();
    this.loaded = new Map();
    this.modelsEpoch = 0;
    this.jobs = [];
    this.nextId = 1;
    this.viewing = false;
    this.viewId = 0;
    this.followEnd = true;
    this.logScroll = 0;
    this.env = process.env;
    this.refresh();
  }

  killAll() {
    for (const job of this.jobs ?? []) {
      if (job.child) job.child.kill();
    }
  }

  applyCached(row) {
    const cached = this.loaded.get(cacheKey(row));
    if (cached) row.models = cached;
  }

  refresh(env = this.env) {
    this.env = env;
    const prev = this.choices;
    this.list = detectAgents(env);
    this.choices = new Map();
    for (const row of this.list) {
      this.applyCached(row);
      this.choices.set(row.id, prev.get(row.id) ?? emptyChoice(row));
    }
    this.clampCursor();
  }

  clampCursor() {
    const last = Math.max(0, this.rows().length - 1);
    const nav = this.ui.nav;
    nav.agentCursor = Math.max(0, Math.min(nav.agentCursor ?? 0, last));
  }

  selected() {
    return this.rows()[this.ui.nav.agentCursor] ?? null;
  }

  choice(id) {
    let spec = this.list.find((item) => item.id === id);
    if (!spec) {
      const row = this.selected();
      if (row && row.kind === 'cli') {
        spec = this.list.find((item) => item.id === row.id);
      }
    }
    if (!spec) return emptyChoice(null);
    let next = this.choices.get(spec.id);
    if (!next) {
      next = emptyChoice(spec);
      this.choices.set(spec.id, next);
    }
    return next;
  }

  cliStatus(id) {
    for (const job of this.jobs) {
      if (job.cliId === id && job.status === 'running') return 'running';
    }
    return '';
  }

  planLabel() {
    const file = this.planFile();
    if (!file) return '';
    const cwd = this.ui.top || this.ui.cwd;
    return planRef(file, cwd);
  }

  cliRows() {
    const plan = this.planLabel();
    return this.list.map((row) => {
      const picked = this.choice(row.id);
      const levels = row.spec && row.spec.efforts ? row.spec.efforts : [];
      return {
        kind: 'cli',
        ...row,
        model: picked.model,
        effort: picked.effort || 'default',
        efforts: levels,
        extra: picked.extra,
        plan: row.bin ? plan : '',
        status: this.cliStatus(row.id),
        login: canLogin(row),
      };
    });
  }

  jobRows() {
    const rows = [];
    for (let i = this.jobs.length - 1; i >= 0; i--) {
      const job = this.jobs[i];
      const cli = this.cliById(job.cliId);
      rows.push({
        kind: 'job',
        id: job.id,
        cliId: job.cliId,
        name: job.name,
        model: job.model,
        command: job.command,
        status: job.status,
        bin: job.cmd,
        extra: '',
        login: canLogin(cli),
      });
    }
    return rows;
  }

  rows() {
    return this.cliRows();
  }

  jobById(id) {
    return this.jobs.find((job) => job.id === id) ?? null;
  }

  cliById(id) {
    return this.list.find((item) => item.id === id) ?? null;
  }

  viewedJob() {
    return this.jobById(this.viewId);
  }

  runningCount() {
    let count = 0;
    for (const job of this.jobs) {
      if (job.status === 'running') count += 1;
    }
    return count;
  }

  summary() {
    const items = this.cliRows();
    let installed = 0;
    for (const row of items) {
      if (row.bin) installed += 1;
    }
    return {
      ready: true,
      installed,
      total: items.length,
      items,
      running: this.runningCount(),
      jobs: this.jobRows(),
    };
  }

  open() {
    const ui = this.ui;
    this.refresh();
    this.viewing = false;
    ui.nav.pane = 'agents';
    ui.nav.resetListScroll('agents');
    ui.nav.clearSelection();
    ui.status = '';
    return this.loadModels();
  }

  async loadModels() {
    const epoch = this.modelsEpoch + 1;
    this.modelsEpoch = epoch;
    const env = this.env;
    const jobs = [];
    for (const row of this.list) {
      if (!row.bin) continue;
      const key = cacheKey(row);
      if (this.loaded.has(key)) continue;
      jobs.push(this.fetchModels(row, key, epoch, env));
    }
    if (!jobs.length) return;
    await Promise.all(jobs);
    if (epoch !== this.modelsEpoch) return;
    this.ui.paint();
  }

  async fetchModels(row, key, epoch, env) {
    const listed = await this.listModels(row.bin, row.spec, { env }).catch(
      () => [],
    );
    if (epoch !== this.modelsEpoch) return;
    const models = mergeModels(row.spec.models, listed);
    this.loaded.set(key, models);
    const current = this.list.find((item) => item.id === row.id);
    if (current && current.bin === row.bin) current.models = models;
  }

  scrollLog(delta) {
    const job = this.viewedJob();
    const text = job ? job.output : '';
    const running = Boolean(job && job.status === 'running');
    const { lastFrame, lastSize } = this.ui;
    const width = lastSize && lastSize.width ? lastSize.width : 0;
    const count = logRowCount(text, width, running);
    const bodyH = lastFrame && lastFrame.bodyH ? lastFrame.bodyH : 1;
    const max = Math.max(0, count - logViewRows(bodyH));
    const from = this.followEnd ? max : this.logScroll;
    const start = Math.min(max, Math.max(0, from + delta));
    this.followEnd = start === max;
    this.logScroll = start;
  }

  move(delta) {
    if (this.viewing) return void this.scrollLog(delta);
    const last = Math.max(0, this.rows().length - 1);
    const next = this.ui.nav.agentCursor + delta;
    this.ui.nav.agentCursor = Math.max(0, Math.min(last, next));
    this.ui.status = '';
  }

  cycleModel() {
    if (this.viewing) return;
    const row = this.selected();
    if (!row || row.kind !== 'cli' || !row.bin) return;
    const models = row.models;
    if (!models.length) return;
    const picked = this.choice(row.id);
    const at = models.indexOf(picked.model);
    const next = models[(at < 0 ? 0 : at + 1) % models.length];
    picked.model = next;
    this.ui.status = `model ${next}`;
  }

  cycleEffort() {
    if (this.viewing) return;
    const row = this.selected();
    if (!row || row.kind !== 'cli' || !row.bin) return;
    const levels = row.efforts ?? [];
    if (levels.length < 2) return;
    const picked = this.choice(row.id);
    const at = levels.indexOf(picked.effort);
    const next = levels[(at < 0 ? 0 : at + 1) % levels.length];
    picked.effort = next;
    this.ui.status = `effort ${next}`;
  }

  editParams() {
    if (this.viewing) return;
    const row = this.selected();
    if (!row || row.kind !== 'cli' || !row.bin) return;
    const picked = this.choice(row.id);
    this.ui.composer.openCompose('agent', picked.extra);
  }

  finishParams() {
    const ui = this.ui;
    const editor = ui.composer.editor;
    if (!editor) return;
    const row = this.selected();
    if (row && row.kind === 'cli') {
      this.choice(row.id).extra = editor.text.replaceAll('\n', ' ').trim();
    }
    ui.composer.closeCompose();
    ui.status = 'saved';
  }

  latestPlan() {
    const root = this.ui.top || this.ui.cwd;
    const latest = latestReviewName(listReviewNames(root));
    if (!latest) return '';
    return path.join(root, REVIEW_DIR, latest);
  }

  planFile() {
    const store = this.ui.review && this.ui.review.store;
    if (store && store.reviewPath) return store.reviewPath;
    return this.latestPlan();
  }

  ensurePlan() {
    const store = this.ui.review.store;
    if (store && store.reviewPath) {
      if (store.dirty) this.ui.flushReview(true);
      if (fs.existsSync(store.reviewPath)) return store.reviewPath;
      store.dirty = true;
      this.ui.flushReview(true);
      if (fs.existsSync(store.reviewPath)) return store.reviewPath;
    }
    return this.latestPlan();
  }

  launchOf(row) {
    const cwd = this.ui.top || this.ui.cwd;
    return buildLaunch(row, this.choice(row.id), this.ensurePlan(), cwd);
  }

  openView(id) {
    const job = this.jobById(id);
    if (!job) return;
    this.viewing = true;
    this.viewId = id;
    this.followEnd = true;
    this.logScroll = 0;
    this.ui.status = '';
    this.ui.paint();
  }

  closeView() {
    const job = this.viewedJob();
    this.viewing = false;
    const waiting = job && job.action === 'login' && job.status === 'running';
    this.ui.status = waiting ? 'logging in' : '';
    this.ui.paint();
  }

  syncProgress() {
    const live = this.runningCount();
    if (live) this.ui.progress.start('agents');
    else this.ui.progress.stop('agents');
  }

  showOutput(job, text) {
    job.output = text;
    if (!this.viewing || this.viewId !== job.id) {
      if (this.ui.nav.pane === 'agents') this.ui.paint();
      return;
    }
    this.ui.paint();
  }

  finishJob(job, result) {
    const stopped = job.stopping === true;
    const raw = stopped ? withNotice(job.output, 'terminated') : result.text;
    job.output = raw;
    job.exit = stopped ? null : result.status;
    job.status = stopped ? 'stopped' : exitLabel(result.status);
    job.endedAt = Date.now();
    job.stopping = false;
    job.child = null;
    this.syncProgress();
    if (stopped && this.viewing && this.viewId === job.id) {
      this.ui.status = 'stopped';
    } else if (!stopped && job.action === 'login' && result.status === 0) {
      this.ui.status = 'logged in';
    }
    this.ui.paint();
    if (stopped || job.action === 'login' || !needsAuth(raw)) return;
    const cli = this.cliById(job.cliId);
    if (canLogin(cli)) this.startLogin(cli);
  }

  startLaunch(row, launch, model, showLog = true) {
    if (!launch.ok) {
      this.ui.status = launch.error;
      return;
    }
    const job = {
      id: this.nextId,
      cliId: row.id,
      name: launch.name,
      model,
      cmd: launch.cmd,
      args: launch.args,
      command: launch.command || commandLine(launch),
      action: launch.kind || 'run',
      status: 'running',
      exit: null,
      output: '',
      child: null,
      startedAt: Date.now(),
      endedAt: 0,
      stopping: false,
    };
    this.nextId += 1;
    this.jobs.push(job);
    const child = this.spawn(
      this.ui.top || this.ui.cwd,
      launch,
      (text) => this.showOutput(job, text),
      (result) => this.finishJob(job, result),
    );
    if (job.status === 'running') job.child = child;
    this.syncProgress();
    if (showLog && this.jobs.at(-1) === job) this.openView(job.id);
  }

  runningJob(id) {
    for (let i = this.jobs.length - 1; i >= 0; i--) {
      const job = this.jobs[i];
      if (job.cliId === id && job.status === 'running') return job;
    }
    return null;
  }

  startJob(row) {
    const model = this.choice(row.id).model;
    this.startLaunch(row, this.launchOf(row), model);
  }

  liveLogin(id) {
    for (let i = this.jobs.length - 1; i >= 0; i--) {
      const job = this.jobs[i];
      if (job.cliId !== id || job.action !== 'login') continue;
      if (job.status === 'running') return job;
    }
    return null;
  }

  startLogin(row) {
    const live = this.liveLogin(row.id);
    if (!live) this.startLaunch(row, buildLogin(row), '', false);
    if (this.viewing) this.closeView();
    this.ui.status = 'logging in';
    this.ui.paint();
  }

  login() {
    const row = this.selected();
    if (!row) {
      this.ui.status = 'not installed';
      return;
    }
    const cli = row.kind === 'job' ? this.cliById(row.cliId) : row;
    if (!canLogin(cli)) {
      this.ui.status = 'no login';
      return;
    }
    this.startLogin(cli);
  }

  start() {
    const row = this.selected();
    if (!row) {
      this.ui.status = 'not installed';
      return;
    }
    if (row.kind === 'job') return void this.openView(row.id);
    const live = this.runningJob(row.id);
    if (live) return void this.openView(live.id);
    this.startJob(row);
  }

  selectedJob() {
    const row = this.selected();
    if (row && row.kind === 'job') return this.jobById(row.id);
    if (row && row.kind === 'cli') {
      for (let i = this.jobs.length - 1; i >= 0; i--) {
        const job = this.jobs[i];
        if (job.cliId === row.id && job.status === 'running') return job;
      }
    }
    return null;
  }

  stop() {
    const job = this.viewing ? this.viewedJob() : this.selectedJob();
    if (!job || job.status !== 'running' || !job.child) return;
    job.stopping = true;
    job.child.kill();
    if (job.status !== 'running') return;
    job.output = withNotice(job.output, 'terminated');
    job.status = 'stopped';
    job.endedAt = Date.now();
    job.child = null;
    job.stopping = false;
    this.syncProgress();
    this.ui.status = 'stopped';
    this.ui.paint();
  }
}

module.exports = { AgentsController };
