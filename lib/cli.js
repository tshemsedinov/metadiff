'use strict';

const path = require('node:path');

const { exists } = require('metautil');

const { createGitRepo } = require('./git.js');
const { githubToken, loadPullRequest } = require('./github.js');
const { gitlabToken, loadMergeRequest } = require('./gitlab.js');
const { selectChangeSource, createLoadedSource } = require('./source.js');
const { Session } = require('./session.js');
const { capabilitiesFor, attachCapabilities } = require('./capabilities.js');
const { setTheme } = require('./ansi.js');
const { runCapture } = require('./report-run.js');

const HEX_REV = /^[0-9a-f]{4,40}$/i;
const HEAD_REV = /^HEAD([~^].*)?$/i;
const RANGE_REV = /[~^]/;

const USAGE =
  'Usage: reslop [-n] [-r] [-light] [path | commit | pr-url | mr-url]';

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
};

const errorMessage = (reason) => {
  if (reason instanceof Error) return reason.message;
  if (reason === null || reason === undefined) return '';
  if (typeof reason === 'string') return reason;
  return `${reason}`;
};

const fail = (stderr, reason) => {
  stderr.write(`reslop: ${errorMessage(reason)}\n`);
  return 1;
};

const parseArgv = (argv) => {
  const paths = [];
  let newReview = false;
  let readOnly = false;
  let theme = 'dark';
  for (const arg of argv) {
    if (arg === '-n') {
      newReview = true;
      continue;
    }
    if (arg === '-r') {
      readOnly = true;
      continue;
    }
    if (arg === '-light') {
      theme = 'light';
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`unknown option ${arg}`);
    }
    paths.push(arg);
  }
  return { paths, newReview, readOnly, theme };
};

const looksLikeRev = (spec) => {
  if (!spec) return false;
  if (HEX_REV.test(spec)) return true;
  if (HEAD_REV.test(spec)) return true;
  return RANGE_REV.test(spec);
};

const resolveScope = async (cwd, paths, repo) => {
  if (!paths.length) return { rev: null, paths };
  const first = paths[0];
  if (await exists(path.resolve(cwd, first))) {
    return { rev: null, paths };
  }
  const resolved = repo.resolveRev(cwd, first);
  if (resolved) {
    if (paths.length > 1) {
      throw new Error('use a commit or a path, not both');
    }
    return { rev: resolved, paths: [] };
  }
  if (looksLikeRev(first)) {
    throw new Error(`bad revision ${first}`);
  }
  return { rev: null, paths };
};

const sessionOptions = (proc, deps, args, env, extra) => ({
  cwd: deps.cwd ?? proc.cwd(),
  stdin: proc.stdin,
  stdout: proc.stdout,
  color: proc.stdout.isTTY === true && !env.NO_COLOR,
  startPane: 'files',
  newReview: args.newReview,
  readOnly: args.readOnly,
  audit: true,
  ...extra,
});

const openLocalSession = async (proc, deps, args, selected, env) => {
  const cwd = deps.cwd ?? proc.cwd();
  const rawRepo = deps.repo ?? createGitRepo();
  const scope = await resolveScope(cwd, selected.paths, rawRepo);
  const kind = scope.rev ? 'commit' : 'local';
  const capabilities = capabilitiesFor(kind, { readOnly: args.readOnly });
  const repo = attachCapabilities(rawRepo, capabilities);
  const extra = {
    repo,
    paths: scope.paths,
    rev: scope.rev,
    capabilities,
  };
  const options = sessionOptions(proc, deps, args, env, extra);
  const session = new Session(options);
  session.ensureRepo();
  return session;
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

const openRemoteSession = (proc, deps, args, selected, env) => {
  const cwd = deps.cwd ?? proc.cwd();
  const capabilities = capabilitiesFor(selected.kind, {
    readOnly: args.readOnly,
  });
  const repo = remoteRepo(deps, selected, env, cwd);
  const extra = { repo, paths: selected.paths, capabilities };
  const options = sessionOptions(proc, deps, args, env, extra);
  const session = new Session(options);
  session.ensureRepo();
  return session;
};

const loadSession = async (proc, deps, args) => {
  const env = proc.env ?? {};
  const selected = selectChangeSource(args.paths);
  if (REMOTE_CHANGE[selected.kind]) {
    return openRemoteSession(proc, deps, args, selected, env);
  }
  return openLocalSession(proc, deps, args, selected, env);
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
    args = parseArgv(proc.argv.slice(2));
  } catch (error) {
    fail(stderr, error);
    stderr.write(`${USAGE}\n`);
    return 1;
  }
  setTheme(args.theme);
  let session;
  try {
    session = await loadSession(proc, deps, args);
  } catch (error) {
    return fail(stderr, error);
  }
  const tty = proc.stdin.isTTY === true && stdout.isTTY === true;
  if (tty) return runUi(session, proc);
  try {
    await session.loadReady();
  } catch (error) {
    return fail(stderr, error);
  }
  if (!session.items.length) {
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
  run,
};
