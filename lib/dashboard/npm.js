'use strict';

const fs = require('node:fs');
const path = require('node:path');

const deps = require('../deps.js');
const { MANIFEST } = deps;
const watch = require('../session/watch.js');
const { MODULES_STAMP } = watch;

const MODULES = 'node_modules';
const MODULE_PREFIX = `${MODULES}/`;
const WORKERS = 8;
const TOP_PACKAGES = 8;

const readJson = async (file) => {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch {
    return null;
  }
};

const declaredNames = (pkg, section) => {
  const map = pkg && pkg[section];
  if (!map || typeof map !== 'object') return [];
  return Object.keys(map);
};

const lockPackages = (lock) => {
  const packages = lock && lock.packages;
  return packages && typeof packages === 'object' ? packages : null;
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
  const parts = path.relative(root, file).split(path.sep);
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
  return list.sort(
    (left, right) =>
      right.bytes - left.bytes || left.name.localeCompare(right.name, 'en'),
  );
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
  const packages = lockPackages(lock);
  if (!packages) return names;
  for (const key of Object.keys(packages)) {
    const entry = packages[key];
    if (!entry || !entry.dev || !key.startsWith(MODULE_PREFIX)) continue;
    const name = key.slice(MODULE_PREFIX.length);
    if (!name || name.includes('/node_modules/') || keep.has(name)) continue;
    names.add(name);
  }
  return names;
};

const lockVersion = (lock, name) => {
  const packages = lockPackages(lock);
  const entry = packages && packages[`${MODULE_PREFIX}${name}`];
  if (!entry || typeof entry.version !== 'string') return '';
  return entry.version;
};

const topPackages = (ranked, pkg, lock) => {
  const devNames = devOnlyNames(pkg, lock);
  const rows = ranked.map((item) => ({
    name: item.name,
    bytes: item.bytes,
    dev: devNames.has(item.name),
    version: lockVersion(lock, item.name),
  }));
  const runtime = rows.filter((row) => !row.dev);
  const devs = rows.filter((row) => row.dev);
  return [...runtime, ...devs].slice(0, TOP_PACKAGES);
};

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
        totals.set(item.name, (totals.get(item.name) ?? 0) + item.bytes);
      }
    }
  };
  await Promise.all(Array.from({ length: WORKERS }, worker));
  return { bytes: total, ranked: rankedPackages(totals) };
};

const installedCount = async (top, lock) => {
  const packages = lockPackages(lock);
  if (packages) {
    let count = 0;
    for (const key of Object.keys(packages)) {
      if (key && !packages[key].link) count += 1;
    }
    return count;
  }
  let entries;
  try {
    entries = await fs.promises.readdir(path.join(top, MODULES));
  } catch {
    return 0;
  }
  let count = 0;
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

const readModules = async (top, lock, previous) => {
  const stamp = await modulesStamp(top);
  if (previous && stamp && previous.stamp === stamp) return previous;
  const [count, measured] = await Promise.all([
    installedCount(top, lock),
    measureModules(path.join(top, MODULES)),
  ]);
  return { stamp, count, bytes: measured.bytes, ranked: measured.ranked };
};

const readNpmSummary = async (top, previous) => {
  const pkg = await readJson(path.join(top, MANIFEST));
  const lock = await readJson(path.join(top, MODULES_STAMP));
  const cached = previous ? previous.modules : null;
  const modules = await readModules(top, lock, cached);
  return {
    hasManifest: Boolean(pkg),
    deps: declaredNames(pkg, 'dependencies').length,
    dev: declaredNames(pkg, 'devDependencies').length,
    modules: { ...modules, packages: topPackages(modules.ranked, pkg, lock) },
  };
};

module.exports = { readNpmSummary };
