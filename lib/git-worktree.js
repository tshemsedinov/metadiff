'use strict';

const fs = require('node:fs');
const path = require('node:path');

const proc = require('./utilities.js');
const { runProc, runProcSync, isAbort } = proc;
const diff = require('./diff/diff.js');
const { parseDiff, synthesizeNewFile, itemsFromFiles } = diff;
const files = require('./files.js');
const { itemPath, REVIEW_DIR } = files;
const edit = require('./diff/edit.js');
const { replaceBlockAdds } = edit;

const oneLine = (text, fallback = 'git failed') => proc.oneLine(text, fallback);

const GIT_CONFIG = [
  '-c',
  'core.quotepath=false',
  '-c',
  'i18n.logOutputEncoding=utf-8',
];
const DIFF_OPTS = ['--no-color', '--no-ext-diff', '--no-renames', '-U3'];
const GIT_ENCODING = proc.DEFAULT_ENCODING;
const GIT_MAX_BUFFER = proc.DEFAULT_MAX_BUFFER;

const gitProcOptions = (cwd, extra = {}) => ({
  cwd,
  env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...extra.env },
  encoding: GIT_ENCODING,
  maxBuffer: GIT_MAX_BUFFER,
  input: extra.input,
  signal: extra.signal,
});

const gitResult = (result) => {
  if (!result.error) return result;
  if (isAbort(result.error)) throw result.error;
  if (result.error.code === 'ENOENT') throw new Error('git not found');
  throw result.error;
};

const requireOk = (result, fallback = 'git failed') => {
  if (result.status === 0) return result;
  const msg = result.stderr || result.stdout || fallback;
  throw new Error(oneLine(msg, fallback));
};

const runGit = (args, cwd, input, extra = {}) => {
  const options = gitProcOptions(cwd, { input, env: extra.env });
  return gitResult(runProcSync('git', args, options));
};

const runGitAsync = (args, cwd, extra = {}) => {
  const options = gitProcOptions(cwd, extra);
  return runProc('git', args, options).then(gitResult);
};

const pathArgsOf = (paths) => (paths.length ? ['--', ...paths] : []);

const cachedDiffArgs = (pathArgs) => [
  ...GIT_CONFIG,
  'diff',
  '--cached',
  ...DIFF_OPTS,
  ...pathArgs,
];

const worktreeDiffArgs = (pathArgs) => [
  ...GIT_CONFIG,
  'diff',
  ...DIFF_OPTS,
  ...pathArgs,
];

const commitDiffArgs = (commit, parent, pathArgs) => {
  if (parent.status === 0) {
    const from = parent.stdout.trim();
    return [...GIT_CONFIG, 'diff', ...DIFF_OPTS, from, commit, ...pathArgs];
  }
  return [
    ...GIT_CONFIG,
    'diff-tree',
    '--no-commit-id',
    '--root',
    '-p',
    ...DIFF_OPTS,
    commit,
    ...pathArgs,
  ];
};

const BINARY_SIZE = 1000000;

const isReviewFile = (rel) => {
  if (!rel) return false;
  const first = rel.split(/[/\\]/)[0];
  return first === REVIEW_DIR;
};

const dropReviewItems = (items) =>
  items.filter((item) => !isReviewFile(itemPath(item)));

const isBinaryBuffer = (buf) => {
  if (buf.length > BINARY_SIZE) return true;
  return buf.includes(0);
};

const namesFromLs = (stdout) => {
  if (!stdout) return [];
  return stdout.split('\0').filter(Boolean);
};

const untrackedLsArgs = (paths) => {
  const args = ['ls-files', '-o', '--exclude-standard', '-z'];
  if (paths.length) args.push('--', ...paths);
  return args;
};

const listUntracked = (top, paths) => {
  const result = requireOk(runGit(untrackedLsArgs(paths), top));
  return namesFromLs(result.stdout);
};

const filterListed = (names) =>
  names.filter((rel) => rel && !isReviewFile(rel));

const listTreeArgs = (rev, paths) => {
  const args = ['ls-tree', '-r', '--name-only', '-z', rev];
  if (paths.length) args.push('--', ...paths);
  return args;
};

const listWorktreeArgs = (paths) => {
  const args = ['ls-files', '-co', '--exclude-standard', '-z'];
  if (paths.length) args.push('--', ...paths);
  return args;
};

const listScopeFiles = (top, paths = [], options = {}) => {
  const rev = options.commit;
  const args = rev ? listTreeArgs(rev, paths) : listWorktreeArgs(paths);
  const result = requireOk(runGit(args, top), 'ls-files failed');
  const names = filterListed(namesFromLs(result.stdout));
  names.sort((left, right) => left.localeCompare(right, 'en'));
  return names;
};

const binaryNewFile = (rel) => ({
  oldPath: rel,
  newPath: rel,
  isNew: true,
  isDeleted: false,
  isBinary: true,
  preamble: [`diff --git a/${rel} b/${rel}`, 'new file mode 100644'],
  hunks: [],
});

const untrackedItemsFrom = (top, names) => {
  const files = [];
  for (const rel of names) {
    if (isReviewFile(rel)) continue;
    const full = path.join(top, rel);
    let buf;
    try {
      buf = fs.readFileSync(full);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (isBinaryBuffer(buf)) {
      files.push(binaryNewFile(rel));
      continue;
    }
    files.push(synthesizeNewFile(rel, buf.toString('utf8')));
  }
  return itemsFromFiles(files, 'untracked');
};

const mergeItems = (groups) => {
  const byPath = new Map();
  for (const group of groups) {
    for (const item of group) {
      const rel = itemPath(item);
      const list = byPath.get(rel);
      if (list) {
        list.push(item);
        continue;
      }
      byPath.set(rel, [item]);
    }
  }
  return [...byPath.values()].flat();
};

const gitText = (top, spec) => {
  const result = runGit(['show', spec], top);
  if (result.status !== 0) return '';
  return result.stdout ?? '';
};

const worktreeText = (top, rel) => {
  try {
    return fs.readFileSync(path.join(top, rel), 'utf8');
  } catch {
    return '';
  }
};

const fileText = (top, rel, rev) => {
  if (!rel) return '';
  if (rev) return gitText(top, `${rev}:${rel}`);
  return worktreeText(top, rel);
};

const readDepSides = (top, rev, origin, rel) => {
  if (origin === 'untracked') {
    const newText = worktreeText(top, rel);
    return { oldText: '', newText };
  }
  if (origin === 'staged') {
    const oldText = gitText(top, `HEAD:${rel}`);
    const newText = gitText(top, `:${rel}`);
    return { oldText, newText };
  }
  if (origin === 'unstaged') {
    const indexed = gitText(top, `:${rel}`);
    const oldText = indexed || gitText(top, `HEAD:${rel}`);
    const newText = worktreeText(top, rel);
    return { oldText, newText };
  }
  if (origin === 'commit' && rev) {
    const oldText = gitText(top, `${rev}^:${rel}`);
    const newText = gitText(top, `${rev}:${rel}`);
    return { oldText, newText };
  }
  return { oldText: '', newText: '' };
};

const toplevel = (cwd) => {
  const result = runGit(['rev-parse', '--show-toplevel'], cwd);
  if (result.status !== 0) throw new Error('not a git repository');
  return result.stdout.trim();
};

const resolveRev = (cwd, spec) => {
  if (!spec) return null;
  const top = toplevel(cwd);
  const args = ['rev-parse', '--verify', `${spec}^{commit}`];
  const result = runGit(args, top);
  if (result.status !== 0) return null;
  return result.stdout.trim();
};

const shortRev = (top, commit) => {
  const result = runGit(['rev-parse', '--short', commit], top);
  if (result.status !== 0) return commit.slice(0, 7);
  return result.stdout.trim();
};

const currentBranch = (top) => {
  const args = ['rev-parse', '--abbrev-ref', 'HEAD'];
  const result = runGit(args, top);
  if (result.status !== 0) return '';
  const name = result.stdout.trim();
  if (!name || name === 'HEAD') return '';
  return name;
};

const snapshotWorktree = (top, stagedOut, unstagedOut, names) => {
  const stagedDiff = parseDiff(stagedOut);
  const unstagedDiff = parseDiff(unstagedOut);
  const staged = itemsFromFiles(stagedDiff, 'staged');
  const unstaged = itemsFromFiles(unstagedDiff, 'unstaged');
  const untracked = untrackedItemsFrom(top, names);
  const combined = mergeItems([staged, unstaged, untracked]);
  const parsed = dropReviewItems(combined);
  const branch = currentBranch(top);
  return { top, parsed, branch };
};

const snapshotCommit = (top, commit, files) => {
  const commitItems = itemsFromFiles(files, 'commit');
  const parsed = dropReviewItems(commitItems);
  const revShort = shortRev(top, commit);
  const branch = currentBranch(top);
  return { top, parsed, rev: commit, revShort, branch };
};

const loadCommit = (top, commit, extra) => {
  const parent = runGit(['rev-parse', '--verify', `${commit}^`], top);
  const args = commitDiffArgs(commit, parent, extra);
  const result = requireOk(runGit(args, top));
  return parseDiff(result.stdout);
};

const loadCommitAsync = async (top, commit, extra, signal) => {
  const parent = await runGitAsync(
    ['rev-parse', '--verify', `${commit}^`],
    top,
    { signal },
  );
  const args = commitDiffArgs(commit, parent, extra);
  const result = requireOk(await runGitAsync(args, top, { signal }));
  return parseDiff(result.stdout);
};

const readSnapshot = (cwd, paths, options) => {
  const top = toplevel(cwd);
  const extra = pathArgsOf(paths);
  const rev = options.commit;
  if (rev) return snapshotCommit(top, rev, loadCommit(top, rev, extra));
  const stagedRes = requireOk(runGit(cachedDiffArgs(extra), top));
  const unstagedRes = requireOk(runGit(worktreeDiffArgs(extra), top));
  const names = listUntracked(top, paths);
  return snapshotWorktree(top, stagedRes.stdout, unstagedRes.stdout, names);
};

const readSnapshotAsync = async (cwd, paths, options) => {
  const top = toplevel(cwd);
  const extra = pathArgsOf(paths);
  const rev = options.commit;
  const signal = options.signal;
  if (rev) {
    const files = await loadCommitAsync(top, rev, extra, signal);
    return snapshotCommit(top, rev, files);
  }
  const stagedArgs = cachedDiffArgs(extra);
  const unstagedArgs = worktreeDiffArgs(extra);
  const lsArgs = untrackedLsArgs(paths);
  const stagedP = runGitAsync(stagedArgs, top, { signal });
  const unstagedP = runGitAsync(unstagedArgs, top, { signal });
  const lsP = runGitAsync(lsArgs, top, { signal });
  const extras = await Promise.all([stagedP, unstagedP, lsP]);
  const stagedRes = extras[0];
  const unstagedRes = extras[1];
  const lsRes = extras[2];
  requireOk(stagedRes);
  requireOk(unstagedRes);
  const names = namesFromLs(requireOk(lsRes).stdout);
  return snapshotWorktree(top, stagedRes.stdout, unstagedRes.stdout, names);
};

const applyPatch = (cwd, patch, flags) => {
  const args = ['apply', ...flags, '--whitespace=nowarn', '-'];
  const result = runGit(args, cwd, patch);
  requireOk(result, 'apply failed');
};

const addItem = (top, item) => {
  if (item.origin === 'staged' || item.origin === 'commit') return;
  if (item.origin === 'untracked' || item.file.isBinary) {
    return void requireOk(runGit(['add', '--', item.file.newPath], top));
  }
  applyPatch(top, item.patchAdd, ['--cached']);
};

const unstageItem = (top, item) => {
  if (item.origin !== 'staged') return;
  const rel = itemPath(item);
  if (item.file.isBinary) {
    return void requireOk(runGit(['restore', '--staged', '--', rel], top));
  }
  applyPatch(top, item.patchAdd, ['--reverse', '--cached']);
};

const revertOnePath = (top, rel, items) => {
  const origins = new Set();
  let isNew = false;
  for (const item of items) {
    origins.add(item.origin);
    if (item.file && item.file.isNew) isNew = true;
  }
  if (isNew) {
    if (origins.has('staged')) {
      return void requireOk(runGit(['rm', '-f', '--', rel], top));
    }
    return void fs.unlinkSync(path.join(top, rel));
  }
  if (origins.has('untracked') && origins.size === 1) {
    return void fs.unlinkSync(path.join(top, rel));
  }
  const args = ['restore', '-s', 'HEAD', '--worktree', '--staged', '--', rel];
  requireOk(runGit(args, top));
};

const revertItem = (top, item) => {
  if (item.origin === 'commit') return;
  const rel = itemPath(item);
  if (item.origin === 'untracked') {
    return void fs.unlinkSync(path.join(top, rel));
  }
  if (item.file.isBinary) {
    const args = ['restore', '-s', 'HEAD', '--worktree'];
    if (item.origin === 'staged') args.push('--staged');
    args.push('--', rel);
    return void requireOk(runGit(args, top));
  }
  if (item.origin === 'unstaged') {
    return void applyPatch(top, item.patchRevert, ['--reverse']);
  }
  applyPatch(top, item.patchRevert, ['--reverse', '--cached']);
  try {
    applyPatch(top, item.patchRevert, ['--reverse']);
  } catch (error) {
    if (!error.message.includes('does not apply')) throw error;
  }
};

const indexText = (top, rel) => {
  const result = runGit(['show', `:${rel}`], top);
  requireOk(result, 'show failed');
  return result.stdout ?? '';
};

const indexMode = (top, rel) => {
  const result = requireOk(runGit(['ls-files', '--stage', '--', rel], top));
  const line = result.stdout.trim();
  if (line) return line.split(' ')[0];
  try {
    const stat = fs.statSync(path.join(top, rel));
    if (stat.mode & 0o111) return '100755';
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return '100644';
};

const writeIndex = (top, rel, text) => {
  const hashArgs = ['hash-object', '-w', `--path=${rel}`, '--stdin'];
  const hashed = runGit(hashArgs, top, text);
  requireOk(hashed, 'hash-object failed');
  const sha = (hashed.stdout ?? '').trim();
  const mode = indexMode(top, rel);
  const args = ['update-index', '--add', '--cacheinfo', mode, sha, rel];
  requireOk(runGit(args, top), 'update-index failed');
};

const editStaged = (top, rel, abs, hunk, blockId, text) => {
  const source = indexText(top, rel);
  const next = replaceBlockAdds(source, hunk, blockId, text);
  writeIndex(top, rel, next);
  let work = null;
  try {
    work = fs.readFileSync(abs, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (work === null) {
    return void fs.writeFileSync(abs, next);
  }
  if (work === source) fs.writeFileSync(abs, next);
};

const editWorktree = (abs, hunk, blockId, text) => {
  const source = fs.readFileSync(abs, 'utf8');
  const next = replaceBlockAdds(source, hunk, blockId, text);
  if (next === source) return;
  fs.writeFileSync(abs, next);
};

const editItem = (top, item, text) => {
  if (item.origin === 'commit' || item.origin === 'pr') return;
  const rel = itemPath(item);
  if (!rel || !item.hunk) return;
  const abs = path.join(top, rel);
  if (item.origin === 'staged') {
    return void editStaged(top, rel, abs, item.hunk, item.blockId, text);
  }
  editWorktree(abs, item.hunk, item.blockId, text);
};

const writeFile = (top, rel, text) => {
  if (!rel) return;
  const abs = path.join(top, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
};

const stagePath = (top, rel) => {
  if (!rel) return;
  requireOk(runGit(['add', '--', rel], top));
};

module.exports = {
  oneLine,
  requireOk,
  runGit,
  runGitAsync,
  gitText,
  worktreeText,
  readDepSides,
  revertOnePath,
  toplevel,
  resolveRev,
  currentBranch,
  fileText,
  listScopeFiles,
  readSnapshot,
  readSnapshotAsync,
  editItem,
  writeFile,
  writeIndex,
  stagePath,
  addItem,
  unstageItem,
  revertItem,
};
