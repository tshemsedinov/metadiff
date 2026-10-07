'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { IS_WIN, runProc, spawnBase } = require('./utilities.js');
const { commandEnv, killTree } = require('./npm-commands.js');
const { stripAnsi } = require('./ansi.js');

const LIST_MS = 5000;
const MODEL_ID = /^[A-Za-z][A-Za-z0-9_./:+#-]*$/;
const SKIP_TOKEN = new RegExp(
  '^(no|available|loading|usage|help|try|tip|error|' +
    'warning|command|commands|options|flag|version|' +
    'unknown|invalid)$',
  'i',
);
const CURSOR_ROW = /^([A-Za-z][A-Za-z0-9_./:+#-]*)\s+-\s+\S/;
const AVAILABLE_LINE = /^Available models:\s*(.+)$/i;
const JSON_KEYS = ['slug', 'id', 'model', 'modelID', 'name'];
const plainEffort = (level) => level;
const codexEffort = (level) => `model_reasoning_effort=${level}`;

const uniqueNames = (names) => {
  const out = [];
  const seen = new Set();
  for (const raw of names) {
    const name = `${raw ?? ''}`.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
};

const parseNameList = (text) => {
  const names = [];
  for (const raw of stripAnsi(`${text ?? ''}`).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const token = line.split(/\s+/)[0].replace(/:+$/, '');
    if (!MODEL_ID.test(token) || SKIP_TOKEN.test(token)) continue;
    names.push(token);
  }
  return uniqueNames(names);
};

const parseCursorModels = (text) => {
  const names = [];
  for (const raw of stripAnsi(`${text ?? ''}`).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^loading models/i.test(line)) continue;
    if (/^available models$/i.test(line)) continue;
    if (/^tip:/i.test(line)) continue;
    if (/^no models/i.test(line)) continue;
    const listed = AVAILABLE_LINE.exec(line);
    if (listed) {
      for (const name of listed[1].split(',')) names.push(name.trim());
      continue;
    }
    const row = CURSOR_ROW.exec(line);
    if (row) names.push(row[1]);
  }
  return uniqueNames(names.length ? names : parseNameList(text));
};

const jsonStart = (text) => {
  const obj = text.indexOf('{');
  const arr = text.indexOf('[');
  if (obj < 0) return arr;
  if (arr < 0) return obj;
  return Math.min(obj, arr);
};

const parseJsonModels = (text) => {
  const plain = stripAnsi(`${text ?? ''}`);
  const start = jsonStart(plain);
  if (start < 0) return parseNameList(plain);
  let data;
  try {
    data = JSON.parse(plain.slice(start));
  } catch {
    return parseNameList(plain);
  }
  const names = [];
  const walk = (value) => {
    if (!value) return;
    if (typeof value === 'string') return;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') names.push(item);
        else walk(item);
      }
      return;
    }
    if (typeof value !== 'object') return;
    for (const key of JSON_KEYS) {
      const id = value[key];
      if (typeof id === 'string' && id.trim()) {
        names.push(id.trim());
        break;
      }
    }
    if (value.models) walk(value.models);
    if (value.data) walk(value.data);
  };
  walk(data);
  return uniqueNames(names.length ? names : parseNameList(plain));
};

const mergeModels = (fallback, listed) => {
  const names = ['default'];
  const seen = new Set(names);
  const add = (raw) => {
    const name = `${raw ?? ''}`.trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };
  for (const name of listed ?? []) add(name);
  for (const name of fallback ?? []) add(name);
  return names;
};

const EFFORT_LEVELS = [
  'extra-high',
  'xhigh',
  'minimal',
  'medium',
  'none',
  'high',
  'max',
  'low',
];

const EFFORT_RANK = [
  'default',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'extra-high',
  'max',
];

const cutSuffix = (name, suffix) => {
  if (!name.endsWith(suffix)) return '';
  if (name.length <= suffix.length) return '';
  return name.slice(0, -suffix.length);
};

const effortTail = (name) => {
  for (const level of EFFORT_LEVELS) {
    const base = cutSuffix(name, `-${level}`);
    if (base) return { base, level };
  }
  return null;
};

const splitEffortModel = (id) => {
  const name = `${id ?? ''}`.trim();
  if (!name) return null;
  let rest = name;
  let fast = false;
  const unfast = cutSuffix(rest, '-fast');
  if (unfast) {
    const unthink = cutSuffix(unfast, '-thinking');
    const carried = unthink ? effortTail(unthink) : null;
    if (effortTail(unfast) || carried) {
      rest = unfast;
      fast = true;
    }
  }
  let thinking = '';
  const unthink = cutSuffix(rest, '-thinking');
  if (unthink && effortTail(unthink)) {
    rest = unthink;
    thinking = 'after';
  }
  const hit = effortTail(rest);
  if (!hit) return null;
  let base = hit.base;
  const before = cutSuffix(base, '-thinking');
  if (before) {
    base = before;
    thinking = 'before';
  }
  return { base, effort: hit.level, thinking, fast, id: name };
};

const modelLabel = (part) => {
  let label = part.base;
  if (part.thinking) label += '-thinking';
  if (part.fast) label += '-fast';
  return label;
};

const groupKey = (part) =>
  `${part.base}\0${part.thinking}\0${part.fast ? 'fast' : ''}`;

const rankedLevels = (ids) => {
  const levels = [];
  for (const level of EFFORT_RANK) {
    if (ids.has(level)) levels.push(level);
  }
  for (const level of ids.keys()) {
    if (!levels.includes(level)) levels.push(level);
  }
  return levels;
};

const finishGroup = (group) => ({
  model: group.model,
  encoded: true,
  levels: rankedLevels(group.ids),
  ids: group.ids,
});

const plainModel = (name) => ({
  model: name,
  encoded: false,
  levels: [],
  ids: new Map([['default', name]]),
});

const groupModels = (ids) => {
  const groups = new Map();
  const plain = [];
  for (const raw of ids ?? []) {
    const name = `${raw ?? ''}`.trim();
    if (!name) continue;
    const part = splitEffortModel(name);
    if (!part) {
      plain.push(name);
      continue;
    }
    const key = groupKey(part);
    let group = groups.get(key);
    if (!group) {
      group = { key, model: modelLabel(part), ids: new Map() };
      groups.set(key, group);
    }
    if (!group.ids.has(part.effort)) group.ids.set(part.effort, part.id);
  }
  const absorbed = new Map();
  for (const name of plain) {
    const direct = groups.get(`${name}\0\0`);
    if (direct && !direct.ids.has('default')) {
      direct.ids.set('default', name);
      absorbed.set(name, direct);
      continue;
    }
    for (const group of groups.values()) {
      if (group.model !== name || group.ids.has('default')) continue;
      group.ids.set('default', name);
      absorbed.set(name, group);
      break;
    }
  }
  const models = [];
  const seen = new Set();
  for (const raw of ids ?? []) {
    const name = `${raw ?? ''}`.trim();
    if (!name) continue;
    const part = splitEffortModel(name);
    if (part) {
      const key = groupKey(part);
      if (seen.has(key)) continue;
      seen.add(key);
      const group = groups.get(key);
      const bare = group.ids.get('default');
      if (bare) seen.add(bare);
      models.push(finishGroup(group));
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    const group = absorbed.get(name);
    if (group) {
      if (seen.has(group.key)) continue;
      seen.add(group.key);
      models.push(finishGroup(group));
      continue;
    }
    models.push(plainModel(name));
  }
  return models;
};

const emptyChoice = (row) => ({
  model: row && row.models && row.models[0] ? row.models[0] : 'default',
  effort: 'default',
  extra: '',
});

const fitEffort = (levels, effort) => {
  const want = `${effort ?? ''}`.trim() || 'default';
  if (!levels || !levels.length) return 'default';
  if (levels.includes(want)) return want;
  if (levels.includes('high')) return 'high';
  if (levels.includes('medium')) return 'medium';
  if (levels.includes('default')) return 'default';
  return levels[0];
};

const catalogEntry = (catalog, model) => {
  for (const item of catalog) {
    if (item.model === model) return item;
  }
  return null;
};

const resolveModel = (row, choice) => {
  const picked = choice ?? emptyChoice(row);
  const catalog = groupModels(row && row.models);
  let entry = catalogEntry(catalog, picked.model);
  let effort = `${picked.effort ?? ''}`.trim() || 'default';
  if (!entry) {
    const part = splitEffortModel(picked.model);
    if (part) {
      entry = catalogEntry(catalog, modelLabel(part));
      if (entry && effort === 'default') effort = part.effort;
    }
  }
  if (entry && entry.encoded) {
    const level = fitEffort(entry.levels, effort);
    return {
      model: entry.ids.get(level) ?? entry.model,
      encoded: true,
      effort: level,
      family: entry.model,
      levels: entry.levels,
    };
  }
  const family = entry ? entry.model : picked.model;
  return {
    model: family,
    encoded: false,
    effort,
    family,
    levels: [],
  };
};

const AGENTS = [
  {
    id: 'claude',
    name: 'claude',
    title: 'Claude Code',
    bins: ['claude'],
    models: ['default', 'sonnet', 'opus', 'haiku', 'fable'],
    modelFlag: '--model',
    effortFlag: '--effort',
    effortValue: plainEffort,
    efforts: ['default', 'low', 'medium', 'high', 'max'],
    prefix: [],
    listCmds: [['--list-models'], ['models'], ['model', 'list']],
    parseModels: parseNameList,
  },
  {
    id: 'opencode',
    name: 'opencode',
    title: 'OpenCode',
    bins: ['opencode'],
    models: ['default', 'sonnet', 'opus', 'gpt-5'],
    modelFlag: '--model',
    effortFlag: '',
    effortValue: plainEffort,
    efforts: [],
    prefix: [],
    listCmds: [['models']],
    parseModels: parseNameList,
  },
  {
    id: 'cursor',
    name: 'cursor',
    title: 'Cursor',
    bins: ['cursor-agent', 'agent'],
    models: ['default', 'auto', 'grok-4.6', 'composer-2', 'gpt-5', 'sonnet'],
    modelFlag: '--model',
    effortFlag: '--effort',
    effortValue: plainEffort,
    efforts: ['default', 'low', 'medium', 'high', 'xhigh'],
    prefix: ['--print', '--trust'],
    login: ['login'],
    listCmds: [['--list-models'], ['models']],
    parseModels: parseCursorModels,
  },
  {
    id: 'codex',
    name: 'codex',
    title: 'Codex',
    bins: ['codex'],
    models: ['default', 'gpt-5.1-codex', 'gpt-5', 'o3'],
    modelFlag: '--model',
    effortFlag: '-c',
    effortValue: codexEffort,
    efforts: ['default', 'low', 'medium', 'high', 'xhigh'],
    prefix: [],
    listCmds: [
      ['debug', 'models', '--bundled'],
      ['debug', 'models'],
      ['models'],
    ],
    parseModels: parseJsonModels,
  },
];

const pathDirs = (env) => {
  const raw = env.PATH ?? env.Path ?? '';
  return raw.split(path.delimiter).filter(Boolean);
};

const winNames = (name, env) => {
  const ext = env.PATHEXT || '.EXE;.CMD;.BAT;.COM';
  const parts = ext.split(';').filter(Boolean);
  const upper = name.toUpperCase();
  const names = [name];
  for (const item of parts) {
    const suffix = item.startsWith('.') ? item : `.${item}`;
    if (upper.endsWith(suffix.toUpperCase())) return [name];
    names.push(`${name}${suffix}`);
  }
  return names;
};

const binNames = (name, env) => (IS_WIN ? winNames(name, env) : [name]);

const isBin = (file) => {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    if (IS_WIN) return true;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const findBin = (name, env = process.env) => {
  for (const dir of pathDirs(env)) {
    for (const file of binNames(name, env)) {
      const full = path.join(dir, file);
      if (isBin(full)) return full;
    }
  }
  return '';
};

const findAgentBin = (spec, env = process.env) => {
  for (const name of spec.bins) {
    const found = findBin(name, env);
    if (found) return found;
  }
  return '';
};

const shortPath = (file) => {
  if (!file) return '';
  const home = os.homedir();
  if (!home) return file;
  if (file === home || file.startsWith(`${home}${path.sep}`)) {
    return `~${file.slice(home.length)}`;
  }
  return file;
};

const detectAgents = (env = process.env) =>
  AGENTS.map((spec) => {
    const bin = findAgentBin(spec, env);
    return {
      id: spec.id,
      name: spec.name,
      title: spec.title,
      bins: spec.bins,
      models: spec.models.slice(),
      spec,
      bin,
      path: shortPath(bin),
    };
  });

const listModels = async (bin, spec, options = {}) => {
  if (!bin || !spec || !spec.listCmds) return [];
  const run = options.run ?? runProc;
  const env = { ...process.env, ...options.env };
  const timeout = options.timeout ?? LIST_MS;
  for (const args of spec.listCmds) {
    let result;
    try {
      result = await run(bin, args, { env, timeout });
    } catch {
      continue;
    }
    const text = `${result.stdout}\n${result.stderr}`;
    const names = spec.parseModels(text);
    if (names.length) return names;
  }
  return [];
};

const splitArgs = (text) => `${text ?? ''}`.trim().split(/\s+/).filter(Boolean);

const quoteArg = (text) => {
  const arg = `${text ?? ''}`;
  if (!arg) return '""';
  if (!/[\s"'\\]/.test(arg)) return arg;
  return `"${arg.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
};

const launchArgs = (launch) => {
  const args = launch.args ?? [];
  if (launch.prompt && args.at(-1) === launch.prompt) {
    return args.slice(0, -1);
  }
  return args;
};

const commandLine = (launch) => {
  if (!launch || !launch.ok || !launch.cmd) return '';
  const bin = path.basename(launch.cmd);
  const args = launchArgs(launch).map(quoteArg);
  const plan = launch.plan ? quoteArg(launch.plan) : '';
  return [bin, ...args, plan].filter(Boolean).join(' ');
};

const planRef = (reviewPath, cwd) => {
  const file = `${reviewPath ?? ''}`;
  if (!file || !cwd) return file;
  const rel = path.relative(cwd, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return file;
  return rel.split(path.sep).join('/');
};

const planPrompt = (reviewPath) =>
  `Read and execute the reslop repair plan at ${reviewPath}. ` +
  'Follow the agent instructions. Work through unchecked items.';

const AUTH_NEED = /authentication required/i;

const needsAuth = (text) => AUTH_NEED.test(`${text ?? ''}`);

const effortArgs = (spec, effort) => {
  if (!spec || !spec.effortFlag) return [];
  const level = `${effort ?? ''}`.trim();
  if (!level || level === 'default') return [];
  const value = spec.effortValue ? spec.effortValue(level) : level;
  return [spec.effortFlag, value];
};

const buildLaunch = (row, choice, reviewPath, cwd) => {
  if (!row || !row.bin) return { ok: false, error: 'not installed' };
  if (!reviewPath) return { ok: false, error: 'no plan' };
  const spec = row.spec;
  const picked = choice ?? emptyChoice(row);
  const concrete = resolveModel(row, picked);
  const args = [...spec.prefix];
  if (concrete.model && concrete.model !== 'default') {
    args.push(spec.modelFlag, concrete.model);
  }
  if (!concrete.encoded) args.push(...effortArgs(spec, concrete.effort));
  args.push(...splitArgs(picked.extra));
  const plan = planRef(reviewPath, cwd) || reviewPath;
  const prompt = planPrompt(plan);
  args.push(prompt);
  const launch = {
    ok: true,
    cmd: row.bin,
    args,
    prompt,
    plan,
    id: row.id,
    name: row.name,
  };
  launch.command = commandLine(launch);
  return launch;
};

const buildLogin = (row) => {
  if (!row || !row.bin) return { ok: false, error: 'not installed' };
  const args = row.spec && row.spec.login;
  if (!args || !args.length) return { ok: false, error: 'no login' };
  const launch = {
    ok: true,
    cmd: row.bin,
    args: args.slice(),
    prompt: '',
    plan: '',
    id: row.id,
    name: row.name,
    kind: 'login',
  };
  launch.command = commandLine(launch);
  return launch;
};

const startAgent = (cwd, launch, onData, onClose) => {
  let raw = '';
  let settled = false;
  let stopped = false;
  const finish = (status) => {
    if (settled) return;
    settled = true;
    onClose({ status, text: raw });
  };
  let child;
  try {
    const opts = spawnBase({
      cwd,
      env: commandEnv(),
      detached: process.platform !== 'win32',
    });
    child = spawn(launch.cmd, launch.args, opts);
  } catch (error) {
    raw = `${error.message}\n`;
    finish(1);
    return { kill() {} };
  }
  const push = (chunk) => {
    if (stopped || settled) return;
    raw += chunk;
    onData(raw);
  };
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    stream.setEncoding('utf8');
    stream.on('data', push);
  }
  if (child.stdin) {
    try {
      child.stdin.end();
    } catch {
      // closed
    }
  }
  child.on('error', (error) => {
    if (!stopped) raw += `${error.message}\n`;
    finish(1);
  });
  child.on('close', (status) => finish(status));
  return {
    kill() {
      if (stopped || settled) return;
      stopped = true;
      killTree(child);
    },
  };
};

module.exports = {
  AGENTS,
  findBin,
  findAgentBin,
  shortPath,
  detectAgents,
  listModels,
  mergeModels,
  groupModels,
  splitEffortModel,
  resolveModel,
  fitEffort,
  parseCursorModels,
  parseNameList,
  parseJsonModels,
  splitArgs,
  planPrompt,
  emptyChoice,
  buildLaunch,
  buildLogin,
  needsAuth,
  commandLine,
  planRef,
  startAgent,
};
