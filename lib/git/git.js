'use strict';

const {
  capabilitiesFor,
  attachCapabilities,
} = require('../source/capabilities.js');
const worktree = require('./worktree.js');
const branches = require('./branches.js');
const gitDeps = require('./deps.js');

const load = (cwd, paths = [], options = {}) => {
  const snapshot = worktree.readSnapshot(cwd, paths, options);
  return gitDeps.finishLoad(snapshot, { ...options, paths });
};

const loadAsync = async (cwd, paths = [], options = {}) => {
  const snapshot = await worktree.readSnapshotAsync(cwd, paths, options);
  const deferExtras = options.deferExtras ?? true;
  return gitDeps.finishLoad(snapshot, { ...options, paths, deferExtras });
};

const REPO_METHODS = {
  load,
  loadAsync,
  loadExtras: gitDeps.loadExtras,
  toplevel: worktree.toplevel,
  resolveRev: worktree.resolveRev,
  listFiles: worktree.listScopeFiles,
  fileText: worktree.fileText,
  add: gitDeps.addItem,
  addAsync: gitDeps.addItemAsync,
  unstage: gitDeps.unstageItem,
  revert: gitDeps.revertItem,
  revertFile: gitDeps.revertFile,
  edit: worktree.editItem,
  writeFile: worktree.writeFile,
  stagePath: worktree.stagePath,
  commit: branches.commitChanges,
  commitAsync: branches.commitChangesAsync,
  updateCommit: branches.updateCommit,
  updateCommitAsync: branches.updateCommitAsync,
  hasStaged: branches.hasStaged,
  lastMessage: branches.lastMessage,
  commitMessage: branches.commitMessage,
  listBranches: branches.listBranches,
  listCommits: branches.listCommits,
  currentBranch: worktree.currentBranch,
  checkout: branches.checkoutBranch,
  checkoutAsync: branches.checkoutBranchAsync,
  createBranch: branches.createBranch,
  createBranchAsync: branches.createBranchAsync,
  rebase: branches.rebaseBranch,
  rebaseAsync: branches.rebaseBranchAsync,
  drop: branches.dropBranch,
  dropAsync: branches.dropBranchAsync,
  dropCommit: branches.dropCommit,
  dropCommitAsync: branches.dropCommitAsync,
  applyFixup: branches.applyFixup,
  applyFixupAsync: branches.applyFixupAsync,
  reword: branches.rewordCommit,
  rewordAsync: branches.rewordCommitAsync,
  pull: branches.pullChanges,
  pullAsync: branches.pullChangesAsync,
  push: branches.pushChanges,
  pushAsync: branches.pushChangesAsync,
};

const createGitRepo = () =>
  attachCapabilities(REPO_METHODS, capabilitiesFor('local'));

const listed = createGitRepo();
const unlisted = Object.keys(REPO_METHODS).filter(
  (name) => !Object.hasOwn(listed, name),
);
if (unlisted.length) {
  throw new Error(`git methods without a capability: ${unlisted.join(', ')}`);
}

module.exports = {
  ...branches,
  currentBranch: worktree.currentBranch,
  editItem: worktree.editItem,
  load,
  loadAsync,
  loadExtras: gitDeps.loadExtras,
  addItem: gitDeps.addItem,
  unstageItem: gitDeps.unstageItem,
  revertItem: gitDeps.revertItem,
  createGitRepo,
};
