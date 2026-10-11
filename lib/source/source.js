'use strict';

const github = require('./github.js');
const gitlab = require('./gitlab.js');
const { capabilitiesFor, attachCapabilities } = require('./capabilities.js');
const { parseGithubPrUrl, parseGithubIssueUrl } = github;
const { parseGithubIssueListUrl } = github;
const { parseGitlabMrUrl, parseGitlabIssueUrl } = gitlab;
const { parseGitlabIssueListUrl } = gitlab;

const REMOTE_KINDS = {
  pr: {
    option: 'loadPullRequest',
    load: github.loadPullRequest,
    token: github.githubToken,
    target: (selected) => selected.pr,
  },
  mr: {
    option: 'loadMergeRequest',
    load: gitlab.loadMergeRequest,
    token: gitlab.gitlabToken,
    target: (selected) => selected.mr,
  },
  issue: {
    option: 'loadGithubIssue',
    load: github.loadGithubIssue,
    token: github.githubToken,
    target: (selected) => selected.issue,
  },
  'gl-issue': {
    option: 'loadGitlabIssue',
    load: gitlab.loadGitlabIssue,
    token: gitlab.gitlabToken,
    target: (selected) => selected.issue,
  },
};

const remoteKind = (selected) => REMOTE_KINDS[selected.kind] ?? null;

const selectChangeSource = (paths) => {
  if (!paths.length) return { kind: 'local', paths };
  const first = paths[0];
  const rest = paths.slice(1);
  const pr = parseGithubPrUrl(first);
  if (pr) return { kind: 'pr', pr, paths: rest };
  const githubIssue = parseGithubIssueUrl(first);
  if (githubIssue) return { kind: 'issue', issue: githubIssue, paths: rest };
  const githubIssues = parseGithubIssueListUrl(first);
  if (githubIssues) return { kind: 'issue', issue: githubIssues, paths: rest };
  const mr = parseGitlabMrUrl(first);
  if (mr) return { kind: 'mr', mr, paths: rest };
  const gitlabIssue = parseGitlabIssueUrl(first);
  if (gitlabIssue) return { kind: 'gl-issue', issue: gitlabIssue, paths: rest };
  const gitlabIssues = parseGitlabIssueListUrl(first);
  if (gitlabIssues) {
    return { kind: 'gl-issue', issue: gitlabIssues, paths: rest };
  }
  return { kind: 'local', paths };
};

const createLoadedSource = (loaded, kind = 'pr', extra = {}) => {
  const load = () => {
    const items = loaded.items ?? [];
    return { ...loaded, items: [...items] };
  };
  const impl = {
    load,
    resolveRev: () => null,
  };
  if (extra.loadAsync) impl.loadAsync = extra.loadAsync;
  return attachCapabilities(impl, capabilitiesFor(kind));
};

module.exports = {
  remoteKind,
  selectChangeSource,
  createLoadedSource,
};
