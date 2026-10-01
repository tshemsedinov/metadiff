'use strict';

const fs = require('node:fs');
const path = require('node:path');

const commands = require('../npm-commands.js');
const { listCommands } = commands;
const deps = require('../deps.js');
const { MANIFEST } = deps;
const watch = require('../session/watch.js');
const { MODULES_STAMP } = watch;

const MODULES = 'node_modules';
const WORKERS = 8;
const TOP_PACKAGES = 8;

const readJson = async (file) => {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch {
    return null;
  }
};

const sectionCount = (pkg, section) => {
  const map = pkg && pkg[section];
  if (!map || typeof map !== 'object') return 0;
  return Object.keys(map).length;
};

const modulesStamp = async (top) => {
  try {
    const stat = await fs.promises.stat(path.join(top, MODULES_STAMP));
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return '';
  }
};

const packageName = (root, file) => {
  const rel = path.relative(root, file);
  const parts = rel.split(path.sep);
  const head = parts[0];
  if (!head || head.startsWith('.')) return '';
  if (!head.startsWith('@')) return head;
  const name = parts[1];
  if (!name || name.startsWith('.')) return '';
  return `${head}/${name}`;
};

const rankedPackages = (totals) => {
  const list = [];
  for (const [name, bytes] of totals) list.push({ name, bytes });
  list.sort(
    (left, right) =>
      right.bytes - left.bytes || left.name.localeCompare(right.name, 'en'),
  );
  return list;
};

const declaredNames = (pkg, section) => {
  const map = pkg && pkg[section];
  if (!map || typeof map !== 'object') return [];
  return Object.keys(map);
};

const devOnlyNames = (pkg, lock) => {
  const keep = new Set([
    ...declaredNames(pkg, 'dependencies'),
    ...declaredNames(pkg, 'optionalDependencies'),
  ]);
  const names = new Set();
  for (const name of declaredNames(pkg, 'devDependencies')) {
    if (!keep.has(name)) names.add(name);
  }
  const packages = lock && lock.packages;
  if (!packages || typeof packages !== 'object') return names;
  const prefix = 'node_modules/';
  for (const key of Object.keys(packages)) {
    const entry = packages[key];
    if (!entry || !entry.dev || !key.startsWith(prefix)) continue;
    const name = key.slice(prefix.length);
    if (!name || name.includes('/node_modules/') || keep.has(name)) continue;
    names.add(name);
  }
  return names;
};

const listedPackages = (ranked, devNames) => {
  const deps = [];
  const devs = [];
  for (const item of ranked || []) {
    const row = {
      name: item.name,
      bytes: item.bytes,
      dev: devNames.has(item.name),
    };
    if (row.dev) devs.push(row);
    else deps.push(row);
  }
  return [...deps, ...devs].slice(0, TOP_PACKAGES);
};

const lockVersion = (lock, name) => {
  const packages = lock && lock.packages;
  if (!packages || typeof packages !== 'object') return '';
  const entry = packages[`node_modules/${name}`];
  if (!entry || typeof entry.version !== 'string') return '';
  return entry.version;
};

const stampVersions = (list, lock) =>
  list.map((item) => ({
    name: item.name,
    bytes: item.bytes,
    dev: item.dev === true,
    version: lockVersion(lock, item.name),
  }));

const measureModules = async (root) => {
  let total = 0;
  const totals = new Map();
  const queue = [root];
  const worker = async () => {
    while (queue.length) {
      const dir = queue.pop();
      let entries;
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      const files = [];
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) queue.push(full);
        else if (entry.isFile()) files.push(full);
      }
      const sizes = await Promise.all(
        files.map((file) =>
          fs.promises.lstat(file).then(
            (stat) => ({ name: packageName(root, file), bytes: stat.size }),
            () => ({ name: '', bytes: 0 }),
          ),
        ),
      );
      for (const item of sizes) {
        total += item.bytes;
        if (!item.name || !item.bytes) continue;
        const prev = totals.get(item.name) ?? 0;
        totals.set(item.name, prev + item.bytes);
      }
    }
  };
  await Promise.all(Array.from({ length: WORKERS }, worker));
  return { bytes: total, ranked: rankedPackages(totals) };
};

const dirSize = async (root) => {
  const measured = await measureModules(root);
  return measured.bytes;
};

const installedCount = async (top) => {
  const lock = await readJson(path.join(top, MODULES_STAMP));
  if (lock && lock.packages && typeof lock.packages === 'object') {
    let count = 0;
    for (const key of Object.keys(lock.packages)) {
      if (key && !lock.packages[key].link) count += 1;
    }
    return count;
  }
  let count = 0;
  let entries;
  try {
    entries = await fs.promises.readdir(path.join(top, MODULES));
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    if (!name.startsWith('@')) {
      count += 1;
      continue;
    }
    const scoped = await fs.promises.readdir(path.join(top, MODULES, name));
    count += scoped.length;
  }
  return count;
};

const readModules = async (top, previous = null) => {
  const stamp = await modulesStamp(top);
  if (previous && stamp && previous.stamp === stamp && previous.ranked) {
    return previous;
  }
  const dir = path.join(top, MODULES);
  const [count, measured] = await Promise.all([
    installedCount(top),
    measureModules(dir),
  ]);
  return {
    stamp,
    count,
    bytes: measured.bytes,
    ranked: measured.ranked,
  };
};

const readNpmSummary = async (top, previous = null) => {
  const pkg = await readJson(path.join(top, MANIFEST));
  const scripts = listCommands(top)
    .filter((entry) => entry.kind === 'script')
    .map((entry) => entry.name);
  const cached = previous ? previous.modules : null;
  const modules = await readModules(top, cached);
  const lock = await readJson(path.join(top, MODULES_STAMP));
  const ranked = listedPackages(modules.ranked, devOnlyNames(pkg, lock));
  const packages = stampVersions(ranked, lock);
  return {
    hasManifest: Boolean(pkg),
    name: pkg && typeof pkg.name === 'string' ? pkg.name : '',
    deps: sectionCount(pkg, 'dependencies'),
    dev: sectionCount(pkg, 'devDependencies'),
    optional: sectionCount(pkg, 'optionalDependencies'),
    scripts,
    modules: { ...modules, packages },
  };
};

module.exports = {
  dirSize,
  readNpmSummary,
};
