'use strict';

const READ_METHODS = [
  'load',
  'loadAsync',
  'loadExtras',
  'toplevel',
  'resolveRev',
  'listFiles',
  'fileText',
];

const CHANGE_METHODS = [
  'add',
  'addAsync',
  'unstage',
  'revert',
  'revertFile',
  'edit',
  'writeFile',
  'stagePath',
];

const BRANCH_METHODS = [
  'commit',
  'commitAsync',
  'updateCommit',
  'updateCommitAsync',
  'hasStaged',
  'lastMessage',
  'commitMessage',
  'listBranches',
  'listCommits',
  'currentBranch',
  'checkout',
  'checkoutAsync',
  'createBranch',
  'createBranchAsync',
  'rebase',
  'rebaseAsync',
  'drop',
  'dropAsync',
  'dropCommit',
  'dropCommitAsync',
  'applyFixup',
  'applyFixupAsync',
  'reword',
  'rewordAsync',
  'pull',
  'pullAsync',
  'push',
  'pushAsync',
];

const VIEW_CAPS = { read: true, changes: false, branches: false, review: true };

const SOURCE_CAPS = {
  local: { read: true, changes: true, branches: true, review: true },
  commit: VIEW_CAPS,
  pr: VIEW_CAPS,
  mr: VIEW_CAPS,
  issue: VIEW_CAPS,
  'gl-issue': VIEW_CAPS,
  readonly: VIEW_CAPS,
};

const withReadOnly = (caps, readOnly) => {
  if (!readOnly) return { ...caps };
  return { ...caps, changes: false, branches: false };
};

const capabilitiesFor = (kind, extra = {}) => {
  const base = SOURCE_CAPS[kind] ?? SOURCE_CAPS.local;
  return withReadOnly(base, extra.readOnly === true);
};

const copyMethods = (target, source, names) => {
  for (const name of names) {
    const method = source[name];
    if (typeof method === 'function') target[name] = method;
  }
};

const attachCapabilities = (impl, caps) => {
  const source = { capabilities: { ...caps } };
  if (caps.read) copyMethods(source, impl, READ_METHODS);
  if (caps.changes) copyMethods(source, impl, CHANGE_METHODS);
  if (caps.branches) copyMethods(source, impl, BRANCH_METHODS);
  return source;
};

const sessionCapabilities = (options) => {
  const readOnly = options.readOnly === true;
  if (options.capabilities) return withReadOnly(options.capabilities, readOnly);
  if (options.rev) return capabilitiesFor('commit', { readOnly });
  const source = options.change && options.change.source;
  if (SOURCE_CAPS[source]) return capabilitiesFor(source, { readOnly });
  const repoCaps = options.repo && options.repo.capabilities;
  if (repoCaps) return withReadOnly(repoCaps, readOnly);
  return capabilitiesFor('local', { readOnly });
};

module.exports = {
  SOURCE_CAPS,
  capabilitiesFor,
  attachCapabilities,
  sessionCapabilities,
};
