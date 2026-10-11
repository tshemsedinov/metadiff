'use strict';

const { clamp } = require('../common/utilities.js');
const { pickRepoWrite } = require('./ops.js');

class BranchController {
  constructor(ui) {
    this.ui = ui;
    this.reset();
  }

  reset() {
    this.branches = [];
    this.dropName = '';
  }

  selected() {
    return this.branches[this.ui.nav.branchCursor];
  }

  canWrite() {
    return this.ui.nav.pane === 'branches' && this.ui.commits.canCommit();
  }

  loadBranches() {
    const ui = this.ui;
    try {
      this.branches = ui.repo.listBranches(ui.top);
      return true;
    } catch (error) {
      ui.status = error.message;
      return false;
    }
  }

  refreshAfterWrite(extra = {}) {
    if (this.ui.repo.listBranches && this.loadBranches()) {
      const last = this.branches.length - 1;
      const nav = this.ui.nav;
      if (nav.branchCursor > last) nav.branchCursor = Math.max(0, last);
    }
    this.ui.commits.refresh();
    this.ui.refreshFromRepo({ keepEmpty: true, ...extra });
  }

  runWrite(name, args, kind, done) {
    const after = (extra) => this.refreshAfterWrite(extra);
    this.ui.ops.runWrite(name, args, kind, done, after);
  }

  onBranch() {
    const ui = this.ui;
    if (ui.mode === 'compose') return;
    if (!ui.commits.canCommit()) return;
    if (!ui.capabilities.branches || !ui.repo.listBranches) {
      ui.status = 'read only';
      return;
    }
    if (!this.loadBranches()) return;
    const current = this.branches.findIndex((entry) => entry.current);
    const nav = ui.nav;
    nav.branchCursor = current < 0 ? 0 : current;
    nav.pane = 'branches';
    nav.resetListScroll('branches');
    ui.status = '';
    nav.clearSelection();
  }

  onBranchMove(delta) {
    const nav = this.ui.nav;
    if (!this.branches.length) {
      this.ui.status = 'nothing to review';
      return;
    }
    const last = this.branches.length - 1;
    const next = clamp(nav.branchCursor + delta, 0, last);
    if (next === nav.branchCursor) return;
    nav.branchCursor = next;
    this.ui.status = '';
  }

  onCheckoutBranch() {
    const ui = this.ui;
    if (!ui.commits.canCommit()) return;
    const entry = this.selected();
    if (!entry || entry.current) return;
    const name = entry.name;
    const after = (extra) => this.refreshAfterWrite(extra);
    const done = `checked out ${name}`;
    ui.ops.runWrite('checkout', [name], 'checking out', done, after);
  }

  finishCreateBranch() {
    const ui = this.ui;
    const editor = ui.composer.editor;
    const name = editor ? editor.text.trim() : '';
    if (!name) {
      ui.status = 'empty branch name';
      return;
    }
    const after = (extra) => this.refreshAfterWrite(extra);
    const leave = () => {
      ui.composer.closeCompose();
      ui.showFiles();
    };
    const done = `created ${name}`;
    ui.ops.runWrite(
      'createBranch',
      [name],
      'creating branch',
      done,
      after,
      leave,
    );
  }

  onRebaseBranch() {
    if (!this.canWrite()) return;
    const entry = this.selected();
    if (!entry || entry.current) return;
    const onto = entry.name;
    this.runWrite('rebase', [onto], 'rebasing', `rebased onto ${onto}`);
  }

  onDropBranch() {
    if (!this.canWrite()) return;
    const entry = this.selected();
    if (!entry || entry.current) return;
    this.dropName = entry.name;
    this.ui.mode = 'confirmDrop';
    this.ui.status = '';
  }

  cancelDropBranch() {
    this.ui.mode = 'review';
    this.dropName = '';
    this.ui.status = '';
  }

  confirmDropBranch() {
    const name = this.dropName;
    this.ui.mode = 'review';
    this.dropName = '';
    if (name) this.runWrite('drop', [name], 'dropping', `dropped ${name}`);
  }

  onNewBranch() {
    if (this.canWrite()) this.ui.composer.openCompose('branch', '');
  }

  onPull() {
    if (this.ui.commits.canCommit()) {
      this.runWrite('pull', [], 'pulling', 'pulled');
    }
  }

  startPush(force) {
    const ui = this.ui;
    if (!ui.commits.canCommit()) return;
    const done = force ? 'force pushed' : 'pushed';
    const kind = force ? 'force pushing' : 'pushing';
    const picked = pickRepoWrite(ui.repo, 'push', ui.uiOpen);
    if (picked.async) {
      const write = (top) => picked.write(top, force);
      const after = () => this.refreshAfterWrite();
      return void ui.ops.runBusy(kind, done, write, after);
    }
    try {
      ui.repo.push(ui.top, force);
    } catch (error) {
      if (error.rejected && !force) {
        ui.mode = 'confirmPush';
        ui.status = '';
        return;
      }
      ui.status = error.message;
      return;
    }
    this.refreshAfterWrite();
    ui.status = done;
  }

  onPush() {
    this.startPush(false);
  }

  onForcePush() {
    this.ui.mode = 'review';
    this.startPush(true);
  }

  cancelPush() {
    this.ui.mode = 'review';
    this.ui.status = '';
  }
}

module.exports = { BranchController };
