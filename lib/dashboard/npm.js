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
  return list.slice(0, TOP_PACKAGES);
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
        const prev = totals.get(item.name) ?? 0;
        totals.set(item.name, prev + item.bytes);
      }
    }
  };
  await Promise.all(Array.from({ length: WORKERS }, worker));
  return { bytes: total, packages: rankedPackages(totals) };
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
  if (previous && stamp && previous.stamp === stamp) return previous;
  const dir = path.join(top, MODULES);
  const [count, measured] = await Promise.all([
    installedCount(top),
    measureModules(dir),
  ]);
  return {
    stamp,
    count,
    bytes: measured.bytes,
    packages: measured.packages,
  };
};

const readNpmSummary = async (top, previous = null) => {
  const pkg = await readJson(path.join(top, MANIFEST));
  const scripts = listCommands(top)
    .filter((entry) => entry.kind === 'script')
    .map((entry) => entry.name);
  const modules = await readModules(top, previous ? previous.modules : null);
  return {
    hasManifest: Boolean(pkg),
    name: pkg && typeof pkg.name === 'string' ? pkg.name : '',
    deps: sectionCount(pkg, 'dependencies'),
    dev: sectionCount(pkg, 'devDependencies'),
    optional: sectionCount(pkg, 'optionalDependencies'),
    scripts,
    modules,
  };
};

module.exports = {
  dirSize,
  readNpmSummary,
};
