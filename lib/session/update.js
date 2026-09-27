'use strict';

const accessors = require('./accessors.js');
const { stateView } = accessors;

const update = require('../update.js');
const { checkUpdate, installUpdate, markSkipped } = update;

const optsOf = (api) => {
  const value = api.ui.updateOpts;
  if (!value || value === true) return {};
  return value;
};

const reset = (state) => {
  state.offer = false;
  state.from = '';
  state.to = '';
  state.checkPromise = null;
  state.installPromise = null;
};

const maybePrompt = (api) => {
  if (!api.state.offer) return;
  if (!api.ui.loader.didLoad) return;
  if (api.ui.mode !== 'review') return;
  api.ui.mode = 'confirmUpdate';
};

const runInstall = async (api, version) => {
  api.ui.status = 'updating reslop';
  api.ui.progressFrame = 0;
  api.ui.progress.start('install');
  api.ui.paint();
  let ok = false;
  try {
    await installUpdate(version, optsOf(api));
    ok = true;
  } catch {
    // ignore install errors
  }
  api.ui.progress.stop('install');
  if (api.ui.done || !api.ui.uiOpen) return;
  api.ui.status = ok ? 'updated' : 'update failed';
  api.ui.paint();
};

const acceptUpdate = (api) => {
  api.ui.mode = 'review';
  api.state.offer = false;
  const version = api.state.to;
  api.state.installPromise = runInstall(api, version);
};

const declineUpdate = (api) => {
  api.ui.mode = 'review';
  api.state.offer = false;
  api.ui.status = '';
  markSkipped(api.state.to, optsOf(api));
};

const runOpenUpdate = async (api) => {
  let plan;
  try {
    plan = await checkUpdate(optsOf(api));
  } catch {
    return;
  }
  if (api.ui.done) return;
  if (plan.action === 'install') {
    api.state.installPromise = runInstall(api, plan.latest);
    await api.state.installPromise;
    return;
  }
  if (plan.action !== 'confirm') return;
  api.state.from = plan.current;
  api.state.to = plan.latest;
  api.state.offer = true;
  maybePrompt(api);
  api.ui.paint();
};

const openUpdate = (api) => {
  if (api.ui.updateOpts === false) return Promise.resolve();
  if (api.state.checkPromise) return api.state.checkPromise;
  api.state.checkPromise = runOpenUpdate(api);
  return api.state.checkPromise;
};

const createUpdateCoordinator = (ui) => {
  const state = {
    offer: false,
    from: '',
    to: '',
    checkPromise: null,
    installPromise: null,
  };
  const api = { ui, state };
  return stateView(
    state,
    {
      reset: () => reset(state),
      maybePrompt: () => maybePrompt(api),
      accept: () => acceptUpdate(api),
      decline: () => declineUpdate(api),
      open: () => openUpdate(api),
    },
    ['offer', 'installPromise'],
    ['from', 'to', 'checkPromise'],
  );
};

module.exports = { createUpdateCoordinator };
