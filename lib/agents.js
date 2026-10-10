'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { IS_WIN, runProc, spawnBase } = require('./utilities.js');
const { commandEnv, killTree } = require('./npm-commands.js');
const { startPty } = require('./pty-agent.js');
const { ensurePlanAllows } = require('./agent-allow.js');
const { hasAgentSession } = require('./agent-sessions.js');
const models = require('./agent-models.js');
const { parseNameList, parseCursorModels, parseCursorWide } = models;
const { parseJsonModels, catalogOf, emptyChoice, contextMenu } = models;

const LIST_MS = 5000;
const AUTH_NEED = /authentication required/i;

const plainEffort = (level) => level;
const codexEffort = (level) => `model_reasoning_effort=${level}`;

const defineAgent = (spec) => ({
  id: spec.id,
  name: spec.name ?? spec.id,
  title: spec.title,
  bins: spec.bins,
  models: spec.models,
  modelFlag: spec.modelFlag ?? '--model',
  effortFlag: spec.effortFlag ?? '',
  effortValue: spec.effortValue ?? plainEffort,
  efforts: spec.efforts ?? [],
  modelParams: spec.modelParams === true,
  prefix: spec.prefix ?? [],
  login: spec.login ?? [],
  status: spec.status ?? [],
  contexts: spec.contexts ?? [],
  resume: spec.resume ?? [],
  resumeWith: spec.resumeWith ?? null,
  listCmds: spec.listCmds,
  parseModels: spec.parseModels ?? parseNameList,
  wideModels: spec.wideModels ?? null,
  pty: spec.pty === true,
  promptFlag: spec.promptFlag ?? '',
});

const AGENTS = [
  defineAgent({
    id: 'claude',
    title: 'Claude Code',
    bins: ['claude'],
    models: ['default', 'sonnet', 'opus', 'haiku', 'fable'],
    effortFlag: '--effort',
    efforts: ['default', 'low', 'medium', 'high', 'max'],
    resume: ['--continue'],
    resumeWith: (id) => ['--resume', id],
    listCmds: [['--list-models'], ['models'], ['model', 'list']],
  }),
  defineAgent({
    id: 'opencode',
    title: 'OpenCode',
    bins: ['opencode'],
    models: ['default', 'sonnet', 'opus', 'gpt-5'],
    resume: ['--continue'],
    resumeWith: (id) => ['--session', id],
    listCmds: [['models']],
  }),
  defineAgent({
    id: 'cursor',
    title: 'Cursor',
    bins: ['cursor-agent', 'agent'],
    models: ['default', 'auto', 'grok-4.6', 'composer-2', 'gpt-5', 'sonnet'],
    modelParams: true,
    efforts: ['default', 'low', 'medium', 'high', 'xhigh'],
    prefix: ['--trust'],
    pty: true,
    login: ['login'],
    status: ['status', '--format', 'json'],
    contexts: ['256k', '1m'],
    resume: ['--continue'],
    resumeWith: (id) => [`--resume=${id}`],
    listCmds: [['--list-models'], ['models']],
    parseModels: parseCursorModels,
    wideModels: parseCursorWide,
  }),
  defineAgent({
    id: 'codex',
    title: 'Codex',
    bins: ['codex'],
    models: ['default', 'gpt-5.1-codex', 'gpt-5', 'o3'],
    effortFlag: '-c',
    effortValue: codexEffort,
    efforts: ['default', 'low', 'medium', 'high', 'xhigh'],
    resume: ['resume', '--last'],
    resumeWith: (id) => ['resume', id],
    listCmds: [
      ['debug', 'models', '--bundled'],
      ['debug', 'models'],
      ['models'],
    ],
    parseModels: parseJsonModels,
  }),
  defineAgent({
    id: 'agy',
    title: 'Antigravity',
    bins: ['agy'],
    models: [
      'default',
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.6-flash',
      'gemini-3.1-pro',
      'claude-sonnet-4-6',
      'claude-opus-4-6-thinking',
    ],
    effortFlag: '--effort',
    efforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
    promptFlag: '-p',
    resume: ['--continue'],
    resumeWith: (id) => ['--conversation', id],
    listCmds: [['models']],
  }),
];

const pathDirs = (env) => {
  const raw = env.PATH ?? env.Path ?? '';
  return raw.split(path.delimiter).filter(Boolean);
};

const winNames = (name, env) => {
  const ext = env.PATHEXT || '.EXE;.CMD;.BAT;.COM';
  const upper = name.toUpperCase();
  const names = [name];
  for (const item of ext.split(';').filter(Boolean)) {
    const suffix = item.startsWith('.') ? item : `.${item}`;
    if (upper.endsWith(suffix.toUpperCase())) return [name];
    names.push(`${name}${suffix}`);
  }
  return names;
};

const binNames = (name, env) => (IS_WIN ? winNames(name, env) : [name]);

const isBin = (file) => {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (!IS_WIN) fs.accessSync(file, fs.constants.X_OK);
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

const findAgentBin = (spec, env) => {
  for (const name of spec.bins) {
    const found = findBin(name, env);
    if (found) return found;
  }
  return '';
};

const detectAgents = (env = process.env) =>
  AGENTS.map((spec) => ({
    id: spec.id,
    name: spec.name,
    spec,
    models: spec.models.slice(),
    wide: null,
    bin: findAgentBin(spec, env),
  }));

const canLogin = (row) =>
  Boolean(row && row.bin && row.spec && row.spec.login.length);

const tryList = async (run, bin, args, options) => {
  try {
    return await run(bin, args, options);
  } catch {
    return null;
  }
};

const listedOf = (listed) => {
  if (Array.isArray(listed)) {
    const wide = Array.isArray(listed.wide) ? listed.wide : null;
    return { names: listed, wide };
  }
  if (!listed || typeof listed !== 'object') return { names: [], wide: null };
  return {
    names: Array.isArray(listed.names) ? listed.names : [],
    wide: Array.isArray(listed.wide) ? listed.wide : null,
  };
};

const listModels = async (bin, spec, options = {}) => {
  const listed = { names: [], wide: null };
  if (!bin || !spec) return listed;
  const run = options.run ?? runProc;
  const env = { ...process.env, ...options.env };
  const timeout = options.timeout ?? LIST_MS;
  for (const args of spec.listCmds) {
    const result = await tryList(run, bin, args, { env, timeout });
    if (!result) continue;
    const text = `${result.stdout}\n${result.stderr}`;
    const names = spec.parseModels(text);
    if (!names.length) continue;
    listed.names = names;
    listed.wide = spec.wideModels ? spec.wideModels(text) : null;
    break;
  }
  return listed;
};

const splitArgs = (text) => `${text ?? ''}`.trim().split(/\s+/).filter(Boolean);

const quoteArg = (text) => {
  const arg = `${text ?? ''}`;
  if (!arg) return '""';
  if (!/[\s"'\\]/.test(arg)) return arg;
  return `"${arg.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
};

const commandLine = (launch) => {
  if (!launch || !launch.ok || !launch.cmd) return '';
  const args = launch.args ?? [];
  const hasPrompt = launch.prompt && args.at(-1) === launch.prompt;
  const shown = hasPrompt ? args.slice(0, -1) : args;
  const plan = launch.plan ? quoteArg(launch.plan) : '';
  const bin = path.basename(launch.cmd);
  return [bin, ...shown.map(quoteArg), plan].filter(Boolean).join(' ');
};

const planRef = (reviewPath, cwd) => {
  const file = `${reviewPath ?? ''}`;
  if (!file || !cwd) return file;
  const rel = path.relative(cwd, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return file;
  return rel.split(path.sep).join('/');
};

const planPrompt = (reviewPath) =>
  `Read and execute repair plan at ${reviewPath}`;

const needsAuth = (text) => AUTH_NEED.test(`${text ?? ''}`);

const parsedAuth = (raw) => {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const data = JSON.parse(raw.slice(start, end + 1));
    if (!data || typeof data !== 'object') return null;
    if (typeof data.isAuthenticated === 'boolean') return data.isAuthenticated;
    if (data.status === 'authenticated') return true;
    if (data.status === 'unauthenticated') return false;
    if (data.status === 'partially-authenticated') return false;
  } catch {
    return null;
  }
  return null;
};

const authState = (text) => {
  const raw = `${text ?? ''}`.trim();
  if (!raw) return null;
  const parsed = parsedAuth(raw);
  if (parsed !== null) return parsed;
  if (/not logged in/i.test(raw)) return false;
  if (/logged in/i.test(raw)) return true;
  return null;
};

const probeAuth = async (row) => {
  const args = row && row.spec ? row.spec.status : [];
  if (!row || !row.bin || !args.length) return null;
  const result = await runProc(row.bin, args, {
    env: commandEnv(),
    timeout: LIST_MS,
  });
  if (!result || result.error) return null;
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return authState(text);
};

const effortArgs = (spec, effort) => {
  const level = `${effort ?? ''}`.trim();
  if (!spec.effortFlag || !level || level === 'default') return [];
  return [spec.effortFlag, spec.effortValue(level)];
};

const paramPart = (key, value) => {
  const text = `${value ?? ''}`.trim();
  if (!text) return '';
  return `${key}=${text}`;
};

const withParams = (model, parts) => {
  const body = parts.filter(Boolean).join(',');
  if (!body || !model || model === 'default') return model;
  return `${model}[${body}]`;
};

const effortParam = (model, effort) => {
  const level = `${effort ?? ''}`.trim();
  if (!level || level === 'default') return '';
  if (`${model ?? ''}`.endsWith(`-${level}`)) return '';
  return level;
};

const fastParam = (model, fast) => {
  if (fast !== true) return '';
  if (`${model ?? ''}`.endsWith('-fast')) return '';
  return 'true';
};

const modelArg = (spec, resolved, context, fast) => {
  const parts = [paramPart('context', context)];
  const plain = spec.modelParams && !resolved.encoded;
  if (!plain) return withParams(resolved.model, parts);
  const level = effortParam(resolved.model, resolved.effort);
  parts.push(paramPart('effort', level));
  parts.push(paramPart('fast', fastParam(resolved.model, fast)));
  return withParams(resolved.model, parts);
};

const createLaunch = (row, kind, args, plan = '', prompt = '') => {
  const launch = {
    ok: true,
    cmd: row.bin,
    args,
    prompt,
    plan,
    id: row.id,
    name: row.name,
    kind,
    command: '',
  };
  launch.command = commandLine(launch);
  return launch;
};

const resumeArgs = (spec, sessionId) => {
  const id = `${sessionId ?? ''}`;
  if (!id || !spec.resumeWith) return [];
  return spec.resumeWith(id);
};

const isSubcommand = (args) => args.length > 0 && !args[0].startsWith('-');

const buildLaunch = (row, choice, reviewPath, cwd, sessionId = '') => {
  if (!row || !row.bin) return { ok: false, error: 'not installed' };
  if (!reviewPath) return { ok: false, error: 'no plan' };
  const { spec } = row;
  const picked = choice ?? emptyChoice(row);
  const catalog = catalogOf(row.models);
  const resolved = catalog.withFast(catalog.resolve(picked), picked.fast);
  const asked = `${picked.context ?? ''}`.trim();
  const menu = contextMenu(resolved.model, row.wide, catalog, spec.contexts);
  const pass = menu.includes(asked) && asked !== menu[0] ? asked : '';
  const model = modelArg(spec, resolved, pass, picked.fast);
  const plan = planRef(reviewPath, cwd) || reviewPath;
  const prompt = planPrompt(plan);
  const continued = resumeArgs(spec, sessionId);
  const subcommand = isSubcommand(continued);
  const args = [];
  if (subcommand) args.push(...continued);
  args.push(...spec.prefix);
  if (!subcommand) args.push(...continued);
  if (model && model !== 'default') args.push(spec.modelFlag, model);
  if (!spec.modelParams && !resolved.encoded) {
    args.push(...effortArgs(spec, resolved.effort));
  }
  const promptArgs = spec.promptFlag ? [spec.promptFlag, prompt] : [prompt];
  args.push(...splitArgs(picked.extra), ...promptArgs);
  const launch = createLaunch(row, 'run', args, plan, prompt);
  launch.pty = spec.pty === true;
  const id = `${sessionId ?? ''}`;
  if (id) launch.session = id;
  return launch;
};

const buildLogin = (row) => {
  if (!row || !row.bin) return { ok: false, error: 'not installed' };
  if (!canLogin(row)) return { ok: false, error: 'no login' };
  return createLaunch(row, 'login', row.spec.login.slice());
};

const startPipe = (cwd, launch, onData, onClose) => {
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
    const options = spawnBase({ cwd, env: commandEnv(), detached: !IS_WIN });
    child = spawn(launch.cmd, launch.args, options);
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
  if (child.stdin) child.stdin.on('error', () => {}).end();
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
    raw() {
      return raw;
    },
  };
};

const startAgent = (cwd, launch, onData, onClose) => {
  if (!launch.pty || IS_WIN) return startPipe(cwd, launch, onData, onClose);
  ensurePlanAllows();
  const pty = startPty(cwd, launch, onData, onClose, commandEnv());
  if (pty) return pty;
  const args = ['--print', ...launch.args];
  const notice = 'approval prompts need python3\n';
  return startPipe(
    cwd,
    { ...launch, args },
    (text) => onData(text.startsWith(notice) ? text : `${notice}${text}`),
    onClose,
  );
};

module.exports = {
  ...models,
  AGENTS,
  findBin,
  detectAgents,
  canLogin,
  listedOf,
  listModels,
  splitArgs,
  planPrompt,
  planRef,
  needsAuth,
  authState,
  probeAuth,
  commandLine,
  buildLaunch,
  buildLogin,
  hasAgentSession,
  startAgent,
};
