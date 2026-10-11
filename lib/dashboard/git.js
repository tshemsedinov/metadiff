'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readText } = require('../common/utilities.js');

const { runGitAsync } = require('../git/worktree.js');

const UNIT = '\x1f';
const RECENT_COUNT = 8;
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
const PROBES = {
  total: ['rev-list', '--count', 'HEAD'],
  recent: ['log', `--max-count=${RECENT_COUNT}`, `--format=${LAST_FORMAT}`],
  refs: ['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads'],
  dir: ['rev-parse', '--absolute-git-dir'],
};
const TRACK_AHEAD = /ahead (\d+)/;
const TRACK_BEHIND = /behind (\d+)/;

const gitText = async (top, args) => {
  try {
    const result = await runGitAsync(args, top);
    return result.status === 0 ? result.stdout.trim() : '';
  } catch {
    return '';
  }
};

const countOf = (text) => {
  const value = parseInt(text, 10);
  return Number.isFinite(value) ? value : 0;
};

const msOf = (seconds) => (Number.isFinite(seconds) ? seconds * 1000 : 0);

const parseLines = (text, parse) => text.split('\n').map(parse).filter(Boolean);

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

const parseBranch = (line) => {
  const parts = line.split('\t');
  const name = (parts[1] ?? '').trim();
  if (!name) return null;
  return {
    name,
    current: parts[0].includes('*'),
    sha: (parts[2] ?? '').trim(),
    at: msOf(Number(parts[3])),
    upstream: (parts[4] ?? '').trim(),
    ...parseTrack(parts[5]),
    subject: parts.slice(6).join('\t').trim(),
  };
};

const parseCommit = (line) => {
  const parts = line.split(UNIT);
  if (parts.length < 4 || !parts[0]) return null;
  return {
    sha: parts[0],
    short: parts[1],
    at: msOf(Number(parts[2])),
    subject: parts.slice(3).join(UNIT).trim(),
  };
};

const readNumber = (file) => countOf(readText(file));

const readStep = (dir, step, total) => ({
  step: readNumber(path.join(dir, step)),
  total: readNumber(path.join(dir, total)),
});

const rebaseState = (gitDir) => {
  if (!gitDir) return null;
  const merge = path.join(gitDir, 'rebase-merge');
  if (fs.existsSync(merge)) return readStep(merge, 'msgnum', 'end');
  const apply = path.join(gitDir, 'rebase-apply');
  if (fs.existsSync(apply)) return readStep(apply, 'next', 'last');
  return null;
};

const readGitSummary = async (top) => {
  const names = Object.keys(PROBES);
  const read = (name) => gitText(top, PROBES[name]);
  const texts = await Promise.all(names.map(read));
  const probes = {};
  for (let i = 0; i < names.length; i++) probes[names[i]] = texts[i];
  const branches = parseLines(probes.refs, parseBranch);
  const current = branches.find((entry) => entry.current);
  const recent = parseLines(probes.recent, parseCommit);
  return {
    branch: current ? current.name : '',
    rebase: rebaseState(probes.dir),
    commits: {
      total: countOf(probes.total),
      last: recent[0] ?? null,
      recent,
    },
    branches,
  };
};

module.exports = { gitText, countOf, readGitSummary, parseTrack };
