'use strict';

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

class ChangeQueue {
  constructor(ui, runner) {
    this.ui = ui;
    this.runner = runner;
    this.jobs = [];
    this.head = 0;
    this.epoch = 0;
    this.draining = false;
    this.pumpQueued = false;
    this.holding = false;
    this.resume = null;
    this.reloading = false;
  }

  noteFree() {
    const resume = this.resume;
    this.resume = null;
    if (resume) resume();
  }

  dropJobs() {
    this.jobs = [];
    this.head = 0;
  }

  reset() {
    this.epoch += 1;
    this.dropJobs();
    this.draining = false;
    this.pumpQueued = false;
    this.holding = false;
    this.reloading = false;
    this.noteFree();
  }

  armBusy(kind) {
    if (!showsBusy(kind)) return;
    this.ui.status = '';
    this.ui.progressFrame = 0;
    this.runner.setBusy(kind);
  }

  waitTurn() {
    if (!this.runner.gitBusy || this.holding) return Promise.resolve();
    return new Promise((resolve) => {
      this.resume = resolve;
    });
  }

  hasPendingBusy() {
    const { jobs, head } = this;
    for (let i = head; i < jobs.length; i++) {
      if (showsBusy(jobs[i].kind)) return true;
    }
    return false;
  }

  releaseHold() {
    this.holding = false;
    this.runner.gitBusy = false;
    this.noteFree();
  }

  startReload() {
    const { ui } = this;
    if (typeof ui.reloadAfterChange !== 'function') return void ui.paint();
    this.reloading = true;
    ui.reloadAfterChange(() => {
      this.reloading = false;
      ui.paint();
    });
  }

  async takeJob(stamp) {
    const job = this.jobs[this.head];
    this.head += 1;
    this.armBusy(job.kind);
    try {
      await job.write(this.ui.top);
    } catch (error) {
      if (stamp !== this.epoch) return 'stale';
      this.ui.status = error.message;
      return 'fail';
    }
    if (stamp !== this.epoch) return 'stale';
    if (job.done) this.ui.status = job.done;
    if (!this.hasPendingBusy()) this.runner.clearBusy();
    return job.reload ? 'reload' : 'ok';
  }

  schedule() {
    if (this.draining || this.pumpQueued) return;
    this.pumpQueued = true;
    queueMicrotask(() => {
      this.pumpQueued = false;
      void this.run();
    });
  }

  finish(stamp, needReload) {
    if (stamp !== this.epoch) return;
    this.draining = false;
    this.releaseHold();
    if (this.head < this.jobs.length) return void this.schedule();
    this.dropJobs();
    if (needReload) this.startReload();
    else this.ui.paint();
  }

  async run() {
    const stamp = this.epoch;
    this.draining = true;
    if (this.runner.gitBusy && !this.holding) await this.waitTurn();
    if (stamp !== this.epoch) return;
    this.holding = true;
    this.runner.gitBusy = true;
    let needReload = false;
    while (this.head < this.jobs.length) {
      const result = await this.takeJob(stamp);
      if (result === 'stale') return;
      if (result === 'fail') {
        needReload = true;
        this.dropJobs();
        break;
      }
      if (result === 'reload') needReload = true;
    }
    this.finish(stamp, needReload);
  }

  enqueue(job) {
    if (this.reloading) {
      this.ui.loader.bump();
      this.reloading = false;
      job.reload = true;
    }
    this.jobs.push(job);
    this.armBusy(job.kind);
    this.schedule();
  }
}

class OpsRunner {
  constructor(ui) {
    this.ui = ui;
    this.gitBusy = false;
    this.busy = '';
    this.queue = new ChangeQueue(ui, this);
  }

  setBusy(kind) {
    this.busy = kind;
    this.ui.startProgress();
  }

  clearBusy() {
    this.busy = '';
    this.ui.stopProgress();
  }

  reset() {
    this.gitBusy = false;
    this.busy = '';
    this.queue.reset();
  }

  runRepo(label, write) {
    const { ui } = this;
    try {
      write(ui.top);
      ui.status = label;
      return true;
    } catch (error) {
      ui.status = error.message;
      return false;
    }
  }

  finishBusy(done, after) {
    const { ui } = this;
    if (ui.done || ui.mode === 'confirmPush') return void ui.paint();
    if (!ui.status && after) after();
    if (!ui.status && !this.busy) ui.status = done;
    ui.paint();
  }

  async runBusy(kind, done, write, after) {
    const { ui } = this;
    if (this.gitBusy) return;
    this.gitBusy = true;
    ui.status = '';
    ui.progressFrame = 0;
    this.setBusy(kind);
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
      this.clearBusy();
      this.gitBusy = false;
      this.queue.noteFree();
    }
    this.finishBusy(done, after);
  }

  runWrite(name, args, kind, done, after) {
    const { ui } = this;
    const picked = pickRepoWrite(ui.repo, name, ui.uiOpen);
    const write = (top) => picked.write(top, ...args);
    if (picked.async) {
      const refresh = () => after({ doneStatus: done });
      return void this.runBusy(kind, done, write, refresh);
    }
    if (!this.runRepo(done, write)) return;
    after({});
    if (!ui.status) ui.status = done;
  }

  enqueueLazy(job) {
    this.queue.enqueue(job);
  }
}

module.exports = { pickRepoWrite, OpsRunner };
