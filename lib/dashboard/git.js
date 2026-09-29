'use strict';

const fs = require('node:fs');
const path = require('node:path');

const worktree = require('../git-worktree.js');
const { runGitAsync } = worktree;

const UNIT = '\x1f';
const FIXUP_SCAN = 256;
const BRANCH_FORMAT = [
  '%(HEAD)',
  '%(refname:short)',
  '%(objectname:short)',
  '%(committerdate:unix)',
  '%(upstream:short)',
  '%(upstream:track)',
  '%(subject)',
].join('%09');
const LAST_FORMAT = ['%H', '%h', '%ct', '%s'].join('%x1f');
const TRACK_AHEAD = /ahead (\d+)/;
const TRACK_BEHIND = /behind (\d+)/;
const FIXUP_MARKS = ['fixup!', 'squash!', 'amend!'];

const attempt = async (top, args) => {
  try {
    return await runGitAsync(args, top);
  } catch {
    return { status: 1, stdout: '', stderr: '' };
  }
};

const okText = (result) => (result.status === 0 ? result.stdout.trim() : '');

const parseTrack = (text) => {
  const raw = `${text ?? ''}`;
  const ahead = TRACK_AHEAD.exec(raw);
  const behind = TRACK_BEHIND.exec(raw);
  return {
    ahead: ahead ? Number(ahead[1]) : 0,
    behind: behind ? Number(behind[1]) : 0,
    gone: raw.includes('gone'),
  };
};

const parseBranchLine = (line) => {
  const parts = line.split('\t');
  const name = (parts[1] ?? '').trim();
  if (!name) return null;
  const seconds = Number(parts[3]);
  return {
    name,
    current: (parts[0] ?? '').includes('*'),
    sha: (parts[2] ?? '').trim(),
    at: Number.isFinite(seconds) ? seconds * 1000 : 0,
    upstream: (parts[4] ?? '').trim(),
    ...parseTrack(parts[5]),
    subject: parts.slice(6).join('\t').trim(),
  };
};

const parseBranches = (text) => {
  const list = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const entry = parseBranchLine(line);
    if (entry) list.push(entry);
  }
  return list;
};

const parseLast = (text) => {
  const parts = text.split(UNIT);
  if (parts.length < 4 || !parts[0]) return null;
  const seconds = Number(parts[2]);
  return {
    sha: parts[0],
    short: parts[1],
    at: Number.isFinite(seconds) ? seconds * 1000 : 0,
    subject: parts.slice(3).join(UNIT).trim(),
  };
};

const countOf = (result) => {
  const value = parseInt(okText(result), 10);
  return Number.isFinite(value) ? value : 0;
};

const aheadBehind = (result) => {
  const parts = okText(result).split(/\s+/);
  if (parts.length < 2) return null;
  return { behind: Number(parts[0]) || 0, ahead: Number(parts[1]) || 0 };
};

const isFixup = (subject) =>
  FIXUP_MARKS.some((mark) => subject.trim().startsWith(mark));

const countFixups = (text) => {
  let count = 0;
  for (const subject of text.split('\n')) {
    if (subject && isFixup(subject)) count += 1;
  }
  return count;
};

const readNumber = (file) => {
  try {
    const value = parseInt(fs.readFileSync(file, 'utf8'), 10);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
};

const rebaseState = (gitDir) => {
  if (!gitDir) return null;
  const merge = path.join(gitDir, 'rebase-merge');
  if (fs.existsSync(merge)) {
    const step = readNumber(path.join(merge, 'msgnum'));
    const total = readNumber(path.join(merge, 'end'));
    return { step, total };
  }
  const apply = path.join(gitDir, 'rebase-apply');
  if (!fs.existsSync(apply)) return null;
  const step = readNumber(path.join(apply, 'next'));
  const total = readNumber(path.join(apply, 'last'));
  return { step, total };
};

const scanFixups = async (top, unpushed) => {
  const range = unpushed ? ['@{u}..HEAD'] : [];
  const args = ['log', '--format=%s', `--max-count=${FIXUP_SCAN}`, ...range];
  return countFixups(okText(await attempt(top, args)));
};

const commitSummary = (probes, upstream) => {
  const total = countOf(probes.total);
  const track = upstream ? aheadBehind(probes.track) : null;
  const ahead = track ? track.ahead : 0;
  return {
    total,
    upstream,
    behind: track ? track.behind : 0,
    unpushed: track ? ahead : null,
    pushed: track ? Math.max(0, total - ahead) : null,
    fixups: 0,
    last: parseLast(okText(probes.last)),
  };
};

const readGitSummary = async (top) => {
  const probes = {};
  const names = ['total', 'track', 'last', 'refs', 'dir'];
  const runs = [
    ['rev-list', '--count', 'HEAD'],
    ['rev-list', '--left-right', '--count', '@{u}...HEAD'],
    ['log', '-1', `--format=${LAST_FORMAT}`],
    ['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads'],
    ['rev-parse', '--absolute-git-dir'],
  ];
  const done = await Promise.all(runs.map((args) => attempt(top, args)));
  for (let i = 0; i < names.length; i++) probes[names[i]] = done[i];
  const branches = parseBranches(okText(probes.refs));
  const current = branches.find((entry) => entry.current) ?? null;
  const upstream = current ? current.upstream : '';
  const commits = commitSummary(probes, upstream);
  commits.fixups = await scanFixups(top, Boolean(upstream));
  return {
    branch: current ? current.name : '',
    detached: !current,
    rebase: rebaseState(okText(probes.dir)),
    commits,
    branches,
  };
};

module.exports = {
  readGitSummary,
  parseBranches,
  parseLast,
  parseTrack,
  countFixups,
  rebaseState,
};
