'use strict';

const accessors = require('./accessors.js');
const { stateView } = accessors;

const ASYNC_WITHOUT_UI = ['pull', 'push'];

const pickRepoWrite = (repo, name, uiOpen) => {
  const asyncFn = repo[`${name}Async`];
  const allowAsync = uiOpen === true || ASYNC_WITHOUT_UI.includes(name);
  if (allowAsync && typeof asyncFn === 'function') {
    return {
      async: true,
      write: (top, ...args) => asyncFn(top, ...args),
    };
  }
  const syncFn = repo[name];
  return {
    async: false,
    write: (top, ...args) => syncFn(top, ...args),
  };
};

const createOpsRunner = (ui) => {
  const state = {
    gitBusy: false,
    busy: '',
  };

  const reset = () => {
    state.gitBusy = false;
    state.busy = '';
  };

  const setBusy = (kind) => {
    state.busy = kind;
    ui.startProgress();
  };

  const clearBusy = () => {
    state.busy = '';
    ui.stopProgress();
  };

  const runRepo = (label, write) => {
    try {
      write(ui.top);
      ui.status = label;
      return true;
    } catch (error) {
      ui.status = error.message;
      return false;
    }
  };

  const finishBusy = (done, after) => {
    if (ui.done || ui.mode === 'confirmPush') return void ui.paint();
    if (!ui.status && after) after();
    if (!ui.status && !state.busy) ui.status = done;
    ui.paint();
  };

  const runBusy = async (kind, done, write, after) => {
    if (state.gitBusy) return;
    state.gitBusy = true;
    ui.status = '';
    ui.progressFrame = 0;
    setBusy(kind);
    ui.paint();
    try {
      await write(ui.top);
    } catch (error) {
      if (error.rejected && kind !== 'force pushing') {
        ui.mode = 'confirmPush';
      } else {
        ui.status = error.message;
      }
    } finally {
      clearBusy();
      state.gitBusy = false;
    }
    finishBusy(done, after);
  };

  const runWrite = (name, args, kind, done, after) => {
    const picked = pickRepoWrite(ui.repo, name, ui.uiOpen);
    const write = (top) => picked.write(top, ...args);
    if (picked.async) {
      const refresh = () => after({ doneStatus: done });
      return void runBusy(kind, done, write, refresh);
    }
    if (!runRepo(done, write)) return;
    after({});
    if (!ui.status) ui.status = done;
  };

  return stateView(
    state,
    {
      reset,
      setBusy,
      clearBusy,
      runRepo,
      runWrite,
      runBusy,
    },
    ['gitBusy', 'busy'],
  );
};

module.exports = { ASYNC_WITHOUT_UI, pickRepoWrite, createOpsRunner };
