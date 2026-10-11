'use strict';

const path = require('node:path');

const { exists } = require('metautil');

const { errorMessage } = require('./common/utilities.js');
const { createGitRepo } = require('./git/git.js');
const github = require('./source/github.js');
const gitlab = require('./source/gitlab.js');
const { githubToken, loadPullRequest, loadGithubIssue } = github;
const { gitlabToken, loadMergeRequest, loadGitlabIssue } = gitlab;
const {
  selectChangeSource,
  createLoadedSource,
} = require('./source/source.js');
const { Session } = require('./session/session.js');
const { hasNotes } = require('./review/review.js');
const {
  capabilitiesFor,
  attachCapabilities,
} = require('./source/capabilities.js');
const { runCapture } = require('./report/run.js');
const { workspaceFromArgs } = require('./dashboard/workspace.js');

const HEX_REV = /^[0-9a-f]{4,40}$/i;
const HEAD_REV = /^HEAD([~^].*)?$/i;
const RANGE_REV = /[~^]/;

const USAGE =
  'Usage: reslop [-r] [path | commit | pr-url | mr-url | issue-url]';

const REMOTE_CHANGE = {
  pr: {
    load: 'loadPullRequest',
    fallback: loadPullRequest,
    token: githubToken,
    target: (selected) => selected.pr,
  },
  mr: {
    load: 'loadMergeRequest',
    fallback: loadMergeRequest,
    token: gitlabToken,
    target: (selected) => selected.mr,
  },
  issue: {
    load: 'loadGithubIssue',
    fallback: loadGithubIssue,
    token: githubToken,
    target: (selected) => selected.issue,
  },
  'gl-issue': {
    load: 'loadGitlabIssue',
    fallback: loadGitlabIssue,
    token: gitlabToken,
    target: (selected) => selected.issue,
  },
};

const fail = (stderr, reason) => {
  stderr.write(`reslop: ${errorMessage(reason)}\n`);
  return 1;
};

const parseArgv = (argv) => {
  const paths = [];
  let readOnly = false;
  for (const arg of argv) {
    if (arg === '-r') readOnly = true;
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
    else paths.push(arg);
  }
  return { paths, readOnly };
};

const looksLikeRev = (spec) =>
  HEX_REV.test(spec) || HEAD_REV.test(spec) || RANGE_REV.test(spec);

const resolveScope = async (cwd, paths, repo) => {
  if (!paths.length) return { rev: null, paths };
  const first = paths[0];
  if (await exists(path.resolve(cwd, first))) return { rev: null, paths };
  const resolved = repo.resolveRev(cwd, first);
  if (resolved) {
    if (paths.length > 1) throw new Error('use a commit or a path, not both');
    return { rev: resolved, paths: [] };
  }
  if (looksLikeRev(first)) throw new Error(`bad revision ${first}`);
  return { rev: null, paths };
};

const localOptions = async (deps, args, selected, cwd) => {
  const rawRepo = deps.repo ?? createGitRepo();
  const found = workspaceFromArgs(cwd, selected.paths);
  if (found) {
    const capabilities = capabilitiesFor('local', { readOnly: args.readOnly });
    return {
      cwd: found.root,
      repo: attachCapabilities(rawRepo, capabilities),
      paths: [],
      rev: null,
      capabilities,
      startPane: 'repos',
      workspace: found,
      repoName: path.basename(found.root),
    };
  }
  const scope = await resolveScope(cwd, selected.paths, rawRepo);
  const kind = scope.rev ? 'commit' : 'local';
  const capabilities = capabilitiesFor(kind, { readOnly: args.readOnly });
  const direct = scope.rev || scope.paths.length;
  return {
    repo: attachCapabilities(rawRepo, capabilities),
    paths: scope.paths,
    rev: scope.rev,
    capabilities,
    startPane: direct ? 'files' : 'dashboard',
  };
};

const remoteRepo = (deps, selected, env, cwd) => {
  if (deps.repo) return deps.repo;
  const remote = REMOTE_CHANGE[selected.kind];
  const loader = deps[remote.load] ?? remote.fallback;
  const token = remote.token(env);
  const loadRemote = async (_cwd, _paths, options = {}) => {
    const loaded = await loader(remote.target(selected), {
      cwd,
      paths: selected.paths,
      token,
      fetch: deps.fetch,
      signal: options.signal,
    });
    const items = loaded.items ?? [];
    return { ...loaded, items: [...items] };
  };
  return createLoadedSource({ items: [] }, selected.kind, {
    loadAsync: loadRemote,
  });
};

const remoteOptions = (deps, args, selected, cwd, env) => ({
  repo: remoteRepo(deps, selected, env, cwd),
  paths: selected.paths,
  capabilities: capabilitiesFor(selected.kind, { readOnly: args.readOnly }),
});

const loadSession = async (proc, deps, args) => {
  const env = proc.env ?? {};
  const cwd = deps.cwd ?? proc.cwd();
  const selected = selectChangeSource(args.paths);
  const extra = REMOTE_CHANGE[selected.kind]
    ? remoteOptions(deps, args, selected, cwd, env)
    : await localOptions(deps, args, selected, cwd);
  const session = new Session({
    cwd,
    stdin: proc.stdin,
    stdout: proc.stdout,
    color: proc.stdout.isTTY === true && !env.NO_COLOR,
    startPane: 'files',
    readOnly: args.readOnly,
    audit: true,
    ...extra,
  });
  if (session.pane !== 'repos') session.ensureRepo();
  return session;
};

const runUi = async (session, proc) => {
  const code = await session.startUi();
  if (session.loadError) return fail(proc.stderr, session.loadError);
  if (session.emptyReview) proc.stdout.write('nothing to review\n');
  return code;
};

const run = async (proc, deps = {}) => {
  const argv = proc.argv.slice(2);
  if (argv[0] === 't') return runCapture(proc, deps);
  const stdout = proc.stdout;
  const stderr = proc.stderr;
  let args;
  try {
    args = parseArgv(argv);
  } catch (error) {
    fail(stderr, error);
    stderr.write(`${USAGE}\n`);
    return 1;
  }
  let session;
  try {
    session = await loadSession(proc, deps, args);
  } catch (error) {
    return fail(stderr, error);
  }
  const tty = proc.stdin.isTTY === true && stdout.isTTY === true;
  if (tty) return runUi(session, proc);
  if (session.pane === 'repos') {
    stderr.write('reslop: interactive terminal required\n');
    return 1;
  }
  try {
    await session.loadReady();
  } catch (error) {
    return fail(stderr, error);
  }
  const noted = session.notes ? hasNotes(session.notes) : false;
  if (!session.items.length && !noted) {
    stdout.write('nothing to review\n');
    return 0;
  }
  stderr.write('reslop: interactive terminal required\n');
  return 1;
};

module.exports = {
  errorMessage,
  parseArgv,
  resolveScope,
  loadSession,
  run,
};
