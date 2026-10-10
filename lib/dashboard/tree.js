'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { runGitAsync } = require('../git/worktree.js');
const { UNKNOWN_PATH } = require('./watch.js');

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

const statOf = (full) => fs.promises.stat(full).catch(() => null);

const countLines = (buffer) => {
  const size = buffer.length;
  if (!size || buffer.subarray(0, BINARY_PROBE).includes(0)) return 0;
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
  const stat = await statOf(full);
  if (!stat || !stat.isFile()) return null;
  const { size, mtimeMs } = stat;
  if (prev && prev.mtimeMs === mtimeMs && prev.size === size) return prev;
  const lines = await readLines(full, size);
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
    if (entry.isFile()) found.push(rel);
    if (!entry.isDirectory()) continue;
    const inner = await walkFiles(root, rel);
    found.push(...inner);
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

const groupOf = (map, key) => {
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
    this.cached = null;
    this.ready = false;
  }

  note(entry) {
    if (!entry.changedAt) return;
    this.recent.push({ at: entry.changedAt, dir: entry.dir, ext: entry.ext });
    if (this.recent.length > RECENT_KEEP) this.recent.shift();
  }

  readAll(rels, at) {
    const read = (rel) => readEntry(this.root, rel, this.entries.get(rel), at);
    return mapLimit(rels, CONCURRENCY, read);
  }

  async rescan() {
    const rels = await listProject(this.root);
    const entries = await this.readAll(rels, this.ready ? Date.now() : 0);
    const next = new Map();
    let changed = !this.ready;
    for (const entry of entries) {
      if (!entry) continue;
      if (this.entries.get(entry.rel) !== entry) {
        changed = true;
        this.note(entry);
      }
      next.set(entry.rel, entry);
    }
    if (next.size !== this.entries.size) changed = true;
    this.entries = next;
    this.ready = true;
    if (changed) this.cached = null;
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

  async applyFresh(rels) {
    const unknown = rels.filter((rel) => !this.entries.has(rel));
    const ignored = await ignoredAmong(this.root, unknown);
    const wanted = rels.filter((rel) => !ignored.has(rel));
    const entries = await this.readAll(wanted, Date.now());
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
    const probe = (rel) => statOf(path.join(this.root, rel));
    const stats = await mapLimit(rels, CONCURRENCY, probe);
    if (stats.some((stat) => stat && stat.isDirectory())) return this.rescan();
    let changed = false;
    const fresh = [];
    for (let i = 0; i < rels.length; i++) {
      const stat = stats[i];
      if (!stat) changed = this.dropPrefix(rels[i]) || changed;
      else if (stat.isFile()) fresh.push(rels[i]);
    }
    if (fresh.length) {
      const applied = await this.applyFresh(fresh);
      changed = applied || changed;
    }
    if (changed) this.cached = null;
    return changed;
  }

  summary() {
    if (this.cached) return this.cached;
    const total = { files: 0, bytes: 0, lines: 0 };
    const dirs = new Map();
    const exts = new Map();
    for (const entry of this.entries.values()) {
      const groups = [
        total,
        groupOf(dirs, entry.dir),
        groupOf(exts, entry.ext),
      ];
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

  hot(now) {
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
}

module.exports = { ROOT_DIR, NO_EXT, HEAT_MS, folderOf, extOf, FileIndex };
