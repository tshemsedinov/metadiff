'use strict';

const fs = require('node:fs');
const path = require('node:path');

const runs = require('../runs.js');
const { isRunsRel } = runs;

const DEBOUNCE_MS = 200;
const UNKNOWN_PATH = '.';
const MODULES_STAMP = 'node_modules/.package-lock.json';

const SKIP_DIRS = ['node_modules', '.review', 'coverage', 'dist', '.cache'];

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

const linuxRecursiveNode = (version) => {
  const parts = `${version}`.split('.');
  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  if (major > 19) return true;
  return major === 19 && minor >= 1;
};

const canWatchRecursive = (
  platform = process.platform,
  version = process.versions.node,
) => {
  if (platform === 'win32' || platform === 'darwin') return true;
  if (platform === 'linux') return linuxRecursiveNode(version);
  return false;
};

const ignoredName = (name) => {
  if (!name) return false;
  if (name.endsWith('.lock')) return true;
  if (name.endsWith('~')) return true;
  if (name.endsWith('.swp') || name.endsWith('.swo')) return true;
  if (name.startsWith('.#')) return true;
  if (name === '.DS_Store') return true;
  return false;
};

const ignoredGitRel = (parts) => {
  if (parts[1] === 'logs' && parts[2] === 'HEAD') return false;
  const name = parts[1] ?? '';
  if (!name) return false;
  if (GIT_WATCH_NAMES.includes(name)) return false;
  return true;
};

const slashRel = (rel) => `${rel}`.replaceAll('\\', '/');

const ignoredRel = (rel) => {
  const norm = slashRel(rel);
  if (!norm || norm === '.') return false;
  if (norm === MODULES_STAMP) return false;
  const parts = norm.split('/');
  for (const part of parts) {
    if (SKIP_DIRS.includes(part)) return true;
  }
  if (parts[0] === '.git') return ignoredGitRel(parts);
  return ignoredName(parts[parts.length - 1]);
};

const skipDirName = (name) => name === '.git' || SKIP_DIRS.includes(name);

const closeWatcher = (watcher) => {
  try {
    watcher.close();
  } catch {
    // already closed
  }
};

const reviewMarkdown = (rel) => {
  const norm = `${rel}`.replaceAll('\\', '/');
  if (!norm.startsWith('.review/')) return false;
  const rest = norm.slice('.review/'.length);
  if (!rest || rest.includes('/')) return false;
  return rest.endsWith('.md');
};

const isReviewDir = (root, dir) => {
  const rel = path.relative(root, dir).replaceAll('\\', '/');
  return rel === '.review' || rel.startsWith('.review/');
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
  return hasFile(path.join(root, '.review', base));
};

const isReviewEvent = (root, dir, name) => {
  if (isReviewDir(root, dir)) return true;
  if (!name) return false;
  const rel = path.relative(root, path.join(dir, name));
  const norm = rel.replaceAll('\\', '/');
  if (reviewMarkdown(norm)) return true;
  return isBareReviewName(root, dir, norm);
};

const isOwnDirEvent = (dir, name) => {
  if (!name) return false;
  const base = path.basename(dir);
  const slash = `${name}`.replaceAll('\\', '/');
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

const schedule = (state, timerKey, fire) => {
  if (state.closed || !fire) return;
  if (state[timerKey] !== null) clearTimeout(state[timerKey]);
  state[timerKey] = setTimeout(() => {
    state[timerKey] = null;
    if (state.closed) return;
    fire();
  }, state.debounceMs);
  const timer = state[timerKey];
  if (timer && typeof timer.unref === 'function') timer.unref();
};

const REVIEW_HOLD_MS = 200;

const reviewBurst = (state) => {
  const seen = state.reviewSeenAt;
  if (!seen) return false;
  const hold = Math.max(state.debounceMs * 2, REVIEW_HOLD_MS);
  return Date.now() - seen < hold;
};

const flushPaths = (state) => {
  if (!state.pending.size) return;
  const list = [...state.pending];
  state.pending.clear();
  if (state.onPaths) state.onPaths(list);
};

const scheduleChange = (state, loose = false) => {
  state.looseChange = loose && (state.timer === null || state.looseChange);
  schedule(state, 'timer', () => {
    if (state.looseChange && reviewBurst(state)) return;
    flushPaths(state);
    if (state.onChange) state.onChange();
  });
};

const scheduleUnnamed = (state) => {
  if (reviewBurst(state)) return;
  state.pending.add(UNKNOWN_PATH);
  schedule(state, 'looseTimer', () => {
    if (!reviewBurst(state)) scheduleChange(state, true);
  });
};

const clearTimer = (state, timerKey) => {
  if (state[timerKey] !== null) clearTimeout(state[timerKey]);
  state[timerKey] = null;
};

const dropLooseChange = (state) => {
  clearTimer(state, 'looseTimer');
  if (state.looseChange) clearTimer(state, 'timer');
};

const handleWatchEvent = (state, dir, eventType, filename) => {
  if (state.closed) return;
  const name = filename ? `${filename}` : '';
  const rel = name
    ? slashRel(path.relative(state.root, path.join(dir, name)))
    : '';
  const wanted = state.files.has(rel);
  if (isRunsRel(rel)) {
    state.pending.add(rel);
    return void schedule(state, 'pathsTimer', () => flushPaths(state));
  }
  if (isReviewEvent(state.root, dir, name)) {
    state.reviewSeenAt = Date.now();
    dropLooseChange(state);
    schedule(state, 'reviewTimer', state.onReview);
    if (!wanted) return;
  }
  if (!name) return void scheduleUnnamed(state);
  if (!wanted && ignoredRel(rel)) return;
  if (isOwnDirEvent(dir, name)) return;
  const full = path.join(dir, name);
  if (unchangedSince(full, state.startedAt)) return;
  if (eventType === 'rename') state.watchNewDir(full);
  state.pending.add(rel);
  scheduleChange(state);
};

const watchOne = (state, target, extra = {}) => {
  if (state.closed) return;
  if (state.watched.has(target)) return;
  try {
    const onEvent = (eventType, filename) => {
      handleWatchEvent(state, target, eventType, filename);
    };
    const watcher = fs.watch(
      target,
      { persistent: false, encoding: 'utf8', ...extra },
      onEvent,
    );
    if (typeof watcher.on === 'function') {
      watcher.on('error', () => {});
    }
    state.watched.add(target);
    state.watchers.push(watcher);
  } catch {
    // missing path or too many watchers
  }
};

const watchTree = (state, dir) => {
  watchOne(state, dir, state.dirWatchOpts);
  if (state.recursive) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (skipDirName(entry.name)) continue;
    watchTree(state, path.join(dir, entry.name));
  }
};

const maybeWatchNewDir = (state, full) => {
  if (state.recursive) return;
  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    return;
  }
  if (!stat.isDirectory()) return;
  if (path.basename(full) === '.review') return void watchOne(state, full);
  if (skipDirName(path.basename(full))) return;
  watchTree(state, full);
};

const watchScope = (state, spec) => {
  const target = path.resolve(state.root, spec);
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return void watchOne(state, path.dirname(target));
  }
  if (stat.isDirectory()) return void watchTree(state, target);
  watchOne(state, path.dirname(target));
};

const watchGit = (state) => {
  const gitDir = path.resolve(state.root, '.git');
  watchOne(state, gitDir);
  watchOne(state, path.resolve(gitDir, 'refs'));
  watchOne(state, path.resolve(gitDir, 'logs'));
};

const watchRuns = (state) => {
  const dir = path.resolve(state.root, runs.runsDir('.'));
  watchOne(state, dir);
};

const stopState = (state) => {
  state.closed = true;
  clearTimer(state, 'timer');
  clearTimer(state, 'reviewTimer');
  clearTimer(state, 'looseTimer');
  clearTimer(state, 'pathsTimer');
  state.pending.clear();
  while (state.watchers.length) closeWatcher(state.watchers.pop());
  state.watched.clear();
};

const watchFiles = (state, rels) => {
  state.files = new Set();
  for (const rel of rels) {
    if (!rel) continue;
    const full = path.resolve(state.root, rel);
    state.files.add(slashRel(path.relative(state.root, full)));
    watchOne(state, path.dirname(full));
  }
};

const createDiskWatcher = (options) => {
  const recursive = options.recursive ?? canWatchRecursive();
  const state = {
    root: path.resolve(options.root),
    debounceMs: options.debounceMs ?? DEBOUNCE_MS,
    onChange: options.onChange,
    recursive,
    dirWatchOpts: recursive ? { recursive: true } : {},
    watchers: [],
    watched: new Set(),
    files: new Set(),
    onReview: options.onReview,
    onPaths: options.onPaths,
    pending: new Set(),
    timer: null,
    reviewTimer: null,
    looseTimer: null,
    pathsTimer: null,
    looseChange: false,
    reviewSeenAt: 0,
    startedAt: Date.now(),
    closed: false,
    watchNewDir: (full) => maybeWatchNewDir(state, full),
  };
  const scopes = options.paths && options.paths.length ? options.paths : ['.'];
  for (const spec of scopes) watchScope(state, spec);
  watchGit(state);
  watchRuns(state);
  watchOne(state, path.resolve(state.root, '.review'));
  return {
    close: () => stopState(state),
    watchFiles: (rels) => watchFiles(state, rels),
  };
};

module.exports = {
  DEBOUNCE_MS,
  UNKNOWN_PATH,
  MODULES_STAMP,
  canWatchRecursive,
  ignoredRel,
  isOwnDirEvent,
  unchangedSince,
  createDiskWatcher,
};
