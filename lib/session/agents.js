'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { jsonParse, isHashObject } = require('metautil');
const agents = require('../agents.js');
const { detectAgents, emptyChoice, buildLaunch, buildLogin } = agents;
const { mergeModels, listModels, commandLine, startAgent } = agents;
const { needsAuth, planRef, groupModels, resolveModel } = agents;
const { fitEffort, modelHasWide, takeWide } = agents;
const { visibleWidth } = require('../ansi.js');
const review = require('../review.js');
const { planNames, planFileNames, parseReview, reviewProgress } = review;
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

const padVisible = (text, width) => {
  const extra = width - visibleWidth(text);
  if (extra <= 0) return text;
  return `${text}${' '.repeat(extra)}`;
};

const alignPlanLabels = (parts) => {
  let nameW = 0;
  let statusW = 0;
  for (const part of parts) {
    if (!part.status) continue;
    nameW = Math.max(nameW, visibleWidth(part.name));
    statusW = Math.max(statusW, visibleWidth(part.status));
  }
  const labels = [];
  for (const part of parts) {
    if (!part.status) {
      labels.push(part.name);
      continue;
    }
    const name = padVisible(part.name, nameW);
    const status = padVisible(part.status, statusW);
    labels.push(`${name}  ${status}  ${part.progress}`);
  }
  return labels;
};

const emptyPlanPart = (name = '') => ({ name, status: '', progress: '' });

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

const withoutFast = (name) => {
  const text = concrete(name);
  if (!text.endsWith('-fast')) return text;
  return text.slice(0, -5);
};

const modelNames = (row) => {
  const raw = [];
  for (const item of groupModels(row.models ?? [])) {
    const name = concrete(item.model);
    if (name) raw.push(name);
  }
  const known = new Set(raw);
  const names = [];
  for (const name of raw) {
    const base = withoutFast(name);
    if (name !== base && known.has(base)) continue;
    if (names.includes(name)) continue;
    names.push(name);
  }
  return names;
};

const shownModel = (names, model) => {
  const saved = concrete(model);
  const base = withoutFast(saved);
  if (names.includes(base)) return base;
  if (names.includes(saved)) return saved;
  return names[0] || '';
};

const RUN_KEEP = 40;
const OUTPUT_KEEP = 100000;

const pad2 = (value) => `${value}`.padStart(2, '0');

const elapsedLabel = (job, now = Date.now()) => {
  const start = Number(job && job.startedAt) || 0;
  if (!start) return '';
  const running = job.status === 'running';
  const end = running ? now : Number(job.endedAt) || now;
  const sec = Math.max(0, Math.floor((end - start) / 1000));
  const hours = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const secs = sec % 60;
  if (hours) return `${hours}:${pad2(mins)}:${pad2(secs)}`;
  return `${mins}:${pad2(secs)}`;
};

const progressLabel = (job, root = '', store = null) => {
  const file = `${job && job.plan ? job.plan : ''}`;
  if (!file) return '';
  const abs = path.isAbsolute(file) ? file : path.join(root, file);
  const live = store && store.reviewPath;
  const same =
    live === abs ||
    live === file ||
    (live && path.basename(live) === path.basename(file));
  if (same) {
    const progress = reviewProgress(store);
    if (!progress.total) return '';
    return `${progress.done}/${progress.total}`;
  }
  try {
    const text = fs.readFileSync(abs, 'utf8');
    const progress = reviewProgress(parseReview(text, file));
    if (!progress.total) return '';
    return `${progress.done}/${progress.total}`;
  } catch {
    return '';
  }
};

const tailText = (text, limit) => {
  const body = `${text ?? ''}`;
  if (body.length <= limit) return body;
  return body.slice(body.length - limit);
};

const runRecord = (job) => ({
  id: job.id,
  cliId: job.cliId,
  name: job.name,
  model: job.model,
  cmd: job.cmd,
  args: job.args,
  command: job.command,
  plan: job.plan,
  action: job.action,
  status: job.status,
  exit: job.exit,
  output: tailText(job.output, OUTPUT_KEEP),
  startedAt: job.startedAt,
  endedAt: job.endedAt,
});

const planKey = (value) => {
  const text = `${value ?? ''}`.trim();
  if (!text) return '';
  const gap = text.indexOf('  ');
  if (gap > 0) return text.slice(0, gap);
  return path.basename(text);
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

const contextChoices = (row, model) => {
  const list = row.spec && row.spec.contexts;
  if (!list) return [];
  const names = [];
  for (const size of list) {
    const name = concrete(size);
    if (name) names.push(name);
  }
  if (!model || !(row.wide instanceof Set)) return names;
  if (modelHasWide(row, model)) return names;
  return names.filter((size) => size !== '1m');
};

const fastAvailable = (row, model) => {
  const base = withoutFast(model);
  if (!base) return false;
  const fastName = `${base}-fast`;
  for (const item of groupModels(row.models ?? [])) {
    if (item.model === fastName) return true;
  }
  return false;
};

const catalogHasFast = (row) => {
  for (const item of groupModels(row.models ?? [])) {
    if (`${item.model ?? ''}`.endsWith('-fast')) return true;
  }
  return false;
};

const fitContext = (row, model, context) => {
  const sizes = contextChoices(row, model);
  const want = concrete(context);
  if (!want) return '';
  if (sizes.includes(want)) return want;
  return sizes[0] || '';
};

const firstModelFor = (row, size) => {
  for (const name of modelNames(row)) {
    if (contextChoices(row, name).includes(size)) return name;
  }
  return '';
};

const firstFastModel = (row) => {
  for (const name of modelNames(row)) {
    if (fastAvailable(row, name)) return name;
  }
  return '';
};

const alignChoice = (row, picked, model) => {
  const shown = model || shownModel(modelNames(row), picked.model);
  const basis = concrete(picked.model) || shown;
  const effort = fitEffort(levelList(row, basis), picked.effort);
  if (effort) picked.effort = effort;
  picked.context = fitContext(row, shown, picked.context);
  if (!picked.fast || !catalogHasFast(row)) return;
  if (fastAvailable(row, shown)) return;
  picked.fast = false;
};

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
    this.runScroll = 0;
    this.followEnd = true;
    this.logScroll = 0;
    this.env = process.env;
    this.refresh();
    this.loadRuns();
  }

  killAll() {
    for (const job of this.jobs ?? []) {
      if (job.child) job.child.kill();
    }
  }

  applyCached(row) {
    const cached = this.loaded.get(cacheKey(row));
    if (!cached) return;
    if (Array.isArray(cached)) {
      row.models = cached;
      return;
    }
    row.models = cached.models;
    row.wide = cached.wide ? new Set(cached.wide) : cached.wide;
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
      const picked = this.choice(row.id);
      const item = saved[row.id];
      if (isHashObject(item)) {
        const model = concrete(item.model);
        const effort = concrete(item.effort);
        if (model) picked.model = model;
        if (effort) picked.effort = effort;
        if (item.fast === true) picked.fast = true;
        const context = concrete(item.context);
        if (context) picked.context = context;
      }
      if (concrete(picked.effort)) continue;
      const levels = levelsFor(row, picked.model);
      if (levels.includes('medium')) picked.effort = 'medium';
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
    if (picked.fast === true) next.fast = true;
    const context = concrete(picked.context);
    if (context) next.context = context;
    const saved = model || effort || next.fast || next.context;
    if (saved) agents[id] = next;
    else delete agents[id];
    writePrefs(root, { ...data, agents });
  }

  loadRuns() {
    const root = this.ui.top || this.ui.cwd;
    if (!root) return;
    const saved = readPrefs(root).runs;
    if (!Array.isArray(saved)) return;
    const jobs = [];
    let next = 1;
    for (const item of saved) {
      if (!isHashObject(item)) continue;
      const id = Number(item.id) || next;
      if (id >= next) next = id + 1;
      let status = `${item.status ?? ''}`;
      let output = `${item.output ?? ''}`;
      let endedAt = Number(item.endedAt) || 0;
      if (status === 'running') {
        status = 'stopped';
        output = withNotice(output, 'interrupted');
        if (!endedAt) endedAt = Number(item.startedAt) || Date.now();
      }
      jobs.push({
        id,
        cliId: `${item.cliId ?? ''}`,
        name: `${item.name ?? ''}`,
        model: `${item.model ?? ''}`,
        cmd: `${item.cmd ?? ''}`,
        args: Array.isArray(item.args) ? item.args : [],
        command: `${item.command ?? ''}`,
        plan: `${item.plan ?? ''}`,
        action: `${item.action ?? 'run'}`,
        status,
        exit: item.exit ?? null,
        output,
        child: null,
        startedAt: Number(item.startedAt) || 0,
        endedAt,
        stopping: false,
      });
    }
    this.jobs = jobs;
    this.nextId = next;
  }

  saveRuns() {
    const root = this.ui.top || this.ui.cwd;
    if (!root) return;
    const data = readPrefs(root);
    const runs = [];
    for (const job of this.jobs) runs.push(runRecord(job));
    const kept = runs.slice(-RUN_KEEP);
    writePrefs(root, { ...data, runs: kept });
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

  planPart(name) {
    const base = planKey(name);
    if (!base) return emptyPlanPart();
    const root = this.ui.top || this.ui.cwd;
    const file = path.join(root, REVIEW_DIR, base);
    const store = this.ui.review && this.ui.review.store;
    const live = store && store.reviewPath;
    const same = live === file || (live && path.basename(live) === base);
    if (same) {
      const status = `${store.status ?? ''}`.trim() || 'editing';
      const progress = reviewProgress(store);
      return {
        name: base,
        status,
        progress: `${progress.done}/${progress.total}`,
      };
    }
    try {
      const text = fs.readFileSync(file, 'utf8');
      const raw = frontmatterStatus(text);
      const progress = reviewProgress(parseReview(text, file));
      if (!raw && progress.total === 0) return emptyPlanPart(base);
      return {
        name: base,
        status: raw || 'editing',
        progress: `${progress.done}/${progress.total}`,
      };
    } catch {
      return emptyPlanPart(base);
    }
  }

  planChoice(name) {
    const part = this.planPart(name);
    if (!part.name) return '';
    if (!part.status) return part.name;
    return `${part.name}  ${part.status}  ${part.progress}`;
  }

  planFace() {
    const file = this.planFile();
    if (!file) return '';
    return this.planChoice(file);
  }

  planMenu() {
    const parts = [];
    for (const name of this.reviewChoices()) {
      const part = this.planPart(name);
      if (part.name) parts.push(part);
    }
    return alignPlanLabels(parts);
  }

  cliRows() {
    const plan = this.planFace();
    const planBusy = this.planBusy(this.planFile());
    return this.list.map((row) => {
      const picked = this.choice(row.id);
      const shown = syncChoice(row, picked);
      const modelChoices = modelNames(row);
      const model = shownModel(modelChoices, shown.model);
      alignChoice(row, picked, model);
      let fast = 'off';
      if (picked.fast) fast = 'on';
      let planName = '';
      if (row.bin) planName = plan;
      return {
        kind: 'cli',
        ...row,
        model,
        modelChoices,
        effort: concrete(picked.effort),
        efforts: levelsFor(row, picked.model),
        fast,
        context: concrete(picked.context),
        contexts: contextChoices(row, model),
        extra: picked.extra,
        plan: planName,
        planBusy: Boolean(row.bin && planBusy),
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
        elapsed: elapsedLabel(job),
        progress: progressLabel(
          job,
          this.ui.top || this.ui.cwd,
          this.ui.review && this.ui.review.store,
        ),
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
    return rows;
  }

  selectedRun() {
    const row = this.runs()[this.runCursor];
    if (!row) return null;
    return this.jobById(row.id);
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
    this.focus = 'cli';
    ui.nav.pane = 'agents';
    ui.nav.resetListScroll('agents');
    ui.nav.clearSelection();
    const rows = this.rows();
    let at = 0;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].bin) {
        at = i;
        break;
      }
    }
    ui.nav.agentCursor = at;
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
    const names = Array.isArray(listed) ? listed : [];
    const wide = takeWide(names);
    const models = mergeModels(row.spec.models, names);
    this.loaded.set(key, { models, wide });
    const current = this.list.find((item) => item.id === row.id);
    if (!current || current.bin !== row.bin) return;
    current.models = models;
    current.wide = wide ? new Set(wide) : wide;
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
    this.runScroll = 0;
    this.ui.status = '';
  }

  reviewChoices() {
    const root = this.ui.top || this.ui.cwd;
    const names = planFileNames(root);
    const file = this.planFile();
    const current = file ? path.basename(file) : '';
    if (current && !names.includes(current)) names.unshift(current);
    return names;
  }

  menuItems() {
    if (!this.pick) return [];
    const row = this.selected();
    let all = [];
    if (this.pick.field === 'plan') {
      all = this.planMenu();
    } else if (row && this.pick.field === 'model') {
      all = modelNames(row);
    } else if (row && this.pick.field === 'context') {
      const model = shownModel(modelNames(row), this.choice(row.id).model);
      all = contextChoices(row, model);
    } else if (row) {
      all = levelsFor(row, this.choice(row.id).model);
    }
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
    const items = this.menuItems();
    const count = items.length;
    if (!count || !this.pick) return;
    const last = count - 1;
    if (this.pick.field !== 'plan') {
      const next = this.pick.cursor + delta;
      this.pick.cursor = Math.max(0, Math.min(last, next));
      return;
    }
    const step = delta < 0 ? -1 : 1;
    const goal = Math.max(0, Math.min(last, this.pick.cursor + delta));
    let cursor = this.pick.cursor;
    let next = cursor;
    while (next !== goal) {
      next += step;
      if (!this.planBusy(items[next])) cursor = next;
    }
    if (this.planBusy(items[cursor])) {
      let scan = goal;
      while (scan >= 0 && scan <= last && this.planBusy(items[scan])) {
        scan += step;
      }
      if (scan >= 0 && scan <= last) cursor = scan;
    }
    this.pick.cursor = cursor;
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
    this.ui.status = '';
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
      current = shownModel(names, picked.model);
    } else if (field === 'plan') {
      items = this.planMenu();
      current = planKey(this.planFile());
    } else if (field === 'context') {
      items = contextChoices(row, shownModel(names, picked.model));
      current = picked.context;
    }
    const least = field === 'context' ? 1 : 2;
    if (items.length < least) return;
    let at = items.indexOf(current);
    if (field === 'plan') {
      at = items.findIndex((item) => planKey(item) === current);
    }
    if (at < 0) at = 0;
    if (field === 'plan') at = this.enabledPlanAt(items, at);
    this.pick = { field, cursor: at, query: '', scroll: 0 };
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

  openContext() {
    this.openPick('context');
  }

  enabledPlanAt(items, at) {
    if (!this.planBusy(items[at])) return at;
    for (let i = 0; i < items.length; i++) {
      if (!this.planBusy(items[i])) return i;
    }
    return at;
  }

  acceptPick() {
    const pick = this.pick;
    if (!pick) return;
    const row = this.selected();
    const items = this.menuItems();
    const at = Math.min(pick.cursor, Math.max(0, items.length - 1));
    const value = items[at];
    if (pick.field === 'plan' && this.planBusy(value)) {
      this.ui.status = `busy ${planKey(value)}`;
      this.ui.paint();
      return;
    }
    this.dismissPick();
    if (!row || !value) {
      this.ui.status = '';
      this.ui.paint();
      return;
    }
    const picked = this.choice(row.id);
    if (pick.field === 'model') {
      picked.model = value;
      alignChoice(row, picked, value);
      this.ui.status = `model ${value}`;
    } else if (pick.field === 'plan') {
      const root = this.ui.top || this.ui.cwd;
      const name = planKey(value);
      this.planPath = path.join(root, REVIEW_DIR, name);
      this.ui.status = `plan ${name}`;
    } else if (pick.field === 'context') {
      picked.context = value;
      const shown = shownModel(modelNames(row), picked.model);
      if (!contextChoices(row, shown).includes(value)) {
        const next = firstModelFor(row, value);
        if (next) picked.model = next;
      }
      const model = shownModel(modelNames(row), picked.model);
      alignChoice(row, picked, model);
      if (contextChoices(row, model).includes(value)) picked.context = value;
      this.ui.status = `context ${picked.context}`;
    } else {
      picked.effort = value;
      this.ui.status = `effort ${value}`;
    }
    const choice = pick.field === 'model' || pick.field === 'effort';
    if (choice || pick.field === 'context') this.saveChoice(row.id);
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
      pageUp: -page,
      pageDown: page,
      'ctrl-b': -page,
      'ctrl-f': page,
      'ctrl-u': -half,
      'ctrl-d': half,
      home: -1e9,
      end: 1e9,
    };
    if (Object.hasOwn(step, key)) {
      this.movePick(step[key]);
      return;
    }
    if (key.length === 1 && key > ' ') {
      this.editQuery(this.pick.query + key);
    }
  }

  toggleFast() {
    if (this.viewing || this.pick) return;
    const row = this.selected();
    if (!row || row.kind !== 'cli' || !row.bin) {
      this.ui.status = 'not installed';
      return;
    }
    const picked = this.choice(row.id);
    picked.fast = picked.fast !== true;
    const shown = shownModel(modelNames(row), picked.model);
    if (picked.fast && catalogHasFast(row) && !fastAvailable(row, shown)) {
      const next = firstFastModel(row);
      if (next) picked.model = next;
      else picked.fast = false;
    }
    const model = shownModel(modelNames(row), picked.model);
    alignChoice(row, picked, model);
    this.saveChoice(row.id);
    this.ui.status = picked.fast ? 'fast on' : 'fast off';
    this.ui.paint();
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

  busyPlans() {
    const names = new Set();
    for (const job of this.jobs) {
      if (job.status !== 'running' || job.action === 'login') continue;
      const name = path.basename(`${job.plan ?? ''}`);
      if (name) names.add(name);
    }
    return names;
  }

  planBusy(file) {
    const name = planKey(file);
    if (!name) return false;
    return this.busyPlans().has(name);
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
    this.saveRuns();
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
      plan: launch.plan || '',
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
    this.saveRuns();
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
    if (!row.bin) {
      this.ui.status = 'not installed';
      return;
    }
    const file = this.planFile();
    if (file && this.planBusy(file)) {
      this.ui.status = `busy ${path.basename(file)}`;
      return;
    }
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
    this.saveRuns();
    this.syncProgress();
    this.ui.status = 'stopped';
    this.ui.paint();
  }
}

module.exports = { AgentsController, elapsedLabel, progressLabel };
