'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { oneLine, trimText } = require('../common/utilities.js');
const { shortAge } = require('../common/format.js');
const { requireOk, runGit, command, gitOp } = require('./worktree.js');

const BRANCH_FORMAT = [
  '%(HEAD)',
  '%(refname:short)',
  '%(objectname:short)',
  '%(committerdate:relative)',
  '%(upstream:track)',
  '%(subject)',
].join('%09');
const ORIGIN_HEAD = 'refs/remotes/origin/HEAD';
const ORIGIN_PREFIX = 'origin/';
const DEFAULT_BRANCHES = ['main', 'master'];
const PUSH_REJECTED = [
  'non-fast-forward',
  'failed to push some refs',
  'updates were rejected',
];
const COMMIT_FIELDS = ['%H', '%h', '%an', '%ae', '%ar', '%ci', '%D', '%s'];
const COMMIT_FORMAT = `${COMMIT_FIELDS.join('%x1f')}%x1e%B`;
const COMMIT_LIMIT = 256;
const UNIT = '\x1f';
const RECORD = '\x1e';
const TAG_REF = /^tag: /;
const REMOTE_HEAD = /\/HEAD(?: -> |$)/;
const STAT_LEAD = /^\n* *\d+ files? changed[^\n]*\n?/;
const FIXUP_MARK = 'fixup!';
const AUTOSQUASH_ARGS = [
  '-c',
  'sequence.editor=:',
  'rebase',
  '--interactive',
  '--autosquash',
];
const REWORD_TODO = path.join(__dirname, 'reword-todo.js');

const required = (value, message) => {
  const text = trimText(value);
  if (!text) throw new Error(message);
  return text;
};

const branchName = (name) => required(name, 'empty branch name');

const messageBody = (message) => {
  const text = `${message ?? ''}`;
  return text.endsWith('\n') ? text : `${text}\n`;
};

const commitMessage = (top, sha) => {
  const spec = trimText(sha) || 'HEAD';
  const result = runGit(['log', '-1', '--format=%B', spec], top);
  return result.status === 0 ? result.stdout.trimEnd() : '';
};

const lastMessage = (top) => commitMessage(top, 'HEAD');

const isShownRef = (name) => {
  if (!name || TAG_REF.test(name)) return false;
  return name === 'HEAD' || !REMOTE_HEAD.test(name);
};

const formatCommitRefs = (raw) => {
  const names = trimText(raw).split(', ');
  return names
    .map((name) => name.trim())
    .filter(isShownRef)
    .join(', ');
};

const parseCommitRecord = (record, index) => {
  const cut = record.indexOf(RECORD);
  if (cut < 0) return null;
  const parts = record
    .slice(0, cut)
    .split(UNIT)
    .map((part) => part.trim());
  if (parts.length < COMMIT_FIELDS.length || !parts[0]) return null;
  const sha = parts[0];
  const body = record.slice(cut + 1).trimEnd();
  return {
    sha,
    shortSha: parts[1] || sha.slice(0, 7),
    author: parts[2],
    email: parts[3],
    date: shortAge(parts[4]),
    when: parts[5],
    refs: formatCommitRefs(parts[6]),
    subject: parts[7] || body.split('\n')[0].trim(),
    body,
    added: 0,
    removed: 0,
    head: index === 0,
  };
};

const statCount = (stat, word) => {
  const match = new RegExp(`(\\d+) ${word}`).exec(stat);
  return match ? parseInt(match[1], 10) : 0;
};

const listCommits = (top) => {
  const args = [
    'log',
    '-z',
    '--shortstat',
    `--format=${COMMIT_FORMAT}`,
    `--max-count=${COMMIT_LIMIT}`,
  ];
  const result = requireOk(runGit(args, top), 'log failed');
  const commits = [];
  for (const chunk of result.stdout.split('\0')) {
    const stat = STAT_LEAD.exec(chunk);
    const last = commits.at(-1);
    if (stat && last) {
      last.added = statCount(stat[0], 'insertion');
      last.removed = statCount(stat[0], 'deletion');
    }
    const rest = stat ? chunk.slice(stat[0].length) : chunk;
    if (!rest) continue;
    const entry = parseCommitRecord(rest, commits.length);
    if (entry) commits.push(entry);
  }
  return commits;
};

const parseTrack = (text) => {
  const raw = trimText(text).replace(/^\[|\]$/g, '');
  const ahead = /ahead (\d+)/.exec(raw);
  const behind = /behind (\d+)/.exec(raw);
  return {
    ahead: ahead ? Number(ahead[1]) : 0,
    behind: behind ? Number(behind[1]) : 0,
    gone: raw === 'gone',
  };
};

const parseBranchLine = (line) => {
  const parts = line.split('\t');
  const name = trimText(parts[1]);
  if (!name) return null;
  return {
    name,
    current: parts[0].includes('*'),
    isDefault: false,
    sha: trimText(parts[2]),
    date: shortAge(parts[3]),
    subject: parts.slice(5).join('\t').trim(),
    ...parseTrack(parts[4]),
  };
};

const defaultBranch = (top, names) => {
  const result = runGit(['symbolic-ref', '--short', ORIGIN_HEAD], top);
  const ref = result.status === 0 ? result.stdout.trim() : '';
  const remote = ref.startsWith(ORIGIN_PREFIX)
    ? ref.slice(ORIGIN_PREFIX.length)
    : ref;
  if (names.has(remote)) return remote;
  return DEFAULT_BRANCHES.find((name) => names.has(name)) ?? '';
};

const listBranches = (top) => {
  const args = ['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads'];
  const result = requireOk(runGit(args, top), 'branch failed');
  const lines = result.stdout.split('\n').filter(Boolean);
  const branches = lines.map((line) => parseBranchLine(line)).filter(Boolean);
  const names = new Set(branches.map((entry) => entry.name));
  const primary = defaultBranch(top, names);
  return branches.map((entry) => ({
    ...entry,
    isDefault: entry.name === primary,
  }));
};

const hasStaged = (top) => {
  const result = runGit(['diff', '--cached', '--quiet'], top);
  return result.status === 1;
};

function* resolveCommit(sha) {
  const result = yield command(['rev-parse', sha]);
  return requireOk(result, 'rev-parse failed').stdout.trim();
}

function* rebaseRange(sha) {
  const parent = yield command(['rev-parse', '--verify', `${sha}^`]);
  return parent.status === 0 ? [parent.stdout.trim()] : ['--root'];
}

function* rebase(args, extra) {
  const result = yield command(args, extra);
  if (result.status === 0) return;
  yield command(['rebase', '--abort']);
  requireOk(result, 'rebase failed');
}

const simpleOp = (toArgs, fallback) =>
  gitOp(function* (...args) {
    const result = yield command(toArgs(...args));
    requireOk(result, fallback);
  });

const checkoutOp = simpleOp(
  (name) => ['checkout', branchName(name)],
  'checkout failed',
);

const createOp = simpleOp(
  (name) => ['checkout', '-b', branchName(name)],
  'checkout failed',
);

const dropBranchOp = simpleOp(
  (name) => ['branch', '-D', branchName(name)],
  'drop failed',
);

const pullOp = simpleOp(() => ['pull'], 'pull failed');

const rebaseOp = gitOp(function* (onto) {
  yield* rebase(['rebase', branchName(onto)]);
});

const commitOp = gitOp(function* (kind, message) {
  const args = ['commit'];
  if (kind === 'amend') args.push('--amend');
  args.push('-F', '-');
  const result = yield command(args, { input: messageBody(message) });
  requireOk(result);
});

const updateOp = gitOp(function* (sha) {
  const commit = yield* resolveCommit(required(sha, 'empty commit'));
  const head = yield* resolveCommit('HEAD');
  if (commit === head) {
    const result = yield command(['commit', '--amend', '--no-edit']);
    return void requireOk(result);
  }
  const fixed = yield command(['commit', '--fixup', commit]);
  requireOk(fixed);
  const range = yield* rebaseRange(commit);
  try {
    yield* rebase([...AUTOSQUASH_ARGS, ...range]);
  } catch (error) {
    yield command(['reset', '--soft', 'HEAD~1']);
    throw error;
  }
});

const dropCommitOp = gitOp(function* (sha) {
  const target = yield* resolveCommit(required(sha, 'empty commit'));
  const parent = yield command(['rev-parse', '--verify', `${target}^`]);
  if (parent.status !== 0) throw new Error('cannot drop root commit');
  if (target === (yield* resolveCommit('HEAD'))) {
    const result = yield command(['reset', '--soft', 'HEAD~1']);
    return void requireOk(result, 'drop failed');
  }
  yield* rebase(['rebase', '--onto', `${target}^`, target]);
});

const fixupRest = (subject) => {
  let text = subject;
  while (text.startsWith(FIXUP_MARK)) {
    text = text.slice(FIXUP_MARK.length).trim();
  }
  return text;
};

const shaWithSubject = (log, subject) => {
  for (const line of log.split('\n')) {
    const cut = line.indexOf(UNIT);
    if (cut < 0 || line.slice(cut + 1).trim() !== subject) continue;
    return line.slice(0, cut).trim();
  }
  return '';
};

function* fixupTarget(commit) {
  const shown = yield command(['log', '-1', '--format=%s', commit]);
  const subject = requireOk(shown, 'log failed').stdout.trim();
  if (!subject.startsWith(FIXUP_MARK)) throw new Error('not a fixup commit');
  const want = fixupRest(subject);
  if (!want) throw new Error('no fixup target');
  const log = yield command(['log', '--format=%H%x1f%s', `${commit}^`]);
  const original = log.status === 0 ? shaWithSubject(log.stdout, want) : '';
  if (!original) throw new Error('no fixup target');
  return original;
}

const fixupOp = gitOp(function* (sha) {
  const commit = yield* resolveCommit(required(sha, 'empty commit'));
  const original = yield* fixupTarget(commit);
  const range = yield* rebaseRange(original);
  yield* rebase([...AUTOSQUASH_ARGS, ...range]);
});

const rewordEnv = (msgFile) => {
  const node = JSON.stringify(process.execPath);
  const script = JSON.stringify(REWORD_TODO);
  return {
    GIT_SEQUENCE_EDITOR: `${node} ${script}`,
    RESLOP_REWORD_FILE: msgFile,
  };
};

const rewordOp = gitOp(function* (sha, message) {
  const commit = yield* resolveCommit(required(sha, 'empty commit'));
  const input = messageBody(message);
  if (commit === (yield* resolveCommit('HEAD'))) {
    const args = ['commit', '--amend', '--only', '-F', '-'];
    const result = yield command(args, { input });
    return void requireOk(result);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reslop-reword-'));
  try {
    const msgFile = path.join(dir, 'MSG');
    fs.writeFileSync(msgFile, input);
    const range = yield* rebaseRange(commit);
    const env = rewordEnv(msgFile);
    yield* rebase(['rebase', '--interactive', ...range], { env });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const pushArgs = (force, branch) => {
  const args = ['push'];
  if (force) args.push('--force-with-lease');
  if (branch) args.push('--set-upstream', 'origin', branch);
  return args;
};

const pushError = (text) => {
  const lower = text.toLowerCase();
  const rejected = PUSH_REJECTED.some((token) => lower.includes(token));
  const message = rejected ? 'push rejected' : oneLine(text, 'git failed');
  const error = new Error(message);
  error.rejected = rejected;
  return error;
};

const UPSTREAM_ARGS = [
  'rev-parse',
  '--abbrev-ref',
  '--symbolic-full-name',
  '@{upstream}',
];

const pushOp = gitOp(function* (force) {
  const useForce = force === true;
  const head = yield command(['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = head.stdout.trim() || 'HEAD';
  const upstream = yield command(UPSTREAM_ARGS);
  const tracked = upstream.status === 0 ? '' : branch;
  let result = yield command(pushArgs(useForce, tracked));
  const output = (result.stderr || result.stdout).toLowerCase();
  if (result.status !== 0 && output.includes('no upstream')) {
    result = yield command(pushArgs(useForce, branch));
  }
  if (result.status === 0) return;
  throw pushError(result.stderr || result.stdout || 'push failed');
});

module.exports = {
  lastMessage,
  commitMessage,
  listCommits,
  listBranches,
  hasStaged,
  checkoutBranch: checkoutOp,
  createBranch: createOp,
  rebaseBranch: rebaseOp,
  dropBranch: dropBranchOp,
  dropCommit: dropCommitOp,
  applyFixup: fixupOp,
  rewordCommit: rewordOp,
  pullChanges: pullOp,
  pushChanges: pushOp,
  commitChanges: commitOp,
  updateCommit: updateOp,
};
