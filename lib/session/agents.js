'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { jsonParse, isHashObject } = require('metautil');
const agents = require('../agents.js');
const { detectAgents, emptyChoice, buildLaunch, buildLogin } = agents;
const { mergeModels, listModels, commandLine, startAgent } = agents;
const { needsAuth, planRef, groupModels, resolveModel } = agents;
const { fitEffort } = agents;
const review = require('../review.js');
const { planNames, parseReview, reviewProgress } = review;
const { frontmatterStatus } = review;
const { REVIEW_DIR } = require('../files.js');
const { logViewRows, expandLogLines } = require('../render/npm.js');

const cacheKey = (row) => `${row.id}:${row.bin}`;

const withNotice = (text, notice) => {
  const body = `${text ?? ''}`;
  if (body.endsWith(`${notice}\n`)) return body;
  if (!body) return `${notice}\n`;
  if (body.endsWith('\n')) return `${body}${notice}\n`;
  return `${body}\n${notice}\n`;
};

const planText = (name, status, done, total) => {
  const word = status || 'editing';
  return `${name}  ${word}  ${done}/${total}`;
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

const concrete = (name) => {
  const text = `${name ?? ''}`.trim();
  if (!text || text === 'default') return '';
  return text;
};

const modelNames = (row) => {
  const names = [];
  for (const item of groupModels(row.models ?? [])) {
    const name = concrete(item.model);
    if (name) names.push(name);
  }
  return names;
};

const specLevels = (row) => {
  if (!row.spec || !row.spec.efforts) return [];
  return row.spec.efforts;
};

const levelList = (row, model) => {
  const resolved = resolveModel(row, {
    model,
    effort: 'default',
    extra: '',
  });
  if (resolved.encoded) return resolved.levels;
  return specLevels(row);
};

const levelsFor = (row, model) =>
  levelList(row, model).filter((level) => concrete(level));

const PREFS = '.reslop';

const prefsFile = (root) => path.join(root, PREFS);

const readPrefs = (root) => {
  try {
    const data = jsonParse(fs.readFileSync(prefsFile(root), 'utf8'));
    if (!isHashObject(data)) return { agents: {} };
    const saved = isHashObject(data.agents) ? data.agents : {};
    return { ...data, agents: saved };
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

const syncChoice = (row, picked) => {
  const resolved = resolveModel(row, picked);
  if (resolved.family !== picked.model) picked.model = resolved.family;
  const levels = resolved.encoded ? resolved.levels : specLevels(row);
  const effort = levels.length ? fitEffort(levels, picked.effort) : '';
  if (effort) picked.effort = effort;
  return { model: picked.model, effort, levels };
};

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
    this.pick = null;
    this.planPath = '';
    this.focus = 'cli';
    this.runCursor = 0;
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
    this.loadChoices();
    this.clampCursor();
  }

  loadChoices() {
    const root = this.ui.top || this.ui.cwd;
    if (!root) return;
    const saved = readPrefs(root).agents;
    for (const row of this.list) {
      const item = saved[row.id];
      if (!isHashObject(item)) continue;
      const picked = this.choice(row.id);
      const model = concrete(item.model);
      const effort = concrete(item.effort);
      if (model) picked.model = model;
      if (effort) picked.effort = effort;
    }
  }

  saveChoice(id) {
    const root = this.ui.top || this.ui.cwd;
    if (!root || !id) return;
    const picked = this.choices.get(id);
    if (!picked) return;
    const data = readPrefs(root);
    const agents = { ...data.agents };
    const next = {};
    const model = concrete(picked.model);
    const effort = concrete(picked.effort);
    if (model) next.model = model;
    if (effort) next.effort = effort;
    if (model || effort) agents[id] = next;
    else delete agents[id];
    writePrefs(root, { ...data, agents });
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

  planFace() {
    const file = this.planFile();
    if (!file) return '';
    const name = path.basename(file);
    const store = this.ui.review && this.ui.review.store;
    if (store && store.reviewPath === file) {
      const status = `${store.status ?? ''}`.trim();
      const progress = reviewProgress(store);
      return planText(name, status, progress.done, progress.total);
    }
    try {
      const text = fs.readFileSync(file, 'utf8');
      const status = frontmatterStatus(text);
      const progress = reviewProgress(parseReview(text, file));
      return planText(name, status, progress.done, progress.total);
    } catch {
      return name;
    }
  }

  cliRows() {
    const plan = this.planFace();
    return this.list.map((row) => {
      const picked = this.choice(row.id);
      const shown = syncChoice(row, picked);
      return {
        kind: 'cli',
        ...row,
        model: concrete(shown.model),
        modelChoices: modelNames(row),
        effort: concrete(shown.effort),
        efforts: levelsFor(row, shown.model),
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

  instanceRows() {
    const cli = this.selected();
    if (!cli || !cli.bin) return [];
    const model = concrete(this.choice(cli.id).model);
    const rows = [];
    for (let i = this.jobs.length - 1; i >= 0; i--) {
      const job = this.jobs[i];
      if (job.cliId !== cli.id) continue;
      if (concrete(job.model) !== model) continue;
      rows.push({
        id: job.id,
        status: job.status,
        command: job.command,
      });
    }
    return rows;
  }

  runs() {
    const rows = this.instanceRows();
    const last = Math.max(0, rows.length - 1);
    if (this.runCursor > last) this.runCursor = last;
    if (this.runCursor < 0) this.runCursor = 0;
    if (!rows.length && this.focus === 'runs') this.focus = 'cli';
    return rows;
  }

  selectedRun() {
    const row = this.runs()[this.runCursor];
    if (!row) return null;
    return this.jobById(row.id);
  }

  focusRuns() {
    if (this.viewing || this.pick) return;
    if (!this.runs().length) return;
    this.focus = 'runs';
  }

  focusCli() {
    this.focus = 'cli';
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
    if (this.pick) {
      this.movePick(delta);
      return;
    }
    if (this.viewing) return void this.scrollLog(delta);
    if (this.focus === 'runs') {
      const last = Math.max(0, this.runs().length - 1);
      const next = this.runCursor + delta;
      this.runCursor = Math.max(0, Math.min(last, next));
      this.ui.status = '';
      return;
    }
    const last = Math.max(0, this.rows().length - 1);
    const next = this.ui.nav.agentCursor + delta;
    this.ui.nav.agentCursor = Math.max(0, Math.min(last, next));
    this.runCursor = 0;
    this.ui.status = '';
  }

  reviewChoices() {
    const root = this.ui.top || this.ui.cwd;
    const labels = planNames(root).map((name) => `${REVIEW_DIR}/${name}`);
    const current = this.planLabel();
    if (current && !labels.includes(current)) labels.unshift(current);
    return labels;
  }

  menuItems() {
    if (!this.pick) return [];
    const row = this.selected();
    let all = [];
    if (this.pick.field === 'plan') all = this.reviewChoices();
    else if (row && this.pick.field === 'model') all = modelNames(row);
    else if (row) all = levelsFor(row, this.choice(row.id).model);
    const query = this.pick.query.trim().toLowerCase();
    if (!query) return all;
    const matched = [];
    for (const name of all) {
      if (name.toLowerCase().includes(query)) matched.push(name);
    }
    return matched;
  }

  menuPage(fraction = 1) {
    const body = this.ui.lastFrame && this.ui.lastFrame.bodyH;
    const height = Math.min(body > 0 ? body : 8, 8);
    return Math.max(1, Math.floor(height * fraction));
  }

  movePick(delta) {
    const count = this.menuItems().length;
    if (!count || !this.pick) return;
    const last = count - 1;
    const next = this.pick.cursor + delta;
    this.pick.cursor = Math.max(0, Math.min(last, next));
  }

  dismissPick() {
    this.pick = null;
  }

  closePick() {
    if (!this.pick) return;
    this.dismissPick();
    this.ui.status = '';
    this.ui.paint();
  }

  editQuery(query) {
    this.pick.query = query;
    this.pick.cursor = 0;
    this.pick.scroll = 0;
    this.ui.status = query;
    this.ui.paint();
  }

  openPick(field) {
    if (this.viewing) return;
    if (this.pick && this.pick.field === field) {
      this.closePick();
      return;
    }
    const row = this.selected();
    if (!row || row.kind !== 'cli' || !row.bin) return;
    const picked = this.choice(row.id);
    syncChoice(row, picked);
    const names = modelNames(row);
    let items = levelsFor(row, picked.model);
    let current = picked.effort;
    if (field === 'model') {
      items = names;
      current = picked.model;
    } else if (field === 'plan') {
      items = this.reviewChoices();
      current = this.planLabel();
    }
    if (items.length < 2) return;
    const at = items.indexOf(current);
    this.pick = { field, cursor: at < 0 ? 0 : at, query: '', scroll: 0 };
    this.ui.status = '';
    this.ui.paint();
  }

  openModel() {
    this.openPick('model');
  }

  openEffort() {
    this.openPick('effort');
  }

  openReview() {
    this.openPick('plan');
  }

  acceptPick() {
    const pick = this.pick;
    if (!pick) return;
    const row = this.selected();
    const items = this.menuItems();
    const at = Math.min(pick.cursor, Math.max(0, items.length - 1));
    const value = items[at];
    this.dismissPick();
    if (!row || !value) {
      this.ui.status = '';
      this.ui.paint();
      return;
    }
    const picked = this.choice(row.id);
    if (pick.field === 'model') {
      picked.model = value;
      picked.effort = fitEffort(levelList(row, value), picked.effort);
      this.ui.status = `model ${value}`;
    } else if (pick.field === 'plan') {
      const root = this.ui.top || this.ui.cwd;
      const rel = value.split('/').join(path.sep);
      this.planPath = path.resolve(root, rel);
      this.ui.status = `plan ${value}`;
    } else {
      picked.effort = value;
      this.ui.status = `effort ${value}`;
    }
    if (pick.field === 'model' || pick.field === 'effort') {
      this.saveChoice(row.id);
    }
    this.ui.paint();
  }

  onPickKey(key) {
    if (!this.pick) return;
    if (key === 'escape') {
      this.closePick();
      return;
    }
    if (key === 'enter') {
      this.acceptPick();
      return;
    }
    if (key === 'backspace') {
      this.editQuery(this.pick.query.slice(0, -1));
      return;
    }
    const page = this.menuPage();
    const half = this.menuPage(0.5);
    const step = {
      up: -1,
      down: 1,
      j: 1,
      k: -1,
      pageUp: -page,
      pageDown: page,
      'ctrl-b': -page,
      'ctrl-f': page,
      'ctrl-u': -half,
      'ctrl-d': half,
      home: -1e9,
      end: 1e9,
    };
    const typing = this.pick.query && (key === 'j' || key === 'k');
    if (Object.hasOwn(step, key) && !typing) {
      this.movePick(step[key]);
      return;
    }
    if (key.length === 1 && key > ' ') {
      this.editQuery(this.pick.query + key);
    }
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
    const latest = planNames(root)[0];
    if (!latest) return '';
    return path.join(root, REVIEW_DIR, latest);
  }

  planFile() {
    if (this.planPath && fs.existsSync(this.planPath)) return this.planPath;
    const store = this.ui.review && this.ui.review.store;
    if (store && store.reviewPath) return store.reviewPath;
    return this.latestPlan();
  }

  ensurePlan() {
    const store = this.ui.review.store;
    const chosen = this.planPath;
    if (chosen && store && store.reviewPath === chosen && store.dirty) {
      this.ui.flushReview(true);
    }
    if (chosen && fs.existsSync(chosen)) return chosen;
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
    if (this.pick) {
      this.acceptPick();
      return;
    }
    if (this.focus === 'runs') {
      const job = this.selectedRun();
      if (job) this.openView(job.id);
      return;
    }
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
    if (this.focus === 'runs') return this.selectedRun();
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
