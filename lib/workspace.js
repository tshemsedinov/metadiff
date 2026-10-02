'use strict';

const fs = require('node:fs');
const path = require('node:path');

const files = require('./files.js');
const { REVIEW_DIR } = files;
const review = require('./review.js');
const { listReviewNames, latestReviewName, loadReview, noteCounts } = review;
const worktree = require('./git-worktree.js');
const { runGitAsync, countUntrackedAdded } = worktree;
const model = require('./dashboard/model.js');
const { runName } = model;
const runs = require('./runs.js');
const { readRuns } = runs;

const emptyDiff = () => ({
  stagedAdded: 0,
  unstagedAdded: 0,
  stagedRemoved: 0,
  unstagedRemoved: 0,
});

const isRepoDir = (dir) => {
  try {
    fs.accessSync(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
};

const listChildRepos = (dir) => {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const repos = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (!isRepoDir(full)) continue;
    repos.push({ name: entry.name, dir: full });
  }
  repos.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  return repos;
};

const workspaceAt = (dir) => {
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch {
    return null;
  }
  if (!stat.isDirectory() || isRepoDir(dir)) return null;
  const repos = listChildRepos(dir);
  if (!repos.length) return null;
  return { root: path.resolve(dir), repos };
};

const workspaceFromArgs = (cwd, paths) => {
  if (paths.length > 1) return null;
  const dir = paths.length ? path.resolve(cwd, paths[0]) : cwd;
  if (paths.length) {
    try {
      if (!fs.statSync(dir).isDirectory()) return null;
    } catch {
      return null;
    }
  }
  return workspaceAt(dir);
};

const sumNumstat = (text) => {
  let added = 0;
  let removed = 0;
  for (const line of `${text ?? ''}`.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    const add = Number(parts[0]);
    const del = Number(parts[1]);
    if (Number.isFinite(add)) added += add;
    if (Number.isFinite(del)) removed += del;
  }
  return { added, removed };
};

const readNumstat = async (dir, cached) => {
  const args = cached
    ? ['diff', '--cached', '--numstat']
    : ['diff', '--numstat'];
  try {
    const result = await runGitAsync(args, dir);
    if (result.status !== 0) return { added: 0, removed: 0 };
    return sumNumstat(result.stdout);
  } catch {
    return { added: 0, removed: 0 };
  }
};

const readDiffStat = async (dir) => {
  const staged = await readNumstat(dir, true);
  const open = await readNumstat(dir, false);
  const untracked = await countUntrackedAdded(dir);
  return {
    stagedAdded: staged.added,
    unstagedAdded: open.added + untracked,
    stagedRemoved: staged.removed,
    unstagedRemoved: open.removed,
  };
};

const countCommits = async (dir) => {
  try {
    const result = await runGitAsync(['rev-list', '--count', 'HEAD'], dir);
    if (result.status !== 0) return 0;
    const value = parseInt(result.stdout.trim(), 10);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
};

const taskStats = (dir) => {
  const latest = latestReviewName(listReviewNames(dir));
  if (!latest) return { done: 0, total: 0 };
  try {
    const file = path.join(dir, REVIEW_DIR, latest);
    const counts = noteCounts(loadReview(file, []));
    return { done: counts.tasksDone, total: counts.tasks };
  } catch {
    return { done: 0, total: 0 };
  }
};

const pickRun = (dir) => {
  const list = readRuns(dir);
  const live = list.find((row) => row.status === 'running');
  const record = live ?? list[0] ?? null;
  if (!record) return null;
  const progress = record.progress ?? {};
  return {
    name: runName(record),
    status: record.status,
    done: progress.done ?? 0,
    failed: progress.failed ?? 0,
    expected: progress.expected ?? 0,
    result: record.result ?? null,
  };
};

module.exports = {
  emptyDiff,
  isRepoDir,
  listChildRepos,
  workspaceAt,
  workspaceFromArgs,
  sumNumstat,
  readDiffStat,
  countCommits,
  taskStats,
  pickRun,
};
