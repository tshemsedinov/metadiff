'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { MANIFEST } = require('../deps.js');
const { MODULES_STAMP } = require('../session/watch.js');

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

const DIRECT_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];
const CHILD_SECTIONS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
];
const CHAIN_MARK = ' 🢒 ';

const directNames = (pkg) => {
  const names = new Set();
  for (const section of DIRECT_SECTIONS) {
    for (const name of declaredNames(pkg, section)) names.add(name);
  }
  return names;
};

const devNames = (pkg) => {
  const keep = new Set([
    ...declaredNames(pkg, 'dependencies'),
    ...declaredNames(pkg, 'optionalDependencies'),
  ]);
  const names = new Set();
  for (const name of declaredNames(pkg, 'devDependencies')) {
    if (!keep.has(name)) names.add(name);
  }
  return names;
};

const entryName = (key) => {
  const at = key.lastIndexOf(MODULE_PREFIX);
  if (at < 0) return '';
  const rest = key.slice(at + MODULE_PREFIX.length);
  if (rest.startsWith('@')) {
    const parts = rest.split('/');
    if (!parts[1]) return '';
    return `${parts[0]}/${parts[1]}`;
  }
  return rest.split('/')[0] || '';
};

const childNames = (entry) => {
  const names = [];
  if (!entry || typeof entry !== 'object') return names;
  for (const section of CHILD_SECTIONS) {
    const map = entry[section];
    if (!map || typeof map !== 'object') continue;
    for (const name of Object.keys(map)) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
};

const dependencyChildren = (lock) => {
  const children = new Map();
  const packages = lockPackages(lock);
  if (!packages) return children;
  for (const key of Object.keys(packages)) {
    if (!key) continue;
    const name = entryName(key);
    if (!name) continue;
    const list = children.get(name) ?? [];
    for (const child of childNames(packages[key])) {
      if (!list.includes(child)) list.push(child);
    }
    if (list.length) children.set(name, list);
  }
  return children;
};

const parentChain = (name, declared, children) => {
  if (declared.has(name)) return '';
  const prev = new Map();
  const queue = [];
  const roots = [...declared].sort();
  for (const root of roots) {
    if (prev.has(root)) continue;
    prev.set(root, '');
    queue.push(root);
  }
  let head = 0;
  while (head < queue.length) {
    const at = queue[head];
    head += 1;
    const kids = children.get(at);
    if (!kids) continue;
    for (const kid of kids) {
      if (prev.has(kid)) continue;
      prev.set(kid, at);
      if (kid !== name) {
        queue.push(kid);
        continue;
      }
      const path = [];
      let cursor = at;
      while (cursor) {
        path.push(cursor);
        cursor = prev.get(cursor) || '';
      }
      return path.join(CHAIN_MARK);
    }
  }
  return '';
};

const lockVersion = (lock, name) => {
  const packages = lockPackages(lock);
  const entry = packages && packages[`${MODULE_PREFIX}${name}`];
  if (!entry || typeof entry.version !== 'string') return '';
  return entry.version;
};

const topPackages = (ranked, pkg, lock) => {
  const declared = directNames(pkg);
  const devs = devNames(pkg);
  const children = dependencyChildren(lock);
  const rows = ranked.map((item) => {
    const direct = declared.has(item.name);
    return {
      name: item.name,
      bytes: item.bytes,
      dev: direct && devs.has(item.name),
      transitive: !direct,
      chain: parentChain(item.name, declared, children),
      version: lockVersion(lock, item.name),
    };
  });
  const runtime = rows.filter((row) => !row.dev && !row.transitive);
  const development = rows.filter((row) => row.dev);
  const nested = rows.filter((row) => row.transitive);
  return [...runtime, ...development, ...nested];
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

module.exports = { TOP_PACKAGES, readNpmSummary };
