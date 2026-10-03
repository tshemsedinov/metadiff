'use strict';

const blocks = require('../render/dash-blocks.js');
const { npmStatus } = blocks;
const utilities = require('../utilities.js');
const { IS_WIN, npmBin, oneLine, runProc } = utilities;

const INSTALL_MS = 120000;

class PackageController {
  constructor(ui) {
    this.ui = ui;
    this.dropName = '';
    this.addDev = false;
    this.running = false;
    this.job = null;
  }

  summary() {
    return npmStatus(this.ui.dashboard.packagesView());
  }

  rows() {
    const data = this.ui.dashboard.packagesView();
    const modules = data.modules;
    return modules && modules.packages ? modules.packages : [];
  }

  selected() {
    return this.rows()[this.ui.nav.packagesCursor] ?? null;
  }

  canWrite() {
    if (this.running) return false;
    const ui = this.ui;
    const caps = ui.capabilities;
    if (!ui.readOnly && (!caps || caps.changes !== false)) return true;
    ui.status = 'read only';
    return false;
  }

  need() {
    if (!this.canWrite()) return null;
    const pkg = this.selected();
    if (pkg) return pkg;
    this.ui.status = 'not a package';
    return null;
  }

  create() {
    if (!this.canWrite()) return;
    const pkg = this.selected();
    if (pkg && pkg.transitive) {
      this.ui.status = 'transitive';
      return;
    }
    this.addDev = Boolean(pkg && pkg.dev);
    this.ui.composer.openCompose('package', '');
  }

  finishAdd() {
    const editor = this.ui.composer.editor;
    if (!editor) return;
    const name = editor.text.trim();
    if (!name || /\s/.test(name) || name.startsWith('-')) {
      this.ui.status = 'name';
      return;
    }
    const args = ['install', name];
    if (this.addDev) args.push('--save-dev');
    this.ui.composer.closeCompose();
    this.job = this.exec(args, 'npm i', `installed ${name}`);
  }

  askDrop() {
    const pkg = this.need();
    if (!pkg) return;
    if (pkg.transitive) {
      this.ui.status = 'transitive';
      return;
    }
    this.dropName = pkg.name;
    this.ui.mode = 'confirmDrop';
    this.ui.status = '';
  }

  cancelDrop() {
    this.dropName = '';
    this.ui.mode = 'review';
    this.ui.status = '';
  }

  confirmDrop() {
    const name = this.dropName;
    this.dropName = '';
    this.ui.mode = 'review';
    if (!name) return;
    const done = `dropped ${name}`;
    this.job = this.exec(['uninstall', name], 'npm uninstall', done);
  }

  updateWanted() {
    const pkg = this.need();
    if (!pkg) return;
    const done = `updated ${pkg.name}`;
    this.job = this.exec(['update', pkg.name], 'npm i', done);
  }

  updateLatest() {
    const pkg = this.need();
    if (!pkg) return;
    const args = ['install', `${pkg.name}@latest`];
    if (pkg.dev) args.push('--save-dev');
    this.job = this.exec(args, 'npm i', `updated ${pkg.name}`);
  }

  async exec(args, busy, done) {
    const ui = this.ui;
    this.running = true;
    ui.status = '';
    ui.ops.setBusy(busy);
    ui.ignoreWatch(INSTALL_MS);
    ui.paint();
    let result;
    try {
      const hook = ui.repo && ui.repo.runPackage;
      const options = { cwd: ui.top, shell: IS_WIN };
      result = hook
        ? await hook(ui.top, args)
        : await runProc(npmBin(), args, options);
    } catch (error) {
      result = { error, status: 1, stderr: '' };
    }
    this.running = false;
    ui.ops.clearBusy();
    const failed = !result || result.error || result.status;
    if (failed) {
      const message = result && result.error ? result.error.message : '';
      const stderr = result ? result.stderr : '';
      ui.status = oneLine(stderr, message || 'npm failed');
    } else {
      ui.status = done;
      ui.dashboard.tasks.npm.request();
    }
    ui.paint();
  }
}

module.exports = { PackageController };
