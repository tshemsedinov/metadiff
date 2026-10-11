'use strict';

const QUIET_KIND = new Set(['staged', 'unstaged']);

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
      this.runner.track(this.run());
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
    this.pending = new Set();
    this.queue = new ChangeQueue(ui, this);
  }

  track(promise) {
    const settled = () => this.pending.delete(promise);
    this.pending.add(promise);
    promise.then(settled, settled);
    return promise;
  }

  async idle() {
    await Promise.resolve();
    while (this.pending.size || this.queue.pumpQueued) {
      await Promise.allSettled([...this.pending]);
    }
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

  finishBusy(done, after) {
    const { ui } = this;
    if (ui.done || ui.mode === 'confirmPush') return void ui.paint();
    if (!ui.status && after) after();
    if (!ui.status && !this.busy) ui.status = done;
    ui.paint();
  }

  runBusy(kind, done, write, after) {
    return this.track(this.busyWrite(kind, done, write, after));
  }

  async busyWrite(kind, done, write, after) {
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

  runWrite(name, args, kind, done, after, leave = null) {
    const { ui } = this;
    const write = (top) => ui.repo[name](top, ...args);
    if (leave) leave();
    const refresh = () => after({ doneStatus: done });
    return this.runBusy(kind, done, write, refresh);
  }

  async apply(label, write, after) {
    const { ui } = this;
    try {
      await write(ui.top);
      ui.status = label;
      if (after) after();
      return true;
    } catch (error) {
      ui.status = error.message;
      return false;
    }
  }

  enqueueLazy(job) {
    this.queue.enqueue(job);
  }
}

module.exports = { OpsRunner };
