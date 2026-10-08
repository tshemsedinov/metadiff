'use strict';

const fs = require('node:fs');
const path = require('node:path');
const agents = require('../agents.js');
const {
  detectAgents,
  canLogin,
  listedOf,
  listModels,
  startAgent,
  buildLaunch,
  buildLogin,
  needsAuth,
  probeAuth,
  emptyChoice,
  mergeModels,
  hasAgentSession,
} = agents;
const review = require('../review.js');
const { latestReviewName, listReviewNames, planFileNames } = review;
const { REVIEW_DIR } = require('../files.js');
const { logViewRows, expandLogLines } = require('../render/npm.js');
const options = require('./agent-options.js');
const { AgentOptions, concrete, restoreChoice, storedChoice } = options;
const jobs = require('./agent-jobs.js');
const { readPrefs, writePrefs, elapsedLabel, launchJob } = jobs;
const { restoreJobs, readRunList, saveRunFiles } = jobs;
const plans = require('./agent-plans.js');
const { planKey, planProgress, planPart, planLabel, alignPlanLabels } = plans;
const termScreen = require('../term-screen.js');
const { pendingKind, pendingHint, answerBytes, agentBusy } = termScreen;
const { requestTitle, remembersAnswer, permissionTokens } = termScreen;
const { rememberedTokens } = termScreen;
const allow = require('../agent-allow.js');
const { cursorConfigPath, ensureAllows } = allow;

const optionsOf = (row) => new AgentOptions(row);

const priorSession = (jobs, id) => {
  const prior = jobs.findLast((job) => job.cliId === id && job.session);
  return prior ? prior.session : '';
};

const APPLY_FIELD = {
  model: (choices, picked, value) => choices.pickModel(picked, value),
  context: (choices, picked, value) => choices.pickContext(picked, value),
  effort: (choices, picked, value) => {
    picked.effort = value;
  },
};

const MENU_ROWS = 8;
const NEVER = () => false;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const lastIndex = (list) => Math.max(0, list.length - 1);

const cacheKey = (row) => `${row.id}:${row.bin}`;

const listQuietly = async (list, row, env) => {
  try {
    return await list(row.bin, row.spec, { env });
  } catch {
    return null;
  }
};

const logRowCount = (text, width, running) => {
  const extra = running ? 1 : 0;
  const visual = width > 0 ? expandLogLines(text, width).length : 0;
  if (visual) return visual + extra;
  const lines = `${text ?? ''}`.split('\n');
  const count = lines.at(-1) === '' ? lines.length - 1 : lines.length;
  return count + extra;
};

const firstEnabled = (items, at, isOff) => {
  if (!isOff(items[at])) return at;
  const free = items.findIndex((item) => !isOff(item));
  return free < 0 ? at : free;
};

class MenuPick {
  constructor(field, cursor) {
    this.field = field;
    this.cursor = cursor;
    this.query = '';
    this.scroll = 0;
  }

  filter(items) {
    const query = this.query.trim().toLowerCase();
    if (!query) return items;
    return items.filter((name) => name.toLowerCase().includes(query));
  }

  edit(query) {
    this.query = query;
    this.cursor = 0;
    this.scroll = 0;
  }

  move(delta, items, isOff) {
    const last = items.length - 1;
    const step = delta < 0 ? -1 : 1;
    const goal = clamp(this.cursor + delta, 0, last);
    let cursor = this.cursor;
    for (let next = cursor; next !== goal;) {
      next += step;
      if (!isOff(items[next])) cursor = next;
    }
    if (isOff(items[cursor])) {
      let scan = goal;
      while (scan >= 0 && scan <= last && isOff(items[scan])) scan += step;
      if (scan >= 0 && scan <= last) cursor = scan;
    }
    this.cursor = cursor;
  }
}

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

// --single-turn exits only with --print, and --print denies approvals.
const closeFinished = (job) => {
  if (job.action !== 'run' || job.pending !== 'idle' || !job.worked) return;
  if (job.closing || !job.child || !job.child.write) return;
  job.closing = true;
  job.child.write('\x04');
};

class AgentsController {
  constructor(ui) {
    this.ui = ui;
    this.spawn = startAgent;
    this.listModels = listModels;
    this.sessionKnown = hasAgentSession;
    this.authProbe = probeAuth;
    this.reset();
  }

  get root() {
    return this.ui.top || this.ui.cwd;
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
    this.runScroll = 0;
    this.followEnd = true;
    this.logScroll = 0;
    this.pendingStart = null;
    this.authYes = new Set();
    this.authWait = '';
    this.env = process.env;
    this.refresh();
    this.loadRuns();
  }

  killAll() {
    for (const job of this.jobs ?? []) {
      if (job.child) job.child.kill();
    }
  }

  reviewStore() {
    return this.ui.review ? this.ui.review.store : null;
  }

  applyCached(row) {
    const cached = this.loaded.get(cacheKey(row));
    if (!cached) return;
    row.models = cached.models;
    row.wide = cached.wide;
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
    if (!this.root) return;
    const saved = readPrefs(this.root).agents;
    for (const row of this.list) {
      const picked = this.choice(row.id);
      restoreChoice(picked, saved[row.id]);
      optionsOf(row).preferEffort(picked, 'medium');
    }
  }

  saveChoice(id) {
    const picked = this.choices.get(id);
    if (!this.root || !picked) return;
    const data = readPrefs(this.root);
    const saved = { ...data.agents };
    const stored = storedChoice(picked);
    if (stored) saved[id] = stored;
    else delete saved[id];
    writePrefs(this.root, { ...data, agents: saved });
  }

  loadRuns() {
    if (!this.root) return;
    const restored = restoreJobs(readRunList(this.root), this.root);
    this.jobs = restored.jobs;
    this.nextId = restored.nextId;
  }

  saveRuns() {
    if (!this.root) return;
    saveRunFiles(this.root, this.jobs);
  }

  clampCursor() {
    const nav = this.ui.nav;
    nav.agentCursor = clamp(nav.agentCursor ?? 0, 0, lastIndex(this.list));
  }

  selected() {
    return this.list[this.ui.nav.agentCursor] ?? null;
  }

  cliById(id) {
    return this.list.find((row) => row.id === id) ?? null;
  }

  choice(id) {
    const row = this.cliById(id);
    if (!row) return emptyChoice(null);
    if (!this.choices.has(id)) this.choices.set(id, emptyChoice(row));
    return this.choices.get(id);
  }

  rows() {
    const plan = this.planFace();
    const planBusy = this.planBusy(this.planFile());
    return this.list.map((row) => {
      const picked = this.choice(row.id);
      const choices = optionsOf(row);
      const model = choices.normalize(picked);
      return {
        ...row,
        model,
        effort: concrete(picked.effort),
        efforts: choices.efforts(picked.model),
        fast: picked.fast ? 'on' : 'off',
        context: concrete(picked.context),
        contexts: choices.contexts(model),
        plan: row.bin ? plan : '',
        planBusy: Boolean(row.bin && planBusy),
      };
    });
  }

  runs() {
    const cli = this.selected();
    const rows = cli && cli.bin ? this.runRows(cli) : [];
    this.runCursor = clamp(this.runCursor, 0, lastIndex(rows));
    return rows;
  }

  runRows(cli) {
    const store = this.reviewStore();
    const progress = new Map();
    const progressOf = (plan) => {
      if (!progress.has(plan)) {
        progress.set(plan, planProgress(plan, this.root, store));
      }
      return progress.get(plan);
    };
    const own = (job) => job.cliId === cli.id;
    return this.jobs
      .filter(own)
      .reverse()
      .map((job) => ({
        id: job.id,
        status: job.status,
        elapsed: elapsedLabel(job),
        progress: progressOf(job.plan),
        command: job.command,
      }));
  }

  selectedRun() {
    const row = this.runs()[this.runCursor];
    return row ? this.jobById(row.id) : null;
  }

  focusRuns() {
    if (this.viewing || this.pick) return;
    this.focus = 'runs';
    this.runs();
  }

  focusCli() {
    if (this.viewing || this.pick) return;
    this.focus = 'cli';
  }

  toggleFocus() {
    if (this.focus === 'runs') this.focusCli();
    else this.focusRuns();
  }

  jobById(id) {
    return this.jobs.find((job) => job.id === id) ?? null;
  }

  viewedJob() {
    return this.jobById(this.viewId);
  }

  runningJob(id, action = '') {
    const live = (job) =>
      job.cliId === id &&
      job.status === 'running' &&
      (!action || job.action === action);
    return this.jobs.findLast(live) ?? null;
  }

  runningCount() {
    return this.jobs.filter((job) => job.status === 'running').length;
  }

  summary() {
    const items = this.rows();
    return {
      ready: true,
      installed: items.filter((row) => row.bin).length,
      total: items.length,
      items,
      running: this.runningCount(),
    };
  }

  view(onAgents) {
    const job = this.viewedJob();
    const pick = onAgents ? this.pick : null;
    const menu = pick ? this.menuItems() : null;
    const onPlan = Boolean(pick && pick.field === 'plan');
    return {
      agents: onAgents ? this.rows() : null,
      agentCursor: this.ui.nav.agentCursor,
      agentRuns: onAgents ? this.runs() : [],
      agentRunCursor: onAgents ? this.runCursor : 0,
      agentRunScroll: onAgents ? this.runScroll : 0,
      agentFocus: onAgents ? this.focus : 'cli',
      agentPick: pick ? pick.field : '',
      agentMenu: menu,
      agentQuery: pick ? pick.query : '',
      agentMenuOff: onPlan ? menu.filter(this.busyCheck()) : [],
      agentPickCursor: pick ? pick.cursor : 0,
      agentMenuScroll: pick ? pick.scroll : 0,
      agentPlanCount: onAgents ? this.reviewChoices().length : 0,
      agentView: onAgents && this.viewing,
      agentOutput: job ? job.output : '',
      agentCommand: job ? job.command : '',
      agentElapsed: job ? elapsedLabel(job) : '',
      agentProgress: job
        ? planProgress(job.plan, this.root, this.reviewStore())
        : '',
      agentRunning: Boolean(job && job.status === 'running'),
      agentPending: job && job.status === 'running' ? job.pending : '',
      agentHint:
        job && job.status === 'running' ? pendingHint(job.pending) : '',
      agentFollow: this.followEnd,
      agentScroll: this.logScroll,
      agentStatus: job ? job.status : '',
    };
  }

  open() {
    const nav = this.ui.nav;
    this.refresh();
    this.viewing = false;
    this.focus = 'cli';
    nav.pane = 'agents';
    nav.resetListScroll('agents');
    nav.clearSelection();
    nav.agentCursor = Math.max(
      0,
      this.list.findIndex((row) => row.bin),
    );
    this.ui.status = '';
    return this.loadModels();
  }

  async loadModels() {
    this.modelsEpoch += 1;
    const epoch = this.modelsEpoch;
    const pending = this.list
      .filter((row) => row.bin && !this.loaded.has(cacheKey(row)))
      .map((row) => this.fetchModels(row, epoch));
    if (!pending.length) return;
    await Promise.all(pending);
    if (epoch === this.modelsEpoch) this.ui.paint();
  }

  async fetchModels(row, epoch) {
    const listed = listedOf(await listQuietly(this.listModels, row, this.env));
    if (epoch !== this.modelsEpoch) return;
    this.loaded.set(cacheKey(row), {
      models: mergeModels(row.spec.models, listed.names),
      wide: listed.wide ? new Set(listed.wide) : null,
    });
    const current = this.cliById(row.id);
    if (current && current.bin === row.bin) this.applyCached(current);
  }

  setLog(start, max) {
    const next = clamp(start, 0, max);
    this.logScroll = next;
    this.followEnd = next === max;
  }

  placeLog(start) {
    const bar = this.ui.lastFrame && this.ui.lastFrame.scrollBar;
    if (!bar) return;
    const max = Math.max(0, bar.count - bar.rows);
    this.setLog(start, max);
  }

  placeRuns(start) {
    const bar = this.ui.lastFrame && this.ui.lastFrame.scrollBar;
    if (!bar) return;
    const max = Math.max(0, bar.count - bar.rows);
    this.runScroll = clamp(start, 0, max);
  }

  scrollLog(delta) {
    const job = this.viewedJob();
    const { lastFrame, lastSize } = this.ui;
    const width = lastSize && lastSize.width ? lastSize.width : 0;
    const running = Boolean(job && job.status === 'running');
    const count = logRowCount(job ? job.output : '', width, running);
    const bodyH = lastFrame && lastFrame.bodyH ? lastFrame.bodyH : 1;
    const max = Math.max(0, count - logViewRows(bodyH));
    const from = this.followEnd ? max : this.logScroll;
    this.setLog(from + delta, max);
  }

  move(delta) {
    if (this.pick) return void this.movePick(delta);
    if (this.viewing) return void this.scrollLog(delta);
    this.ui.status = '';
    if (this.focus === 'runs') {
      const last = lastIndex(this.runs());
      this.runCursor = clamp(this.runCursor + delta, 0, last);
      return;
    }
    const nav = this.ui.nav;
    nav.agentCursor = clamp(nav.agentCursor + delta, 0, lastIndex(this.list));
    this.runCursor = 0;
    this.runScroll = 0;
  }

  reviewChoices() {
    const names = planFileNames(this.root);
    const file = this.planFile();
    const current = file ? path.basename(file) : '';
    if (current && !names.includes(current)) names.unshift(current);
    return names;
  }

  planPartOf(name) {
    const dir = path.join(this.root, REVIEW_DIR);
    return planPart(dir, name, this.reviewStore());
  }

  planFace() {
    const file = this.planFile();
    const part = file ? this.planPartOf(file) : null;
    return part ? planLabel(part) : '';
  }

  planMenu() {
    const parts = this.reviewChoices().map((name) => this.planPartOf(name));
    return alignPlanLabels(parts.filter(Boolean));
  }

  fieldItems(field, row) {
    if (field === 'plan') return this.planMenu();
    if (!row) return [];
    const choices = optionsOf(row);
    const picked = this.choice(row.id);
    if (field === 'model') return choices.names;
    if (field === 'context') {
      return choices.contexts(choices.shown(picked.model));
    }
    return choices.efforts(picked.model);
  }

  fieldStart(field, items, row) {
    if (field === 'plan') {
      const current = planKey(this.planFile());
      const at = items.findIndex((item) => planKey(item) === current);
      return firstEnabled(items, Math.max(0, at), this.busyCheck());
    }
    const picked = this.choice(row.id);
    const current =
      field === 'model' ? optionsOf(row).shown(picked.model) : picked[field];
    return Math.max(0, items.indexOf(current));
  }

  menuItems() {
    if (!this.pick) return [];
    return this.pick.filter(this.fieldItems(this.pick.field, this.selected()));
  }

  menuPage(fraction = 1) {
    const body = this.ui.lastFrame && this.ui.lastFrame.bodyH;
    const height = Math.min(body > 0 ? body : MENU_ROWS, MENU_ROWS);
    return Math.max(1, Math.floor(height * fraction));
  }

  movePick(delta) {
    const items = this.menuItems();
    if (!items.length || !this.pick) return;
    const isOff = this.pick.field === 'plan' ? this.busyCheck() : NEVER;
    this.pick.move(delta, items, isOff);
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
    this.pick.edit(query);
    this.ui.status = '';
    this.ui.paint();
  }

  openPick(field) {
    if (this.viewing) return;
    if (this.pick && this.pick.field === field) return void this.closePick();
    const row = this.selected();
    if (!row || !row.bin) return;
    optionsOf(row).normalize(this.choice(row.id));
    const items = this.fieldItems(field, row);
    if (items.length < (field === 'context' ? 1 : 2)) return;
    this.pick = new MenuPick(field, this.fieldStart(field, items, row));
    this.ui.status = '';
    this.ui.paint();
  }

  acceptPick(at = this.pick ? this.pick.cursor : 0) {
    const pick = this.pick;
    if (!pick) return;
    const items = this.menuItems();
    const value = items[Math.min(at, lastIndex(items))];
    if (pick.field === 'plan' && this.planBusy(value)) {
      this.ui.status = `busy ${planKey(value)}`;
      this.ui.paint();
      return;
    }
    const row = this.selected();
    this.dismissPick();
    const done = row && value ? this.applyPick(pick.field, row, value) : '';
    this.ui.status = done;
    this.ui.paint();
  }

  applyPick(field, row, value) {
    if (field === 'plan') {
      const name = planKey(value);
      this.planPath = path.join(this.root, REVIEW_DIR, name);
      return `plan ${name}`;
    }
    const picked = this.choice(row.id);
    const apply = APPLY_FIELD[field] ?? APPLY_FIELD.effort;
    apply(optionsOf(row), picked, value);
    this.saveChoice(row.id);
    return `${field} ${picked[field]}`;
  }

  pickStep(key) {
    const page = this.menuPage();
    const half = this.menuPage(0.5);
    const steps = {
      up: -1,
      down: 1,
      pageUp: -page,
      pageDown: page,
      'ctrl-b': -page,
      'ctrl-f': page,
      'ctrl-u': -half,
      'ctrl-d': half,
      home: -Infinity,
      end: Infinity,
    };
    return Object.hasOwn(steps, key) ? steps[key] : 0;
  }

  onPickKey(key) {
    if (!this.pick) return;
    if (key === 'escape') return void this.closePick();
    if (key === 'enter') return void this.acceptPick();
    if (key === 'backspace') {
      return void this.editQuery(this.pick.query.slice(0, -1));
    }
    const step = this.pickStep(key);
    if (step) return void this.movePick(step);
    if (key.length === 1 && key > ' ') this.editQuery(this.pick.query + key);
  }

  toggleFast() {
    if (this.viewing || this.pick) return;
    const row = this.selected();
    if (!row || !row.bin) {
      this.ui.status = 'not installed';
      return;
    }
    const picked = this.choice(row.id);
    optionsOf(row).toggleFast(picked);
    this.saveChoice(row.id);
    this.ui.status = picked.fast ? 'fast on' : 'fast off';
    this.ui.paint();
  }

  latestPlan() {
    const latest = latestReviewName(listReviewNames(this.root));
    return latest ? path.join(this.root, REVIEW_DIR, latest) : '';
  }

  planFile() {
    if (this.planPath && fs.existsSync(this.planPath)) return this.planPath;
    const store = this.reviewStore();
    if (store && store.reviewPath) return store.reviewPath;
    return this.latestPlan();
  }

  savePlan(store) {
    if (store.dirty) this.ui.flushReview(true);
    if (fs.existsSync(store.reviewPath)) return true;
    store.dirty = true;
    this.ui.flushReview(true);
    return fs.existsSync(store.reviewPath);
  }

  ensurePlan() {
    const store = this.reviewStore();
    const live = store ? store.reviewPath : '';
    const chosen = this.planPath;
    if (chosen && chosen !== live && fs.existsSync(chosen)) return chosen;
    if (live && this.savePlan(store)) return live;
    return this.latestPlan();
  }

  busyPlans() {
    const busy = new Set();
    for (const job of this.jobs) {
      if (job.status !== 'running' || job.action === 'login') continue;
      const name = path.basename(`${job.plan ?? ''}`);
      if (name) busy.add(name);
    }
    return busy;
  }

  busyCheck() {
    const busy = this.busyPlans();
    return (file) => busy.has(planKey(file));
  }

  planBusy(file) {
    return this.busyPlans().has(planKey(file));
  }

  openView(id) {
    if (!this.jobById(id)) return;
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
    if (this.runningCount()) this.ui.progress.start('agents');
    else this.ui.progress.stop('agents');
  }

  keepLog(job) {
    const now = Date.now();
    if (now - job.loggedAt < 150) return;
    job.loggedAt = now;
    this.saveRuns();
  }

  showOutput(job, text) {
    job.output = text;
    const running = job.pty && job.status === 'running';
    job.pending = running ? pendingKind(text) : '';
    if (running && agentBusy(text, job.pending)) job.worked = true;
    if (running) closeFinished(job);
    this.keepLog(job);
    const watched = this.viewing && this.viewId === job.id;
    if (watched || this.ui.nav.pane === 'agents') this.ui.paint();
  }

  takesAnswer(key) {
    const job = this.viewedJob();
    if (!this.viewing || !job || job.status !== 'running' || !job.pending) {
      return false;
    }
    if (key === 'ctrl-q') return true;
    return answerBytes(key, job.pending) !== null;
  }

  answer(key) {
    const job = this.viewedJob();
    if (!job || !this.takesAnswer(key)) return;
    if (key === 'ctrl-q') return void this.closeView();
    const bytes = answerBytes(key, job.pending);
    if (bytes === null || !job.child || !job.child.write) return;
    if (remembersAnswer(key)) {
      const tokens = rememberedTokens(permissionTokens(job.output));
      ensureAllows(cursorConfigPath(), tokens);
      const title = requestTitle(job.output);
      job.transcript += `allowed always: ${title}\n`;
    } else if (key === 'y' || key === 'Y') {
      job.transcript += `allowed once: ${requestTitle(job.output)}\n`;
    } else if (key === 'n' || key === 'N' || key === 'escape') {
      job.transcript += `rejected: ${requestTitle(job.output)}\n`;
    }
    job.child.write(bytes);
  }

  fitPty(width, bodyH) {
    const job = this.viewing ? this.viewedJob() : null;
    const child = job && job.child;
    if (!job || job.status !== 'running' || !child || !child.resize) return;
    let head = 1;
    if (job.command) head += 1;
    if (job.status) head += 1;
    if (pendingHint(job.pending)) head += 1;
    const rows = Math.max(8, logViewRows(Math.max(1, bodyH - head)));
    const cols = Math.max(40, width - 4);
    if (job.ptyCols === cols && job.ptyRows === rows) return;
    job.ptyCols = cols;
    job.ptyRows = rows;
    child.resize(cols, rows);
  }

  settleJob(job, result) {
    if (result) job.finish(result);
    else job.stop();
    this.saveRuns();
    this.syncProgress();
  }

  finishJob(job, result) {
    if (job.status !== 'running') return;
    const stopped = job.stopping;
    this.settleJob(job, stopped ? null : result);
    const isLogin = job.action === 'login';
    const watched = this.viewing && this.viewId === job.id;
    const signedIn = !stopped && isLogin && result.status === 0;
    if (stopped && watched) this.ui.status = 'stopped';
    else if (signedIn) this.ui.status = 'logged in';
    this.ui.paint();
    if (isLogin) return void this.finishLogin(job, result, stopped, signedIn);
    if (stopped || !needsAuth(job.output)) return;
    const cli = this.cliById(job.cliId);
    if (canLogin(cli)) this.startLogin(cli);
  }

  finishLogin(job, result, stopped, signedIn) {
    if (!signedIn) {
      this.pendingStart = null;
      if (!stopped && result) this.ui.status = 'not logged in';
      this.ui.paint();
      return;
    }
    this.authYes.add(job.cliId);
    const pending = this.pendingStart;
    this.pendingStart = null;
    if (!pending || pending.id !== job.cliId) return;
    const cli = this.cliById(pending.id);
    if (cli) this.launchReady(cli, pending.resume);
  }

  authAnswer(row) {
    if (!canLogin(row)) return true;
    const args = row.spec && row.spec.status;
    if (!args || !args.length) return true;
    if (this.authYes.has(row.id)) return true;
    return this.authProbe(row);
  }

  beginStart(row, resume) {
    const id = row.id;
    if (this.authWait === id) return;
    const answer = this.authAnswer(row);
    const go = (ok) => {
      if (this.authWait === id) this.authWait = '';
      const current = this.cliById(id);
      if (!current) return;
      this.afterAuth(current, resume, ok);
    };
    if (answer && typeof answer.then === 'function') {
      this.authWait = id;
      answer.then(go, () => go(null));
      return;
    }
    this.afterAuth(row, resume, answer);
  }

  afterAuth(row, resume, ok) {
    if (ok === true) this.authYes.add(row.id);
    if (ok === false) return void this.holdForLogin(row, resume);
    this.launchReady(row, resume);
  }

  holdForLogin(row, resume) {
    this.pendingStart = { id: row.id, resume };
    this.startLogin(row);
    this.ui.status = 'not logged in';
    this.ui.paint();
  }

  launchReady(row, resume) {
    const chosen = resume === true || resume === false;
    if (!chosen) {
      const known = this.sessionKnown(row, this.root, this.jobs);
      if (known) {
        this.ui.mode = 'confirmSession';
        this.ui.status = '';
        return;
      }
    }
    this.startJob(row, resume === true);
  }

  startLaunch(launch, model, showLog = true) {
    if (!launch.ok) {
      this.ui.status = launch.error;
      return;
    }
    const job = launchJob(this.nextId, launch, model);
    this.nextId += 1;
    this.jobs.push(job);
    const child = this.spawn(
      this.root,
      launch,
      (text) => this.showOutput(job, text),
      (result) => this.finishJob(job, result),
    );
    if (job.status === 'running') job.child = child;
    this.saveRuns();
    this.syncProgress();
    if (showLog && this.jobs.at(-1) === job) this.openView(job.id);
  }

  startJob(row, resume = false) {
    const picked = this.choice(row.id);
    const plan = this.ensurePlan();
    const launch = buildLaunch(row, picked, plan, this.root, resume);
    if (resume && launch.ok) {
      launch.session = priorSession(this.jobs, row.id);
    }
    this.startLaunch(launch, picked.model);
  }

  prepareStart() {
    const row = this.selected();
    const live = row ? this.runningJob(row.id) : null;
    if (live) {
      this.openView(live.id);
      return null;
    }
    if (!row || !row.bin) {
      this.ui.status = 'not installed';
      return null;
    }
    const file = this.planFile();
    if (file && this.planBusy(file)) {
      this.ui.status = `busy ${path.basename(file)}`;
      return null;
    }
    return row;
  }

  startLogin(row) {
    const live = this.runningJob(row.id, 'login');
    if (!live) this.startLaunch(buildLogin(row), '', false);
    if (this.viewing) this.closeView();
    this.ui.status = 'logging in';
    this.ui.paint();
  }

  rerun() {
    if (!this.viewing) return;
    const job = this.viewedJob();
    if (!job || job.status === 'running' || !job.cmd) return;
    this.startLaunch(replayLaunch(job), job.model);
  }

  start() {
    if (this.pick) return void this.acceptPick();
    if (this.focus === 'runs') {
      const job = this.selectedRun();
      if (job) this.openView(job.id);
      return;
    }
    const row = this.prepareStart();
    if (!row) return;
    this.beginStart(row);
  }

  chooseSession(resume) {
    this.ui.mode = 'review';
    const row = this.prepareStart();
    if (!row) return;
    this.beginStart(row, resume);
  }

  cancelSession() {
    this.ui.mode = 'review';
    this.ui.status = '';
  }

  selectedJob() {
    if (this.focus === 'runs') return this.selectedRun();
    const row = this.selected();
    return row ? this.runningJob(row.id) : null;
  }

  stop() {
    const job = this.viewing ? this.viewedJob() : this.selectedJob();
    if (!job || job.status !== 'running' || !job.child) return;
    job.stopping = true;
    job.child.kill();
    if (job.status !== 'running') return;
    this.settleJob(job, null);
    this.ui.status = 'stopped';
    this.ui.paint();
  }
}

module.exports = { AgentsController };
