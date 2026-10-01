'use strict';

const fs = require('node:fs');
const path = require('node:path');

const git = require('../git-worktree.js');
const { runGitAsync } = git;
const watch = require('../session/watch.js');
const { UNKNOWN_PATH } = watch;

const ROOT_DIR = '.';
const NO_EXT = '(none)';
const MAX_LINES_BYTES = 2 * 1024 * 1024;
const BINARY_PROBE = 8000;
const CONCURRENCY = 32;
const HEAT_MS = 4000;
const RECENT_KEEP = 64;
const SKIP_WALK = new Set(['.git', 'node_modules']);
const SKIP_PREFIX = ['.git/', 'node_modules/'];

const slash = (rel) => `${rel}`.replaceAll('\\', '/');

const folderOf = (rel) => {
  const at = rel.indexOf('/');
  return at < 0 ? ROOT_DIR : rel.slice(0, at);
};

const extOf = (rel) => path.extname(rel).toLowerCase() || NO_EXT;

const countLines = (buffer) => {
  const probe = buffer.subarray(0, BINARY_PROBE);
  if (probe.includes(0)) return 0;
  const size = buffer.length;
  if (!size) return 0;
  let lines = 0;
  let at = buffer.indexOf(10);
  while (at >= 0) {
    lines += 1;
    at = buffer.indexOf(10, at + 1);
  }
  return buffer[size - 1] === 10 ? lines : lines + 1;
};

const mapLimit = async (list, limit, fn) => {
  const results = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const index = next;
      next += 1;
      results[index] = await fn(list[index]);
    }
  };
  const count = Math.min(limit, list.length);
  await Promise.all(Array.from({ length: count }, worker));
  return results;
};

const readLines = async (full, size) => {
  if (size > MAX_LINES_BYTES) return 0;
  try {
    return countLines(await fs.promises.readFile(full));
  } catch {
    return 0;
  }
};

const readEntry = async (root, rel, prev, at) => {
  const full = path.join(root, rel);
  let stat;
  try {
    stat = await fs.promises.stat(full);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (prev && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size) {
    return prev;
  }
  const lines = await readLines(full, stat.size);
  const { size, mtimeMs } = stat;
  const dir = folderOf(rel);
  const ext = extOf(rel);
  return { rel, size, lines, mtimeMs, dir, ext, changedAt: at };
};

const walkFiles = async (root, dir = '') => {
  const found = [];
  let entries;
  try {
    entries = await fs.promises.readdir(path.join(root, dir), {
      withFileTypes: true,
    });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (SKIP_WALK.has(entry.name)) continue;
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      const inner = await walkFiles(root, rel);
      found.push(...inner);
    } else if (entry.isFile()) {
      found.push(rel);
    }
  }
  return found;
};

const listProject = async (root) => {
  const args = ['ls-files', '-z', '--cached', '--others', '--exclude-standard'];
  try {
    const result = await runGitAsync(args, root);
    if (result.status === 0) {
      return result.stdout.split('\0').filter(Boolean).map(slash);
    }
  } catch {
    // not a git repository: walk the tree
  }
  return walkFiles(root);
};

const ignoredAmong = async (root, rels) => {
  if (!rels.length) return new Set();
  try {
    const args = ['check-ignore', '-z', '--', ...rels];
    const result = await runGitAsync(args, root);
    if (result.status !== 0 && result.status !== 1) return new Set();
    return new Set(result.stdout.split('\0').filter(Boolean).map(slash));
  } catch {
    return new Set();
  }
};

const groupKey = (map, key) => {
  let group = map.get(key);
  if (!group) {
    group = { key, files: 0, bytes: 0, lines: 0 };
    map.set(key, group);
  }
  return group;
};

const bySize = (left, right) =>
  right.bytes - left.bytes || left.key.localeCompare(right.key, 'en');

class FileIndex {
  constructor(root) {
    this.root = root;
    this.entries = new Map();
    this.recent = [];
    this.version = 0;
    this.cached = null;
    this.ready = false;
  }

  bump() {
    this.version += 1;
    this.cached = null;
  }

  note(entry) {
    if (!entry.changedAt) return;
    this.recent.push({ at: entry.changedAt, dir: entry.dir, ext: entry.ext });
    if (this.recent.length > RECENT_KEEP) this.recent.shift();
  }

  async rescan() {
    const rels = await listProject(this.root);
    const next = new Map();
    const at = this.ready ? Date.now() : 0;
    const read = (rel) => readEntry(this.root, rel, this.entries.get(rel), at);
    const entries = await mapLimit(rels, CONCURRENCY, read);
    let changed = !this.ready || entries.length !== this.entries.size;
    for (const entry of entries) {
      if (!entry) continue;
      const prev = this.entries.get(entry.rel);
      if (prev !== entry) {
        changed = true;
        this.note(entry);
      }
      next.set(entry.rel, entry);
    }
    if (next.size !== this.entries.size) changed = true;
    this.entries = next;
    this.ready = true;
    if (changed) this.bump();
    return changed;
  }

  dropPrefix(rel) {
    let dropped = false;
    const head = `${rel}/`;
    for (const key of [...this.entries.keys()]) {
      if (key !== rel && !key.startsWith(head)) continue;
      this.entries.delete(key);
      dropped = true;
    }
    return dropped;
  }

  async touchOne(rel) {
    const full = path.join(this.root, rel);
    let stat;
    try {
      stat = await fs.promises.stat(full);
    } catch {
      return { dropped: this.dropPrefix(rel), fresh: null, rescan: false };
    }
    if (stat.isDirectory()) {
      return { dropped: false, fresh: null, rescan: true };
    }
    if (!stat.isFile()) return { dropped: false, fresh: null, rescan: false };
    return { dropped: false, fresh: rel, rescan: false };
  }

  async applyFresh(rels) {
    const known = rels.filter((rel) => this.entries.has(rel));
    const unknown = rels.filter((rel) => !this.entries.has(rel));
    const ignored = await ignoredAmong(this.root, unknown);
    const wanted = [...known, ...unknown.filter((rel) => !ignored.has(rel))];
    const at = Date.now();
    const read = (rel) => readEntry(this.root, rel, this.entries.get(rel), at);
    const entries = await mapLimit(wanted, CONCURRENCY, read);
    let changed = false;
    for (let i = 0; i < wanted.length; i++) {
      const entry = entries[i];
      if (!entry) {
        changed = this.entries.delete(wanted[i]) || changed;
        continue;
      }
      if (this.entries.get(entry.rel) === entry) continue;
      this.entries.set(entry.rel, entry);
      this.note(entry);
      changed = true;
    }
    return changed;
  }

  async touch(paths) {
    const rels = [];
    for (const item of paths) {
      const rel = slash(item);
      if (rel === UNKNOWN_PATH) return this.rescan();
      if (SKIP_PREFIX.some((prefix) => rel.startsWith(prefix))) continue;
      rels.push(rel);
    }
    if (!this.ready) return this.rescan();
    const probe = (rel) => this.touchOne(rel);
    const probes = await mapLimit(rels, CONCURRENCY, probe);
    if (probes.some((probe) => probe.rescan)) return this.rescan();
    let changed = probes.some((probe) => probe.dropped);
    const fresh = probes.map((probe) => probe.fresh).filter(Boolean);
    if (fresh.length) {
      const applied = await this.applyFresh(fresh);
      changed = applied || changed;
    }
    if (changed) this.bump();
    return changed;
  }

  summary() {
    if (this.cached) return this.cached;
    const total = { files: 0, bytes: 0, lines: 0 };
    const dirs = new Map();
    const exts = new Map();
    for (const entry of this.entries.values()) {
      total.files += 1;
      total.bytes += entry.size;
      total.lines += entry.lines;
      const groups = [groupKey(dirs, entry.dir), groupKey(exts, entry.ext)];
      for (const group of groups) {
        group.files += 1;
        group.bytes += entry.size;
        group.lines += entry.lines;
      }
    }
    this.cached = {
      total,
      dirs: [...dirs.values()].sort(bySize),
      exts: [...exts.values()].sort(bySize),
    };
    return this.cached;
  }

  hot(now = Date.now()) {
    const dirs = new Set();
    const exts = new Set();
    for (const item of this.recent) {
      if (now - item.at > HEAT_MS) continue;
      dirs.add(item.dir);
      exts.add(item.ext);
    }
    return { dirs, exts };
  }

  hotUntil() {
    const last = this.recent.at(-1);
    return last ? last.at + HEAT_MS : 0;
  }

  sizeOf(rel) {
    const entry = this.entries.get(rel);
    return entry ? entry.size : 0;
  }
}

module.exports = {
  ROOT_DIR,
  NO_EXT,
  HEAT_MS,
  folderOf,
  extOf,
  countLines,
  FileIndex,
};
