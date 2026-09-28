'use strict';

const update = require('../update.js');
const { checkUpdate, installUpdate, markSkipped } = update;

class UpdateCoordinator {
  constructor(ui) {
    this.ui = ui;
    this.reset();
  }

  get opts() {
    const value = this.ui.updateOpts;
    if (!value || value === true) return {};
    return value;
  }

  reset() {
    this.offer = false;
    this.from = '';
    this.to = '';
    this.checkPromise = null;
    this.installPromise = null;
  }

  maybePrompt() {
    const { ui } = this;
    if (!this.offer || !ui.loader.didLoad) return;
    if (ui.mode === 'review') ui.mode = 'confirmUpdate';
  }

  async install(version) {
    const { ui } = this;
    ui.status = 'updating reslop';
    ui.progressFrame = 0;
    ui.progress.start('install');
    ui.paint();
    let ok = false;
    try {
      await installUpdate(version, this.opts);
      ok = true;
    } catch {
      // ignore install errors
    }
    ui.progress.stop('install');
    if (ui.done || !ui.uiOpen) return;
    ui.status = ok ? 'updated' : 'update failed';
    ui.paint();
  }

  accept() {
    this.ui.mode = 'review';
    this.offer = false;
    this.installPromise = this.install(this.to);
  }

  decline() {
    this.ui.mode = 'review';
    this.offer = false;
    this.ui.status = '';
    markSkipped(this.to, this.opts);
  }

  async check() {
    let plan;
    try {
      plan = await checkUpdate(this.opts);
    } catch {
      return;
    }
    if (this.ui.done) return;
    if (plan.action === 'install') {
      this.installPromise = this.install(plan.latest);
      await this.installPromise;
      return;
    }
    if (plan.action !== 'confirm') return;
    this.from = plan.current;
    this.to = plan.latest;
    this.offer = true;
    this.maybePrompt();
    this.ui.paint();
  }

  open() {
    if (this.ui.updateOpts === false) return Promise.resolve();
    if (!this.checkPromise) this.checkPromise = this.check();
    return this.checkPromise;
  }
}

module.exports = { UpdateCoordinator };
