'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const gitWorktree = require('./git-worktree.js');
const { oneLine, requireOk, runGit, runGitAsync } = gitWorktree;

const BRANCH_FORMAT = [
  '%(HEAD)',
  '%(refname:short)',
  '%(objectname:short)',
  '%(committerdate:relative)',
  '%(upstream:track)',
  '%(subject)',
].join('%09');
const TRACK_AHEAD = /ahead (\d+)/;
const TRACK_BEHIND = /behind (\d+)/;
const ORIGIN_HEAD = 'refs/remotes/origin/HEAD';
const DEFAULT_BRANCHES = ['main', 'master'];
const PUSH_REJECTED = [
  'non-fast-forward',
  'failed to push some refs',
  'updates were rejected',
];

const commitMessage = (top, sha) => {
  const spec = `${sha ?? ''}`.trim() || 'HEAD';
  const result = runGit(['log', '-1', '--format=%B', spec], top);
  if (result.status !== 0) return '';
  return (result.stdout ?? '').replace(/\s+$/, '');
};

const lastMessage = (top) => commitMessage(top, 'HEAD');

const COMMIT_FIELDS = ['%H', '%h', '%an', '%ae', '%ar', '%ci', '%D', '%s'];
const COMMIT_FORMAT = `${COMMIT_FIELDS.join('%x1f')}%x1e%B`;
const COMMIT_LIMIT = 256;
const UNIT = '\x1f';
const RECORD = '\x1e';
const TAG_REF = /^tag: /;
const REMOTE_HEAD = /\/HEAD(?: -> |$)/;

const formatCommitRefs = (raw) => {
  const text = `${raw ?? ''}`.trim();
  if (!text) return '';
  const names = [];
  for (const part of text.split(', ')) {
    const name = part.trim();
    if (!name || TAG_REF.test(name)) continue;
    if (name !== 'HEAD' && REMOTE_HEAD.test(name)) continue;
    names.push(name);
  }
  return names.join(', ');
};

const parseCommitRecord = (record, index) => {
  const cut = record.indexOf(RECORD);
  if (cut < 0) return null;
  const parts = record.slice(0, cut).split(UNIT);
  if (parts.length < COMMIT_FIELDS.length) return null;
  const sha = (parts[0] ?? '').trim();
  if (!sha) return null;
  const body = record.slice(cut + 1).replace(/\s+$/, '');
  const read = (spec) => {
    const at = COMMIT_FIELDS.indexOf(spec);
    return (parts[at] ?? '').trim();
  };
  const subject = read('%s') || body.split('\n')[0].trim();
  return {
    sha,
    shortSha: read('%h') || sha.slice(0, 7),
    author: read('%an'),
    email: read('%ae'),
    date: read('%ar'),
    when: read('%ci'),
    refs: formatCommitRefs(read('%D')),
    subject,
    body,
    head: index === 0,
  };
};

const listCommits = (top) => {
  const args = [
    'log',
    '-z',
    `--format=${COMMIT_FORMAT}`,
    `--max-count=${COMMIT_LIMIT}`,
  ];
  const result = requireOk(runGit(args, top), 'log failed');
  const commits = [];
  for (const record of result.stdout.split('\0')) {
    if (!record) continue;
    const entry = parseCommitRecord(record, commits.length);
    if (entry) commits.push(entry);
  }
  return commits;
};

const namedCommit = (sha) => {
  const commit = `${sha ?? ''}`.trim();
  if (!commit) throw new Error('empty commit');
  return commit;
};

const resolveCommit = (top, sha) => {
  const result = requireOk(runGit(['rev-parse', sha], top), 'rev-parse failed');
  return (result.stdout ?? '').trim();
};

const dropHeadCommit = (top) => {
  requireOk(runGit(['reset', '--soft', 'HEAD~1'], top), 'drop failed');
};

const runRebase = (top, args, extra = {}) => {
  const result = runGit(args, top, undefined, extra);
  if (result.status === 0) return;
  runGit(['rebase', '--abort'], top);
  requireOk(result, 'rebase failed');
};

const runRebaseAsync = async (top, args, extra = {}) => {
  const result = await runGitAsync(args, top, extra);
  if (result.status === 0) return;
  await runGitAsync(['rebase', '--abort'], top);
  requireOk(result, 'rebase failed');
};

const dropTarget = (top, sha) => {
  const target = resolveCommit(top, namedCommit(sha));
  const parent = runGit(['rev-parse', '--verify', `${target}^`], top);
  if (parent.status !== 0) throw new Error('cannot drop root commit');
  return target;
};

const dropCommit = (top, sha) => {
  const target = dropTarget(top, sha);
  if (target === resolveCommit(top, 'HEAD')) return void dropHeadCommit(top);
  runRebase(top, ['rebase', '--onto', `${target}^`, target]);
};

const dropCommitAsync = async (top, sha) => {
  const target = dropTarget(top, sha);
  if (target === resolveCommit(top, 'HEAD')) {
    requireOk(await runGitAsync(['reset', '--soft', 'HEAD~1'], top));
    return;
  }
  await runRebaseAsync(top, ['rebase', '--onto', `${target}^`, target]);
};

const FIXUP_MARK = 'fixup!';
const AUTOSQUASH_ARGS = [
  '-c',
  'sequence.editor=:',
  'rebase',
  '--interactive',
  '--autosquash',
];

const isFixupSubject = (subject) =>
  `${subject ?? ''}`.trim().startsWith(FIXUP_MARK);

const fixupRest = (subject) => {
  let text = `${subject ?? ''}`.trim();
  while (text.startsWith(FIXUP_MARK)) {
    text = text.slice(FIXUP_MARK.length).trim();
  }
  return text;
};

const commitSubject = (top, sha) => {
  const args = ['log', '-1', '--format=%s', sha];
  const result = requireOk(runGit(args, top), 'log failed');
  return (result.stdout ?? '').trim();
};

const ancestorWithSubject = (top, sha, want) => {
  const args = ['log', '--format=%H%x1f%s', `${sha}^`];
  const result = runGit(args, top);
  if (result.status !== 0) return '';
  for (const line of result.stdout.split('\n')) {
    const cut = line.indexOf(UNIT);
    if (cut < 0) continue;
    const subject = line.slice(cut + 1).trim();
    if (subject !== want) continue;
    return line.slice(0, cut).trim();
  }
  return '';
};

const rebaseRange = (top, sha) => {
  const parent = runGit(['rev-parse', '--verify', `${sha}^`], top);
  return parent.status === 0 ? [parent.stdout.trim()] : ['--root'];
};

const fixupArgs = (top, sha) => {
  const commit = resolveCommit(top, namedCommit(sha));
  const subject = commitSubject(top, commit);
  if (!isFixupSubject(subject)) throw new Error('not a fixup commit');
  const want = fixupRest(subject);
  if (!want) throw new Error('no fixup target');
  const original = ancestorWithSubject(top, commit, want);
  if (!original) throw new Error('no fixup target');
  return [...AUTOSQUASH_ARGS, ...rebaseRange(top, original)];
};

const applyFixup = (top, sha) => runRebase(top, fixupArgs(top, sha));

const applyFixupAsync = async (top, sha) =>
  runRebaseAsync(top, fixupArgs(top, sha));

const messageBody = (message) => {
  const text = `${message ?? ''}`;
  return text.endsWith('\n') ? text : `${text}\n`;
};

const REWORD_HEAD_ARGS = ['commit', '--amend', '--only', '-F', '-'];

const REWORD_TODO = path.join(__dirname, 'git-reword-todo.js');

const prepareRewordEditor = (message) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reslop-reword-'));
  const msgFile = path.join(dir, 'MSG');
  fs.writeFileSync(msgFile, messageBody(message));
  const node = JSON.stringify(process.execPath);
  const script = JSON.stringify(REWORD_TODO);
  return {
    dir,
    env: {
      GIT_SEQUENCE_EDITOR: `${node} ${script}`,
      RESLOP_REWORD_FILE: msgFile,
    },
  };
};

const rewordOlder = (top, sha, message) => {
  const prepared = prepareRewordEditor(message);
  try {
    const args = ['rebase', '--interactive', ...rebaseRange(top, sha)];
    runRebase(top, args, { env: prepared.env });
  } finally {
    fs.rmSync(prepared.dir, { recursive: true, force: true });
  }
};

const rewordOlderAsync = async (top, sha, message) => {
  const prepared = prepareRewordEditor(message);
  try {
    const args = ['rebase', '--interactive', ...rebaseRange(top, sha)];
    await runRebaseAsync(top, args, { env: prepared.env });
  } finally {
    fs.rmSync(prepared.dir, { recursive: true, force: true });
  }
};

const rewordCommit = (top, sha, message) => {
  const commit = resolveCommit(top, namedCommit(sha));
  if (commit === resolveCommit(top, 'HEAD')) {
    requireOk(runGit(REWORD_HEAD_ARGS, top, messageBody(message)));
    return;
  }
  rewordOlder(top, commit, message);
};

const rewordCommitAsync = async (top, sha, message) => {
  const commit = resolveCommit(top, namedCommit(sha));
  if (commit === resolveCommit(top, 'HEAD')) {
    const input = messageBody(message);
    requireOk(await runGitAsync(REWORD_HEAD_ARGS, top, { input }));
    return;
  }
  await rewordOlderAsync(top, commit, message);
};

const parseTrack = (text) => {
  const raw = `${text ?? ''}`.trim().replace(/^\[|\]$/g, '');
  if (!raw) return { ahead: 0, behind: 0, gone: false };
  if (raw === 'gone') return { ahead: 0, behind: 0, gone: true };
  const aheadMatch = TRACK_AHEAD.exec(raw);
  const behindMatch = TRACK_BEHIND.exec(raw);
  const ahead = aheadMatch ? Number(aheadMatch[1]) : 0;
  const behind = behindMatch ? Number(behindMatch[1]) : 0;
  return { ahead, behind, gone: false };
};

const parseBranchLine = (line) => {
  const parts = line.split('\t');
  if (parts.length < 2) return null;
  const name = (parts[1] ?? '').trim();
  if (!name) return null;
  const mark = parts[0] ?? '';
  const sha = (parts[2] ?? '').trim();
  const date = (parts[3] ?? '').trim();
  const track = parseTrack(parts[4]);
  const subject = parts.slice(5).join('\t').trim();
  return {
    name,
    current: mark.includes('*'),
    isDefault: false,
    sha,
    date,
    subject,
    ...track,
  };
};

const originHead = (top) => {
  const args = ['symbolic-ref', '--short', ORIGIN_HEAD];
  const result = runGit(args, top);
  if (result.status !== 0) return '';
  const ref = result.stdout.trim();
  const prefix = 'origin/';
  if (ref.startsWith(prefix)) return ref.slice(prefix.length);
  return ref;
};

const defaultBranch = (top, names) => {
  const remote = originHead(top);
  if (names.has(remote)) return remote;
  for (const name of DEFAULT_BRANCHES) {
    if (names.has(name)) return name;
  }
  return '';
};

const listBranches = (top) => {
  const args = ['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads'];
  const result = requireOk(runGit(args, top), 'branch failed');
  const branches = [];
  for (const line of result.stdout.split('\n')) {
    if (!line) continue;
    const entry = parseBranchLine(line);
    if (entry) branches.push(entry);
  }
  const names = new Set();
  for (const entry of branches) names.add(entry.name);
  const primary = defaultBranch(top, names);
  return branches.map((entry) => ({
    ...entry,
    isDefault: entry.name === primary,
  }));
};

const namedBranch = (name) => {
  const branch = `${name ?? ''}`.trim();
  if (!branch) throw new Error('empty branch name');
  return branch;
};

const checkoutBranch = (top, name) => {
  const branch = namedBranch(name);
  requireOk(runGit(['checkout', branch], top), 'checkout failed');
};

const checkoutBranchAsync = async (top, name) => {
  const branch = namedBranch(name);
  requireOk(await runGitAsync(['checkout', branch], top), 'checkout failed');
};

const createBranch = (top, name) => {
  const branch = namedBranch(name);
  const args = ['checkout', '-b', branch];
  requireOk(runGit(args, top), 'checkout failed');
};

const createBranchAsync = async (top, name) => {
  const branch = namedBranch(name);
  const args = ['checkout', '-b', branch];
  requireOk(await runGitAsync(args, top), 'checkout failed');
};

const rebaseBranch = (top, onto) =>
  runRebase(top, ['rebase', namedBranch(onto)]);

const rebaseBranchAsync = async (top, onto) =>
  runRebaseAsync(top, ['rebase', namedBranch(onto)]);

const dropBranch = (top, name) => {
  const branch = namedBranch(name);
  requireOk(runGit(['branch', '-D', branch], top), 'drop failed');
};

const dropBranchAsync = async (top, name) => {
  const branch = namedBranch(name);
  requireOk(await runGitAsync(['branch', '-D', branch], top), 'drop failed');
};

const pullChanges = (top) => {
  requireOk(runGit(['pull'], top), 'pull failed');
};

const pullChangesAsync = async (top) => {
  requireOk(await runGitAsync(['pull'], top), 'pull failed');
};

const isRejectedPush = (msg) => {
  const text = `${msg ?? ''}`.toLowerCase();
  for (const token of PUSH_REJECTED) {
    if (text.includes(token)) return true;
  }
  return false;
};

const pushError = (msg) => {
  const text = `${msg ?? ''}`;
  const rejected = isRejectedPush(text);
  const error = new Error(rejected ? 'push rejected' : oneLine(text));
  error.rejected = rejected;
  return error;
};

const pushBranch = (top) => {
  const result = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], top);
  const name = (result.stdout ?? '').trim();
  if (!name || name === 'HEAD') return 'HEAD';
  return name;
};

const hasUpstream = (top) => {
  const args = [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{upstream}',
  ];
  const result = runGit(args, top);
  return result.status === 0;
};

const pushCmd = (force, branch) => {
  const args = ['push'];
  if (force) args.push('--force-with-lease');
  if (branch) args.push('--set-upstream', 'origin', branch);
  return args;
};

const noUpstream = (msg) =>
  `${msg ?? ''}`.toLowerCase().includes('no upstream');

const requirePushOk = (result) => {
  if (result.status === 0) return;
  throw pushError(result.stderr || result.stdout || 'push failed');
};

const pushChanges = (top, force) => {
  const useForce = force === true;
  const branch = pushBranch(top);
  const tracked = hasUpstream(top) ? '' : branch;
  let result = runGit(pushCmd(useForce, tracked), top);
  if (result.status !== 0 && noUpstream(result.stderr || result.stdout)) {
    result = runGit(pushCmd(useForce, branch), top);
  }
  requirePushOk(result);
};

const pushChangesAsync = async (top, force) => {
  const useForce = force === true;
  const branch = pushBranch(top);
  const tracked = hasUpstream(top) ? '' : branch;
  let result = await runGitAsync(pushCmd(useForce, tracked), top);
  if (result.status !== 0 && noUpstream(result.stderr || result.stdout)) {
    result = await runGitAsync(pushCmd(useForce, branch), top);
  }
  requirePushOk(result);
};

const hasStaged = (top) => {
  const result = runGit(['diff', '--cached', '--quiet'], top);
  return result.status === 1;
};

const commitPlan = (kind, message) => {
  const args = ['commit'];
  if (kind === 'amend') args.push('--amend');
  args.push('-F', '-');
  return { args, body: messageBody(message) };
};

const commitChanges = (top, kind, message) => {
  const plan = commitPlan(kind, message);
  requireOk(runGit(plan.args, top, plan.body));
};

const commitChangesAsync = async (top, kind, message) => {
  const plan = commitPlan(kind, message);
  requireOk(await runGitAsync(plan.args, top, { input: plan.body }));
};

module.exports = {
  lastMessage,
  commitMessage,
  listCommits,
  listBranches,
  checkoutBranch,
  checkoutBranchAsync,
  createBranch,
  createBranchAsync,
  rebaseBranch,
  rebaseBranchAsync,
  dropCommit,
  dropCommitAsync,
  applyFixup,
  applyFixupAsync,
  rewordCommit,
  rewordCommitAsync,
  dropBranch,
  dropBranchAsync,
  pullChanges,
  pullChangesAsync,
  pushChanges,
  pushChangesAsync,
  hasStaged,
  commitChanges,
  commitChangesAsync,
};
