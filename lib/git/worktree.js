'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { runProc, runProcSync, isAbort } = require('../common/process.js');
const { oneLine, readText } = require('../common/utilities.js');
const diff = require('../diff/diff.js');
const { parseDiff, synthesizeNewFile, itemsFromFiles } = diff;
const files = require('../common/files.js');
const { groupByPath } = files;
const { itemPath, isReadOnlyOrigin, lineDelta, REVIEW_DIR } = files;
const { replaceBlockAdds } = require('../diff/patch.js');

const GIT_CONFIG = [
  '-c',
  'core.quotepath=false',
  '-c',
  'i18n.logOutputEncoding=utf-8',
];
const DIFF_OPTS = ['--no-color', '--no-ext-diff', '--no-renames', '-U3'];
const BINARY_SIZE = 1000000;

const gitOptions = (cwd, extra) => ({
  cwd,
  env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...extra.env },
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

const runGit = (args, cwd, extra = {}) =>
  gitResult(runProcSync('git', args, gitOptions(cwd, extra)));

const runGitAsync = (args, cwd, extra = {}) =>
  runProc('git', args, gitOptions(cwd, extra)).then(gitResult);

const command = (args, extra = {}) => ({
  args,
  input: extra.input,
  env: extra.env,
});

const runStepsAsync = async (steps, top, signal) => {
  try {
    let step = steps.next();
    while (!step.done) {
      const extra = { ...step.value, signal };
      step = steps.next(await runGitAsync(step.value.args, top, extra));
    }
    return step.value;
  } finally {
    steps.return();
  }
};

const gitOp =
  (op) =>
  (top, ...args) =>
    runStepsAsync(op(...args), top);

const pathArgs = (paths) => (paths.length ? ['--', ...paths] : []);

const diffArgs = (revs, paths) => [
  ...GIT_CONFIG,
  'diff',
  ...DIFF_OPTS,
  ...revs,
  ...pathArgs(paths),
];

const commitDiffArgs = (commit, parent, paths) => {
  if (parent.status === 0) {
    return diffArgs([parent.stdout.trim(), commit], paths);
  }
  return [
    ...GIT_CONFIG,
    'diff-tree',
    '--no-commit-id',
    '--root',
    '-p',
    ...DIFF_OPTS,
    commit,
    ...pathArgs(paths),
  ];
};

const untrackedArgs = (paths) => [
  'ls-files',
  '-o',
  '--exclude-standard',
  '-z',
  ...pathArgs(paths),
];

const isReviewFile = (rel) => rel.split(/[/\\]/)[0] === REVIEW_DIR;

const isDirEntry = (rel) => rel.endsWith('/');

const dropReviewItems = (items) =>
  items.filter((item) => !isReviewFile(itemPath(item)));

const isBinaryBuffer = (buf) => buf.length > BINARY_SIZE || buf.includes(0);

const namesFromLs = (stdout) => stdout.split('\0').filter(Boolean);

const listScopeFiles = (top, paths = [], options = {}) => {
  const rev = options.commit;
  const args = rev
    ? ['ls-tree', '-r', '--name-only', '-z', rev, ...pathArgs(paths)]
    : ['ls-files', '-co', '--exclude-standard', '-z', ...pathArgs(paths)];
  const result = requireOk(runGit(args, top), 'ls-files failed');
  const names = namesFromLs(result.stdout).filter(
    (rel) => !isReviewFile(rel) && !isDirEntry(rel),
  );
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

const UNTRACKED_READS = 16;

const untrackedNames = (names) =>
  names.filter((rel) => !isReviewFile(rel) && !isDirEntry(rel));

const untrackedFile = (rel, buf) =>
  isBinaryBuffer(buf)
    ? binaryNewFile(rel)
    : synthesizeNewFile(rel, buf.toString('utf8'));

const isGone = (error) => error.code === 'ENOENT' || error.code === 'EISDIR';

const untrackedItemsFrom = (top, names) => {
  const files = [];
  for (const rel of untrackedNames(names)) {
    try {
      files.push(untrackedFile(rel, fs.readFileSync(path.join(top, rel))));
    } catch (error) {
      if (!isGone(error)) throw error;
    }
  }
  return itemsFromFiles(files, 'untracked');
};

const readUntracked = async (top, rel) => {
  try {
    return untrackedFile(rel, await fs.promises.readFile(path.join(top, rel)));
  } catch (error) {
    if (isGone(error)) return null;
    throw error;
  }
};

const untrackedItemsAsync = async (top, names) => {
  const rels = untrackedNames(names);
  const files = [];
  for (let at = 0; at < rels.length; at += UNTRACKED_READS) {
    const batch = rels.slice(at, at + UNTRACKED_READS);
    const read = await Promise.all(batch.map((rel) => readUntracked(top, rel)));
    for (const file of read) if (file) files.push(file);
  }
  return itemsFromFiles(files, 'untracked');
};

const countUntrackedAdded = async (top) => {
  try {
    const result = await runGitAsync(untrackedArgs([]), top);
    if (result.status !== 0) return 0;
    const items = untrackedItemsFrom(top, namesFromLs(result.stdout));
    let added = 0;
    for (const item of items) added += lineDelta(item).added;
    return added;
  } catch {
    return 0;
  }
};

const gitText = (top, spec) => {
  const result = runGit(['show', spec], top);
  return result.status === 0 ? result.stdout : '';
};

const worktreeText = (top, rel) => readText(path.join(top, rel));

const fileText = (top, rel, rev) => {
  if (!rel) return '';
  if (rev) return gitText(top, `${rev}:${rel}`);
  return worktreeText(top, rel);
};

const readDepSides = (top, rev, origin, rel) => {
  if (origin === 'untracked') {
    return { oldText: '', newText: worktreeText(top, rel) };
  }
  if (origin === 'staged') {
    const oldText = gitText(top, `HEAD:${rel}`);
    return { oldText, newText: gitText(top, `:${rel}`) };
  }
  if (origin === 'unstaged') {
    const oldText = gitText(top, `:${rel}`) || gitText(top, `HEAD:${rel}`);
    return { oldText, newText: worktreeText(top, rel) };
  }
  if (origin === 'commit' && rev) {
    const oldText = gitText(top, `${rev}^:${rel}`);
    return { oldText, newText: gitText(top, `${rev}:${rel}`) };
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
  const args = ['rev-parse', '--verify', `${spec}^{commit}`];
  const result = runGit(args, toplevel(cwd));
  return result.status === 0 ? result.stdout.trim() : null;
};

const shortRev = (top, commit) => {
  const result = runGit(['rev-parse', '--short', commit], top);
  return result.status === 0 ? result.stdout.trim() : commit.slice(0, 7);
};

const branchName = (result) => {
  if (result.status !== 0) return '';
  const name = result.stdout.trim();
  return name === 'HEAD' ? '' : name;
};

const BRANCH_ARGS = ['rev-parse', '--abbrev-ref', 'HEAD'];

const currentBranch = (top) => branchName(runGit(BRANCH_ARGS, top));

const worktreeSnapshot = (top, outputs, untracked, branch) => {
  const staged = itemsFromFiles(parseDiff(outputs[0]), 'staged');
  const unstaged = itemsFromFiles(parseDiff(outputs[1]), 'unstaged');
  const grouped = groupByPath([...staged, ...unstaged, ...untracked]);
  const parsed = dropReviewItems([...grouped.values()].flat());
  return { top, parsed, branch };
};

const snapshotCommit = (top, commit, files) => {
  const parsed = dropReviewItems(itemsFromFiles(files, 'commit'));
  const revShort = shortRev(top, commit);
  return { top, parsed, rev: commit, revShort, branch: currentBranch(top) };
};

function* commitDiff(commit, paths) {
  const parent = yield command(['rev-parse', '--verify', `${commit}^`]);
  const result = yield command(commitDiffArgs(commit, parent, paths));
  return parseDiff(requireOk(result).stdout);
}

const worktreeCommands = (paths) => [
  diffArgs(['--cached'], paths),
  diffArgs([], paths),
  untrackedArgs(paths),
];

const toplevelAsync = async (cwd, signal) => {
  const args = ['rev-parse', '--show-toplevel'];
  const result = await runGitAsync(args, cwd, { signal });
  if (result.status !== 0) throw new Error('not a git repository');
  return result.stdout.trim();
};

const readSnapshot = async (cwd, paths, options) => {
  const { commit: rev, signal } = options;
  const top = await toplevelAsync(cwd, signal);
  if (rev) {
    const files = await runStepsAsync(commitDiff(rev, paths), top, signal);
    return snapshotCommit(top, rev, files);
  }
  const commands = [...worktreeCommands(paths), BRANCH_ARGS];
  const running = commands.map((args) => runGitAsync(args, top, { signal }));
  const results = await Promise.all(running);
  const branch = branchName(results.pop());
  const outputs = results.map((result) => requireOk(result).stdout);
  const names = namesFromLs(outputs[2]);
  const untracked = await untrackedItemsAsync(top, names);
  return worktreeSnapshot(top, outputs, untracked, branch);
};

const applyPatch = (cwd, patch, flags) => {
  const args = ['apply', ...flags, '--whitespace=nowarn', '-'];
  requireOk(runGit(args, cwd, { input: patch }), 'apply failed');
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
  if (item.file.isBinary) {
    const args = ['restore', '--staged', '--', itemPath(item)];
    return void requireOk(runGit(args, top));
  }
  applyPatch(top, item.patchAdd, ['--reverse', '--cached']);
};

const revertOnePath = (top, rel, items) => {
  const origins = new Set(items.map((item) => item.origin));
  const isNew = items.some((item) => item.file?.isNew);
  if (isNew && origins.has('staged')) {
    return void requireOk(runGit(['rm', '-f', '--', rel], top));
  }
  const onlyUntracked = origins.size === 1 && origins.has('untracked');
  if (isNew || onlyUntracked) return void fs.unlinkSync(path.join(top, rel));
  const args = ['restore', '-s', 'HEAD', '--worktree', '--staged', '--', rel];
  requireOk(runGit(args, top));
};

const revertItem = (top, item) => {
  const rel = itemPath(item);
  if (item.origin === 'untracked') {
    return void fs.unlinkSync(path.join(top, rel));
  }
  if (item.file.isBinary) {
    const args = ['restore', '-s', 'HEAD', '--worktree'];
    if (item.origin === 'staged') args.push('--staged');
    return void requireOk(runGit([...args, '--', rel], top));
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
  const hashed = runGit(hashArgs, top, { input: text });
  const sha = requireOk(hashed, 'hash-object failed').stdout.trim();
  const mode = indexMode(top, rel);
  const args = ['update-index', '--add', '--cacheinfo', mode, sha, rel];
  requireOk(runGit(args, top), 'update-index failed');
};

const editStaged = (top, rel, abs, item, text) => {
  const shown = requireOk(runGit(['show', `:${rel}`], top), 'show failed');
  const source = shown.stdout;
  const next = replaceBlockAdds(source, item.hunk, item.blockId, text);
  writeIndex(top, rel, next);
  let work = null;
  try {
    work = fs.readFileSync(abs, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (work === null || work === source) fs.writeFileSync(abs, next);
};

const editWorktree = (abs, item, text) => {
  const source = fs.readFileSync(abs, 'utf8');
  const next = replaceBlockAdds(source, item.hunk, item.blockId, text);
  if (next !== source) fs.writeFileSync(abs, next);
};

const editItem = (top, item, text) => {
  if (isReadOnlyOrigin(item.origin)) return;
  const rel = itemPath(item);
  if (!rel || !item.hunk) return;
  const abs = path.join(top, rel);
  if (item.origin === 'staged') {
    return void editStaged(top, rel, abs, item, text);
  }
  editWorktree(abs, item, text);
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
  requireOk,
  runGit,
  runGitAsync,
  command,
  gitOp,
  groupByPath,
  gitText,
  worktreeText,
  readDepSides,
  revertOnePath,
  toplevel,
  resolveRev,
  currentBranch,
  fileText,
  countUntrackedAdded,
  listScopeFiles,
  readSnapshot,
  editItem,
  writeFile,
  writeIndex,
  stagePath,
  addItem,
  unstageItem,
  revertItem,
};
