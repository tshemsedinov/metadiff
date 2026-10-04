'use strict';

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { spawn } = childProcess;
const metautil = require('metautil');
const { jsonParse } = metautil;
const ansi = require('./ansi.js');
const { stripAnsi, visibleWidth } = ansi;
const utilities = require('./utilities.js');
const { npmBin, npmOpts, spawnBase, unquote, dateStamp } = utilities;

const MANIFEST = 'package.json';
const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];

const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

const readManifest = (root) => {
  const text = readText(path.join(root, MANIFEST));
  if (!text) return null;
  const pkg = jsonParse(text);
  if (!pkg || typeof pkg !== 'object') return null;
  return pkg;
};

const writeManifest = (root, pkg) => {
  const file = path.join(root, MANIFEST);
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
};

const scriptEntries = (pkg) => {
  const scripts = pkg.scripts;
  if (!scripts || typeof scripts !== 'object') return [];
  const entries = [];
  for (const name of Object.keys(scripts)) {
    const command = scripts[name];
    if (typeof command !== 'string') continue;
    entries.push({ name, command, kind: 'script' });
  }
  return entries;
};

const binNames = (pkg) => {
  if (!pkg || typeof pkg !== 'object') return [];
  const bin = pkg.bin;
  if (typeof bin === 'string' && bin) {
    const raw = `${pkg.name ?? ''}`;
    const base = raw.startsWith('@') ? raw.split('/')[1] : raw;
    return base ? [base] : [];
  }
  if (!bin || typeof bin !== 'object' || Array.isArray(bin)) return [];
  const isPath = (name) => typeof bin[name] === 'string' && bin[name] !== '';
  return Object.keys(bin).filter(isPath);
};

const declaredNames = (pkg) => {
  const names = [];
  for (const section of SECTIONS) {
    const map = pkg[section];
    if (!map || typeof map !== 'object') continue;
    names.push(...Object.keys(map));
  }
  return names;
};

const depManifest = (root, name) => {
  const parts = name.startsWith('@') ? name.split('/').slice(0, 2) : [name];
  return path.join(root, 'node_modules', ...parts, MANIFEST);
};

const binEntries = (root, pkg, taken) => {
  const entries = [];
  const seen = new Set(taken);
  for (const name of declaredNames(pkg)) {
    const dep = jsonParse(readText(depManifest(root, name)));
    for (const bin of binNames(dep)) {
      if (seen.has(bin)) continue;
      seen.add(bin);
      entries.push({ name: bin, command: bin, kind: 'bin', package: name });
    }
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  return entries;
};

const listCommands = (root) => {
  const pkg = readManifest(root);
  if (!pkg) return [];
  const scripts = scriptEntries(pkg);
  const taken = scripts.map((entry) => entry.name);
  return [...scripts, ...binEntries(root, pkg, taken)];
};

const isPassingTest = (line) => {
  const plain = stripAnsi(line);
  const text = plain.trim();
  if (!text) return false;
  if (/^\s*[✔✓√] /.test(plain)) return true;
  if (/^ok \d+ /.test(text)) return true;
  return /^\s*PASS\b/.test(plain);
};

const indentStack = (line) => {
  if (!/^\s*at\s/.test(stripAnsi(line))) return line;
  return `  ${line.trimStart()}`;
};

const withoutNodeFrame = (line) => {
  const plain = stripAnsi(line);
  if (!plain.includes('(node:')) return line;
  return /\{\s*$/.test(plain) ? '{' : null;
};

const withSep = (dir) => {
  const sep = dir.includes('\\') ? '\\' : '/';
  if (dir.endsWith(sep)) return dir;
  return `${dir}${sep}`;
};

const stripOne = (text, dir) => {
  if (!dir) return text;
  let next = text.split(withSep(dir)).join('');
  if (next.includes(dir)) next = next.split(dir).join('.');
  return next;
};

const relativize = (text, root) => {
  if (!root) return text;
  const slash = root.replaceAll('\\', '/');
  const back = slash.replaceAll('/', '\\');
  const resolved = path.resolve(root).replaceAll('\\', '/');
  const resolvedBack = resolved.replaceAll('/', '\\');
  let next = text;
  for (const dir of [slash, back, resolved, resolvedBack]) {
    next = stripOne(next, dir);
  }
  return next;
};

const traceLine = (line, root) => {
  const next = withoutNodeFrame(line);
  if (next === null) return null;
  return relativize(indentStack(next), root);
};

const objectEnd = (lines, start) => {
  if (stripAnsi(lines[start]).trim() !== '{') return -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (stripAnsi(lines[i]).trim() === '}') return i;
  }
  return -1;
};

const parseInspect = (lines) => {
  const entries = [];
  for (const line of lines) {
    const plain = stripAnsi(line).trim().replace(/,$/, '');
    const match = /^([A-Za-z_][\w]*)\s*:\s*([\s\S]*)$/.exec(plain);
    if (!match) {
      if (!entries.length) return null;
      const last = entries[entries.length - 1];
      last[1] = `${last[1]}\n${plain}`;
      continue;
    }
    entries.push([match[1], unquote(match[2])]);
  }
  return entries.length ? entries : null;
};

const showValue = (value) => {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return `${value}`;
  }
  return JSON.stringify(value);
};

const parseObject = (lines) => {
  try {
    const value = JSON.parse(lines.join('\n'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const entries = Object.keys(value).map((key) => [
      key,
      showValue(value[key]),
    ]);
    return entries.length ? entries : null;
  } catch {
    return parseInspect(lines.slice(1, -1));
  }
};

const TABLE_KEY = '\x1b[900m';
const TABLE_VAL = '\x1b[901m';

const formatTable = (entries) => {
  const prepared = [];
  let keyWidth = 0;
  for (const entry of entries) {
    const lines = `${entry[1]}`.split('\n').filter((line) => line.trim());
    if (!lines.length) continue;
    prepared.push([entry[0], lines]);
    keyWidth = Math.max(keyWidth, visibleWidth(entry[0]));
  }
  const rows = [];
  for (const entry of prepared) {
    const lines = entry[1];
    for (let i = 0; i < lines.length; i++) {
      const name = i === 0 ? entry[0] : '';
      const pad = ' '.repeat(Math.max(0, keyWidth - visibleWidth(name)));
      const key = ` ${pad}${name} `;
      const value = ` ${lines[i]} `;
      rows.push(`${TABLE_KEY}${key}${TABLE_VAL}  ${value}`);
    }
  }
  return rows;
};

const foldObjects = (lines) => {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const end = objectEnd(lines, i);
    const entries = end < 0 ? null : parseObject(lines.slice(i, end + 1));
    if (!entries) {
      out.push(lines[i]);
      continue;
    }
    if (out.length && out[out.length - 1] !== '') out.push('');
    out.push(...formatTable(entries));
    i = end;
  }
  return out;
};

const reduceOutput = (text, root, status) => {
  const kept = [];
  for (const line of `${text ?? ''}`.split(/\r?\n/)) {
    if (isPassingTest(line)) continue;
    const next = traceLine(line, root);
    if (next !== null) kept.push(next);
  }
  const folded = foldObjects(kept);
  while (folded.length && folded[folded.length - 1] === '') folded.pop();
  if (status !== '') folded.push(`exit ${status ?? 'null'}`);
  if (!folded.length) return '';
  return `${folded.join('\n')}\n`;
};

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
    if (!name.endsWith('.log') || !isStaleLog(name, now)) continue;
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
  const rawName = name.replace(/\.log$/, '.raw.log');
  const full = path.join(dir, name);
  const rawFull = path.join(dir, rawName);
  return { name, full, dir, rawName, rawFull };
};

const nextLogFile = (root, command, now = new Date()) => {
  const date = dateStamp(now);
  const dir = path.join(root, LOG_DIR);
  let slot = null;
  for (let index = 1; index <= 100; index++) {
    slot = logSlot(dir, logFileName(command, date, index));
    if (!fs.existsSync(slot.full) && !fs.existsSync(slot.rawFull)) break;
  }
  return slot;
};

const logText = (text) =>
  stripAnsi(text)
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n');

const saveLogs = async (slot, reduced, raw) => {
  await fs.promises.mkdir(slot.dir, { recursive: true });
  await Promise.all([
    fs.promises.writeFile(slot.full, logText(reduced)),
    fs.promises.writeFile(slot.rawFull, logText(raw)),
  ]);
};

const orderedScripts = (pkg) => {
  const scripts = pkg.scripts;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) {
    return {};
  }
  return scripts;
};

const pickScripts = (scripts, names) => {
  const ordered = {};
  for (const key of names) ordered[key] = scripts[key];
  return ordered;
};

const upsertScript = (pkg, prev, next) => {
  const scripts = orderedScripts(pkg);
  const names = Object.keys(scripts);
  if (!prev || !names.includes(prev)) {
    pkg.scripts = { ...scripts, [next.name]: next.command };
    return;
  }
  const ordered = {};
  for (const key of names) {
    if (key === prev) ordered[next.name] = next.command;
    else if (key !== next.name) ordered[key] = scripts[key];
  }
  pkg.scripts = ordered;
};

const saveScript = (root, prev, next) => {
  const pkg = readManifest(root) ?? {};
  upsertScript(pkg, prev, next);
  writeManifest(root, pkg);
};

const removeScript = (root, name) => {
  const pkg = readManifest(root);
  if (!pkg) return false;
  const scripts = orderedScripts(pkg);
  if (!Object.hasOwn(scripts, name)) return false;
  const names = Object.keys(scripts).filter((key) => key !== name);
  pkg.scripts = pickScripts(scripts, names);
  writeManifest(root, pkg);
  return true;
};

const reorderScript = (root, name, delta) => {
  const pkg = readManifest(root);
  if (!pkg) return false;
  const scripts = orderedScripts(pkg);
  const names = Object.keys(scripts);
  const at = names.indexOf(name);
  const next = at + delta;
  if (at < 0 || next < 0 || next >= names.length) return false;
  names[at] = names[next];
  names[next] = name;
  pkg.scripts = pickScripts(scripts, names);
  writeManifest(root, pkg);
  return true;
};

const signalPid = (pid, signal) => {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
};

const killTree = (proc) => {
  const pid = proc.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    const killer = spawn(
      'taskkill',
      ['/pid', String(pid), '/t', '/f'],
      spawnBase({ stdio: 'ignore' }),
    );
    killer.on('error', () => proc.kill());
    return;
  }
  const group = -pid;
  if (!signalPid(group, 'SIGTERM')) signalPid(pid, 'SIGTERM');
  const timer = setTimeout(() => {
    if (!signalPid(group, 'SIGKILL')) signalPid(pid, 'SIGKILL');
  }, 200);
  timer.unref();
  proc.once('close', () => clearTimeout(timer));
};

const commandEnv = (base = process.env) => {
  const env = { ...base };
  if (!env.NO_COLOR && !env.FORCE_COLOR) env.FORCE_COLOR = '1';
  if (!env.TERM) env.TERM = 'xterm-256color';
  env.RESLOP_OUTPUT = 'raw';
  return env;
};

const startNpm = (cwd, entry, onData, onClose) => {
  let raw = '';
  let settled = false;
  let stopped = false;
  const finish = (status) => {
    if (settled) return;
    settled = true;
    onClose({ status, text: raw });
  };
  const isBin = entry.kind === 'bin';
  const args = isBin ? ['exec', '--', entry.name] : ['run', entry.name];
  let child;
  try {
    const opts = npmOpts({
      cwd,
      env: commandEnv(),
      detached: process.platform !== 'win32',
    });
    child = spawn(npmBin(), args, opts);
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
  listCommands,
  reduceOutput,
  logFileName,
  nextLogFile,
  saveLogs,
  staleLogFiles,
  removeStaleLogs,
  saveScript,
  removeScript,
  reorderScript,
  startNpm,
  commandEnv,
  killTree,
  isPassingTest,
  traceLine,
  relativize,
  TABLE_KEY,
  TABLE_VAL,
  formatTable,
};
