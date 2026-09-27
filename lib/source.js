'use strict';

const github = require('./github.js');
const { parseGithubPrUrl } = github;
const gitlab = require('./gitlab.js');
const { parseGitlabMrUrl } = gitlab;
const capabilities = require('./capabilities.js');
const { capabilitiesFor, attachCapabilities } = capabilities;

const selectChangeSource = (paths) => {
  if (!paths.length) return { kind: 'local', paths };
  const first = paths[0];
  const pr = parseGithubPrUrl(first);
  if (pr) return { kind: 'pr', pr, paths: paths.slice(1) };
  const mr = parseGitlabMrUrl(first);
  if (mr) return { kind: 'mr', mr, paths: paths.slice(1) };
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
  selectChangeSource,
  createLoadedSource,
};
