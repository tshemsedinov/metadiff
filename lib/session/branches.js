'use strict';

const accessors = require('./accessors.js');
const { stateView } = accessors;

const ops = require('./ops.js');
const { pickRepoWrite } = ops;

const selectedBranch = (api) => {
  const cursor = api.ui.nav.branchCursor;
  return api.state.branches[cursor];
};

const refreshBranchList = (api) => {
  const repo = api.ui.repo;
  if (!repo.listBranches) return;
  try {
    api.state.branches = repo.listBranches(api.ui.top);
  } catch (error) {
    api.ui.status = error.message;
    return;
  }
  const last = api.state.branches.length - 1;
  const nav = api.ui.nav;
  if (nav.branchCursor > last) nav.branchCursor = Math.max(0, last);
};

const refreshAfterWrite = (api, extra = {}) => {
  refreshBranchList(api);
  api.ui.commits.refresh();
  api.ui.refreshFromRepo({ keepEmpty: true, ...extra });
};

const onBranch = (api) => {
  if (api.ui.mode === 'compose') return;
  if (!api.ui.commits.canCommit()) return;
  const repo = api.ui.repo;
  const caps = api.ui.capabilities;
  if (!caps.branches || !repo.listBranches) {
    api.ui.status = 'read only';
    return;
  }
  try {
    api.state.branches = repo.listBranches(api.ui.top);
  } catch (error) {
    api.ui.status = error.message;
    return;
  }
  const current = api.state.branches.findIndex((entry) => entry.current);
  api.ui.nav.branchCursor = current < 0 ? 0 : current;
  api.ui.nav.pane = 'branches';
  api.ui.status = '';
  api.ui.nav.clearSelection();
};

const onBranchMove = (api, delta) => {
  const branches = api.state.branches;
  if (!branches.length) {
    api.ui.status = 'nothing to review';
    return;
  }
  const next = Math.min(
    branches.length - 1,
    Math.max(0, api.ui.nav.branchCursor + delta),
  );
  if (next === api.ui.nav.branchCursor) return;
  api.ui.nav.branchCursor = next;
  api.ui.status = '';
};

const checkoutAsync = (api, name, done, write) => {
  api.ui.showFiles();
  const run = (top) => write(top, name);
  const after = () =>
    api.ui.refreshFromRepo({ keepEmpty: true, doneStatus: done });
  return void api.ui.ops.runBusy('checking out', done, run, after);
};

const onCheckoutBranch = (api) => {
  if (!api.ui.commits.canCommit()) return;
  const entry = selectedBranch(api);
  if (!entry) return;
  if (entry.current) return void api.ui.showFiles();
  const name = entry.name;
  const done = `checked out ${name}`;
  const uiOpen = api.ui.uiOpen;
  const picked = pickRepoWrite(api.ui.repo, 'checkout', uiOpen);
  if (picked.async) {
    return void checkoutAsync(api, name, done, picked.write);
  }
  const ok = api.ui.ops.runRepo(done, (top) => {
    api.ui.repo.checkout(top, name);
  });
  if (!ok) return;
  api.ui.showFiles();
  api.ui.refreshFromRepo({ keepEmpty: true });
  if (!api.ui.status) api.ui.status = done;
};

const onRebaseBranch = (api) => {
  if (api.ui.nav.pane !== 'branches') return;
  if (!api.ui.commits.canCommit()) return;
  const entry = selectedBranch(api);
  if (!entry || entry.current) return;
  const onto = entry.name;
  const done = `rebased onto ${onto}`;
  api.ui.ops.runWrite('rebase', [onto], 'rebasing', done, (extra) =>
    refreshAfterWrite(api, extra),
  );
};

const onDropBranch = (api) => {
  if (api.ui.nav.pane !== 'branches') return;
  if (!api.ui.commits.canCommit()) return;
  const entry = selectedBranch(api);
  if (!entry || entry.current) return;
  api.state.dropName = entry.name;
  api.ui.mode = 'confirmDrop';
  api.ui.status = '';
};

const cancelDropBranch = (api) => {
  api.ui.mode = 'review';
  api.state.dropName = '';
  api.ui.status = '';
};

const confirmDropBranch = (api) => {
  const name = api.state.dropName;
  api.ui.mode = 'review';
  api.state.dropName = '';
  if (!name) return;
  const done = `dropped ${name}`;
  api.ui.ops.runWrite('drop', [name], 'dropping', done, (extra) =>
    refreshAfterWrite(api, extra),
  );
};

const onNewBranch = (api) => {
  if (api.ui.nav.pane !== 'branches') return;
  if (!api.ui.commits.canCommit()) return;
  api.ui.composer.openCompose('branch', '');
};

const createAsync = (api, name, done, write) => {
  api.ui.composer.closeCompose();
  api.ui.showFiles();
  const run = (top) => write(top, name);
  const after = () => refreshAfterWrite(api, { doneStatus: done });
  return void api.ui.ops.runBusy('creating branch', done, run, after);
};

const finishCreateBranch = (api) => {
  const editor = api.ui.composer.state.editor;
  const name = editor ? editor.text.trim() : '';
  if (!name) {
    api.ui.status = 'empty branch name';
    return;
  }
  const done = `created ${name}`;
  const uiOpen = api.ui.uiOpen;
  const picked = pickRepoWrite(api.ui.repo, 'createBranch', uiOpen);
  if (picked.async) {
    return void createAsync(api, name, done, picked.write);
  }
  const ok = api.ui.ops.runRepo(done, (top) => {
    api.ui.repo.createBranch(top, name);
  });
  if (!ok) return;
  api.ui.composer.closeCompose();
  api.ui.showFiles();
  refreshAfterWrite(api);
  if (!api.ui.status) api.ui.status = done;
};

const onPull = (api) => {
  if (!api.ui.commits.canCommit()) return;
  api.ui.ops.runWrite('pull', [], 'pulling', 'pulled', (extra) =>
    refreshAfterWrite(api, extra),
  );
};

const startPush = (api, force) => {
  if (!api.ui.commits.canCommit()) return;
  const done = force ? 'force pushed' : 'pushed';
  const kind = force ? 'force pushing' : 'pushing';
  const repo = api.ui.repo;
  const picked = pickRepoWrite(repo, 'push', api.ui.uiOpen);
  if (picked.async) {
    const write = (top) => picked.write(top, force);
    const after = () => refreshAfterWrite(api);
    return void api.ui.ops.runBusy(kind, done, write, after);
  }
  try {
    repo.push(api.ui.top, force);
  } catch (error) {
    if (error.rejected && !force) {
      api.ui.mode = 'confirmPush';
      api.ui.status = '';
      return;
    }
    api.ui.status = error.message;
    return;
  }
  refreshAfterWrite(api);
  api.ui.status = done;
};

const onPush = (api) => startPush(api, false);

const onForcePush = (api) => {
  api.ui.mode = 'review';
  startPush(api, true);
};

const cancelPush = (api) => {
  api.ui.mode = 'review';
  api.ui.status = '';
};

const reset = (state) => {
  state.branches = [];
  state.dropName = '';
};

const createBranchController = (ui) => {
  const state = {
    branches: [],
    dropName: '',
  };
  const api = { ui, state };
  return stateView(
    state,
    {
      reset: () => reset(state),
      onBranch: () => onBranch(api),
      onBranchMove: (delta) => onBranchMove(api, delta),
      onCheckoutBranch: () => onCheckoutBranch(api),
      onRebaseBranch: () => onRebaseBranch(api),
      onDropBranch: () => onDropBranch(api),
      cancelDropBranch: () => cancelDropBranch(api),
      confirmDropBranch: () => confirmDropBranch(api),
      onNewBranch: () => onNewBranch(api),
      finishCreateBranch: () => finishCreateBranch(api),
      onPull: () => onPull(api),
      onPush: () => onPush(api),
      onForcePush: () => onForcePush(api),
      cancelPush: () => cancelPush(api),
    },
    ['branches', 'dropName'],
  );
};

module.exports = { createBranchController };
