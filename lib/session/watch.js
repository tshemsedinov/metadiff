'use strict';

const fs = require('node:fs');
const path = require('node:path');

const runs = require('../runs.js');
const { isRunsRel } = runs;
const { REVIEW_DIR } = require('../files.js');

const DEBOUNCE_MS = 200;
const UNKNOWN_PATH = '.';
const MODULES_STAMP = 'node_modules/.package-lock.json';

const SKIP_DIRS = ['node_modules', REVIEW_DIR, 'coverage', 'dist', '.cache'];

const GIT_WATCH_NAMES = [
  'HEAD',
  'index',
  'packed-refs',
  'FETCH_HEAD',
  'ORIG_HEAD',
  'refs',
  'rebase-merge',
  'rebase-apply',
];

const canWatchRecursive = (
  platform = process.platform,
  version = process.versions.node,
) => {
  if (platform === 'win32' || platform === 'darwin') return true;
  if (platform !== 'linux') return false;
  const [major, minor] = `${version}`.split('.').map(Number);
  return major > 19 || (major === 19 && minor >= 1);
};

const IGNORED_SUFFIXES = ['.lock', '~', '.swp', '.swo'];

const ignoredName = (name) =>
  IGNORED_SUFFIXES.some((suffix) => name.endsWith(suffix)) ||
  name.startsWith('.#') ||
  name === '.DS_Store';

const ignoredGitRel = ([, name = '', sub]) => {
  if (name === 'logs' && sub === 'HEAD') return false;
  return name !== '' && !GIT_WATCH_NAMES.includes(name);
};

const slashRel = (rel) => `${rel}`.replaceAll('\\', '/');

const ignoredRel = (rel) => {
  const norm = slashRel(rel);
  if (!norm || norm === '.') return false;
  if (norm === MODULES_STAMP) return false;
  const parts = norm.split('/');
  if (parts.some((part) => SKIP_DIRS.includes(part))) return true;
  if (parts[0] === '.git') return ignoredGitRel(parts);
  return ignoredName(parts[parts.length - 1]);
};

const skipDirName = (name) => name === '.git' || SKIP_DIRS.includes(name);

const reviewMarkdown = (rel) => {
  const prefix = `${REVIEW_DIR}/`;
  if (!rel.startsWith(prefix)) return false;
  const rest = rel.slice(prefix.length);
  if (!rest || rest.includes('/')) return false;
  return rest.endsWith('.md');
};

const isReviewDir = (root, dir) => {
  const rel = slashRel(path.relative(root, dir));
  return rel === REVIEW_DIR || rel.startsWith(`${REVIEW_DIR}/`);
};

const hasFile = (full) => {
  try {
    fs.accessSync(full);
    return true;
  } catch {
    return false;
  }
};

const isBareReviewName = (root, dir, rel) => {
  if (!rel || rel.includes('/')) return false;
  const base = path.basename(rel);
  if (hasFile(path.join(dir, base))) return false;
  return hasFile(path.join(root, REVIEW_DIR, base));
};

const isReviewEvent = (root, dir, name) => {
  if (isReviewDir(root, dir)) return true;
  if (!name) return false;
  const rel = slashRel(path.relative(root, path.join(dir, name)));
  if (reviewMarkdown(rel)) return true;
  return isBareReviewName(root, dir, rel);
};

const isOwnDirEvent = (dir, name) => {
  if (!name) return false;
  const base = path.basename(dir);
  const slash = slashRel(name);
  const bare = slash.startsWith('./') ? slash.slice(2) : slash;
  const trimmed = bare.endsWith('/') ? bare.slice(0, -1) : bare;
  if (trimmed === base) {
    try {
      return !fs.statSync(path.join(dir, trimmed)).isFile();
    } catch {
      return true;
    }
  }
  const full = path.resolve(dir, name);
  if (full === path.resolve(dir)) return true;
  if (path.basename(full) !== base) return false;
  try {
    return fs.realpathSync(full) === fs.realpathSync(dir);
  } catch {
    return false;
  }
};

const unchangedSince = (full, since) => {
  try {
    const stat = fs.statSync(full);
    return Math.max(stat.mtimeMs, stat.ctimeMs) < since;
  } catch {
    return false;
  }
};

const REVIEW_HOLD_MS = 200;

class DiskWatcher {
  constructor(options) {
    this.root = path.resolve(options.root);
    this.debounceMs = options.debounceMs ?? DEBOUNCE_MS;
    this.onChange = options.onChange;
    this.onReview = options.onReview;
    this.onPaths = options.onPaths;
    this.matchReview = options.matchReview ?? null;
    this.recursive = options.recursive ?? canWatchRecursive();
    this.watchers = [];
    this.watched = new Set();
    this.files = new Set();
    this.pending = new Set();
    this.timers = { change: null, review: null, loose: null, paths: null };
    this.looseChange = false;
    this.reviewSeenAt = 0;
    this.startedAt = Date.now();
    this.closed = false;
    const scopes = options.paths?.length ? options.paths : ['.'];
    for (const spec of scopes) this.watchScope(spec);
    const gitDir = path.resolve(this.root, '.git');
    this.watchOne(gitDir);
    this.watchOne(path.join(gitDir, 'refs'));
    this.watchOne(path.join(gitDir, 'logs'));
    this.watchOne(path.resolve(this.root, runs.logDir('.')));
    this.watchOne(path.resolve(this.root, runs.runsDir('.')));
    this.watchOne(path.resolve(this.root, REVIEW_DIR));
  }

  schedule(key, fire) {
    if (this.closed || !fire) return;
    this.clearTimer(key);
    this.timers[key] = setTimeout(() => {
      this.timers[key] = null;
      if (!this.closed) fire();
    }, this.debounceMs);
    this.timers[key].unref();
  }

  clearTimer(key) {
    if (this.timers[key] !== null) clearTimeout(this.timers[key]);
    this.timers[key] = null;
  }

  reviewBurst() {
    if (!this.reviewSeenAt) return false;
    const hold = Math.max(this.debounceMs * 2, REVIEW_HOLD_MS);
    return Date.now() - this.reviewSeenAt < hold;
  }

  flushPaths() {
    if (!this.pending.size) return;
    const list = [...this.pending];
    this.pending.clear();
    if (this.onPaths) this.onPaths(list);
  }

  scheduleChange(loose = false) {
    const idle = this.timers.change === null;
    this.looseChange = loose && (idle || this.looseChange);
    this.schedule('change', () => {
      if (this.looseChange && this.reviewBurst()) return;
      this.flushPaths();
      if (this.onChange) this.onChange();
    });
  }

  scheduleUnnamed() {
    if (this.reviewBurst()) return;
    this.pending.add(UNKNOWN_PATH);
    this.schedule('loose', () => {
      if (!this.reviewBurst()) this.scheduleChange(true);
    });
  }

  dropLooseChange() {
    this.clearTimer('loose');
    if (this.looseChange) this.clearTimer('change');
  }

  onEvent(dir, eventType, filename) {
    if (this.closed) return;
    const name = filename ? `${filename}` : '';
    const rel = name
      ? slashRel(path.relative(this.root, path.join(dir, name)))
      : '';
    const wanted = this.files.has(rel);
    if (isRunsRel(rel)) {
      this.pending.add(rel);
      if (name && eventType === 'rename') {
        this.watchNewDir(path.join(dir, name));
      }
      return void this.schedule('paths', () => this.flushPaths());
    }
    if (isReviewEvent(this.root, dir, name)) {
      this.reviewSeenAt = Date.now();
      this.dropLooseChange();
      this.schedule('review', this.onReview);
      if (!wanted) return;
    }
    if (rel && this.matchReview && this.matchReview(rel)) {
      this.pending.add(rel);
      return void this.schedule('paths', () => this.flushPaths());
    }
    if (!name) return void this.scheduleUnnamed();
    if (!wanted && ignoredRel(rel)) return;
    if (isOwnDirEvent(dir, name)) return;
    const full = path.join(dir, name);
    if (unchangedSince(full, this.startedAt)) return;
    if (eventType === 'rename') this.watchNewDir(full);
    this.pending.add(rel);
    this.scheduleChange();
  }

  watchOne(target, recursive = false) {
    if (this.closed || this.watched.has(target)) return;
    try {
      const options = { persistent: false, encoding: 'utf8', recursive };
      const watcher = fs.watch(target, options, (eventType, filename) => {
        this.onEvent(target, eventType, filename);
      });
      watcher.on('error', () => {});
      this.watched.add(target);
      this.watchers.push(watcher);
    } catch {
      // missing path or too many watchers
    }
  }

  watchTree(dir) {
    this.watchOne(dir, this.recursive);
    if (this.recursive) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || skipDirName(entry.name)) continue;
      this.watchTree(path.join(dir, entry.name));
    }
  }

  watchNewDir(full) {
    if (this.recursive) return;
    try {
      if (!fs.statSync(full).isDirectory()) return;
    } catch {
      return;
    }
    const name = path.basename(full);
    if (name === REVIEW_DIR) this.watchOne(full);
    else if (!skipDirName(name)) this.watchTree(full);
  }

  watchScope(spec) {
    const target = path.resolve(this.root, spec);
    try {
      if (fs.statSync(target).isDirectory()) return void this.watchTree(target);
    } catch {
      // watch the parent until the path appears
    }
    this.watchOne(path.dirname(target));
  }

  watchFiles(rels) {
    this.files = new Set();
    for (const rel of rels) {
      if (!rel) continue;
      const full = path.resolve(this.root, rel);
      this.files.add(slashRel(path.relative(this.root, full)));
      this.watchOne(path.dirname(full));
    }
  }

  close() {
    this.closed = true;
    for (const key of Object.keys(this.timers)) this.clearTimer(key);
    this.pending.clear();
    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
        // already closed
      }
    }
    this.watchers = [];
    this.watched.clear();
  }
}

module.exports = {
  DEBOUNCE_MS,
  UNKNOWN_PATH,
  MODULES_STAMP,
  canWatchRecursive,
  ignoredRel,
  isOwnDirEvent,
  unchangedSince,
  DiskWatcher,
};
