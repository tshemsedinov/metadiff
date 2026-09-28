'use strict';

const accessors = require('./accessors.js');
const { stateView } = accessors;

const ASYNC_WITHOUT_UI = ['pull', 'push'];
const QUIET_KIND = new Set(['staged', 'unstaged']);

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

const showsBusy = (kind) => Boolean(kind) && !QUIET_KIND.has(kind);

const noteFree = (ctx) => {
  const resume = ctx.resume;
  ctx.resume = null;
  if (resume) resume();
};

const dropJobs = (ctx) => {
  ctx.jobs = [];
  ctx.head = 0;
};

const resetQueue = (ctx) => {
  ctx.epoch += 1;
  dropJobs(ctx);
  ctx.draining = false;
  ctx.pumpQueued = false;
  ctx.holding = false;
  ctx.reloading = false;
  noteFree(ctx);
};

const armBusy = (ctx, kind) => {
  if (!showsBusy(kind)) return;
  ctx.ui.status = '';
  ctx.ui.progressFrame = 0;
  ctx.setBusy(kind);
};

const waitTurn = (ctx) => {
  if (!ctx.state.gitBusy || ctx.holding) return Promise.resolve();
  return new Promise((resolve) => {
    ctx.resume = resolve;
  });
};

const pendingBusy = (ctx) => {
  const { jobs, head } = ctx;
  for (let i = head; i < jobs.length; i++) {
    if (showsBusy(jobs[i].kind)) return true;
  }
  return false;
};

const releaseHold = (ctx) => {
  ctx.holding = false;
  ctx.state.gitBusy = false;
  noteFree(ctx);
};

const startReload = (ctx) => {
  const { ui } = ctx;
  if (typeof ui.reloadAfterChange !== 'function') return void ui.paint();
  ctx.reloading = true;
  ui.reloadAfterChange(() => {
    ctx.reloading = false;
    ui.paint();
  });
};

const takeJob = async (ctx, stamp) => {
  const job = ctx.jobs[ctx.head];
  ctx.head += 1;
  armBusy(ctx, job.kind);
  try {
    await job.write(ctx.ui.top);
  } catch (error) {
    if (stamp !== ctx.epoch) return 'stale';
    ctx.ui.status = error.message;
    return 'fail';
  }
  if (stamp !== ctx.epoch) return 'stale';
  if (job.done) ctx.ui.status = job.done;
  if (!pendingBusy(ctx)) ctx.clearBusy();
  return job.reload ? 'reload' : 'ok';
};

const schedule = (ctx) => {
  if (ctx.draining || ctx.pumpQueued) return;
  ctx.pumpQueued = true;
  queueMicrotask(() => {
    ctx.pumpQueued = false;
    void ctx.run();
  });
};

const finishPump = (ctx, stamp, needReload) => {
  if (stamp !== ctx.epoch) return;
  ctx.draining = false;
  releaseHold(ctx);
  if (ctx.head < ctx.jobs.length) return void schedule(ctx);
  dropJobs(ctx);
  if (needReload) startReload(ctx);
  else ctx.ui.paint();
};

const runQueue = async (ctx) => {
  const stamp = ctx.epoch;
  ctx.draining = true;
  if (ctx.state.gitBusy && !ctx.holding) await waitTurn(ctx);
  if (stamp !== ctx.epoch) return;
  ctx.holding = true;
  ctx.state.gitBusy = true;
  let needReload = false;
  while (ctx.head < ctx.jobs.length) {
    const result = await takeJob(ctx, stamp);
    if (result === 'stale') return;
    if (result === 'fail') {
      needReload = true;
      dropJobs(ctx);
      break;
    }
    if (result === 'reload') needReload = true;
  }
  finishPump(ctx, stamp, needReload);
};

const enqueue = (ctx, job) => {
  const { ui } = ctx;
  if (ctx.reloading && ui.loader && typeof ui.loader.bump === 'function') {
    ui.loader.bump();
    ctx.reloading = false;
    job.reload = true;
  }
  ctx.jobs.push(job);
  armBusy(ctx, job.kind);
  schedule(ctx);
};

const createChangeQueue = (ui, state, setBusy, clearBusy) => {
  const ctx = {
    ui,
    state,
    setBusy,
    clearBusy,
    jobs: [],
    head: 0,
    epoch: 0,
    draining: false,
    pumpQueued: false,
    holding: false,
    resume: null,
    reloading: false,
    run() {},
  };
  ctx.run = () => runQueue(ctx);
  return {
    reset: () => resetQueue(ctx),
    noteFree: () => noteFree(ctx),
    enqueueLazy: (job) => enqueue(ctx, job),
  };
};

const createOpsRunner = (ui) => {
  const state = {
    gitBusy: false,
    busy: '',
  };

  const setBusy = (kind) => {
    state.busy = kind;
    ui.startProgress();
  };

  const clearBusy = () => {
    state.busy = '';
    ui.stopProgress();
  };

  const queue = createChangeQueue(ui, state, setBusy, clearBusy);

  const reset = () => {
    state.gitBusy = false;
    state.busy = '';
    queue.reset();
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
      queue.noteFree();
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
      enqueueLazy: queue.enqueueLazy,
    },
    ['gitBusy', 'busy'],
  );
};

module.exports = { ASYNC_WITHOUT_UI, pickRepoWrite, createOpsRunner };
