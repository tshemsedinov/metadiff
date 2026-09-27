'use strict';

const capabilities = require('./capabilities.js');
const { capabilitiesFor, attachCapabilities } = capabilities;
const worktree = require('./git-worktree.js');
const { readSnapshot, readSnapshotAsync, toplevel, resolveRev } = worktree;
const { listScopeFiles, fileText, editItem, writeFile, stagePath } = worktree;
const { addItem, unstageItem, revertItem, currentBranch } = worktree;
const branches = require('./git-branches.js');
const gitDeps = require('./git-deps.js');

const load = (cwd, paths = [], options = {}) => {
  const snapshot = readSnapshot(cwd, paths, options);
  return gitDeps.finishLoad(snapshot, { ...options, paths });
};

const loadAsync = async (cwd, paths = [], options = {}) => {
  const snapshot = await readSnapshotAsync(cwd, paths, options);
  return gitDeps.finishLoad(snapshot, {
    ...options,
    paths,
    deferExtras: options.deferExtras ?? true,
  });
};

const addGitItem = (top, item) => {
  if (item.dep) return gitDeps.addItem(top, item);
  return addItem(top, item);
};

const addGitItemAsync = async (top, item) => {
  if (item.dep) return gitDeps.addItemAsync(top, item);
  return addItem(top, item);
};

const unstageGitItem = (top, item) => {
  if (item.dep) return gitDeps.unstageItem(top, item);
  return unstageItem(top, item);
};

const revertGitItem = (top, item) => {
  if (item.origin === 'commit') return;
  if (item.dep) {
    return void gitDeps.revertDepItem(top, item);
  }
  revertItem(top, item);
};

const createGitRepo = () =>
  attachCapabilities(
    {
      load,
      loadAsync,
      loadExtras: gitDeps.loadExtras,
      toplevel,
      resolveRev,
      listFiles: listScopeFiles,
      fileText,
      add: addGitItem,
      addAsync: addGitItemAsync,
      unstage: unstageGitItem,
      revert: revertGitItem,
      revertFile: gitDeps.revertFile,
      edit: editItem,
      writeFile,
      stagePath,
      commit: branches.commitChanges,
      commitAsync: branches.commitChangesAsync,
      hasStaged: branches.hasStaged,
      lastMessage: branches.lastMessage,
      commitMessage: branches.commitMessage,
      listBranches: branches.listBranches,
      listCommits: branches.listCommits,
      currentBranch,
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
    },
    capabilitiesFor('local'),
  );

module.exports = {
  ...worktree,
  ...branches,
  load,
  loadAsync,
  loadExtras: gitDeps.loadExtras,
  addItem: addGitItem,
  unstageItem: unstageGitItem,
  revertItem: revertGitItem,
  createGitRepo,
};
