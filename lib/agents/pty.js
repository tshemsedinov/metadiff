'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { spawnBase } = require('../common/process.js');
const { resource } = require('../common/utilities.js');
const { Screen } = require('../term/screen.js');
const { sawWork } = require('./approvals.js');
const { RunProcess } = require('../runs/process.js');

const COLS = 80;
const ROWS = 24;

const HELPER = resource(__dirname, 'pty-helper.py');

const findPython = (env) => {
  const dirs = `${env.PATH ?? ''}`.split(path.delimiter).filter(Boolean);
  for (const name of ['python3', 'python']) {
    for (const dir of dirs) {
      const full = path.join(dir, name);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch {
        // try the next directory
      }
    }
  }
  return '';
};

class PtyProcess extends RunProcess {
  constructor(onData, onClose) {
    super(onData, onClose);
    this.screen = new Screen(COLS, ROWS);
    this.control = null;
    this.didWork = false;
  }

  start(python, cwd, launch, env) {
    const options = spawnBase({
      cwd,
      env: { ...env, RESLOP_ROWS: String(ROWS), RESLOP_COLS: String(COLS) },
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    const args = ['-c', HELPER, launch.cmd, ...launch.args];
    try {
      this.child = spawn(python, args, options);
    } catch {
      return false;
    }
    const { child } = this;
    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => this.take(chunk));
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        if (chunk.trim()) this.append(chunk);
      });
    }
    if (child.stdin) child.stdin.on('error', () => {});
    this.control = child.stdio[3];
    if (this.control) this.control.on('error', () => {});
    child.on('error', (error) => {
      if (!this.stopped) this.append(error.message);
      this.finish(1);
    });
    child.on('close', (status) => this.finish(status));
    return true;
  }

  take(chunk) {
    if (this.closed) return;
    if (sawWork(chunk)) this.didWork = true;
    this.screen.write(chunk);
    const next = this.screen.plain();
    if (next !== this.text) this.show(next);
  }

  append(text) {
    this.show(this.text ? `${this.text}\n${text}` : text);
  }

  write(data) {
    const { stdin } = this.child;
    if (!stdin || !stdin.writable || this.settled) return;
    stdin.write(data);
  }

  resize(cols, rows) {
    const width = Math.max(20, cols | 0);
    const height = Math.max(8, rows | 0);
    this.screen.resize(width, height);
    const { control } = this;
    if (!control || !control.writable || this.settled) return;
    control.write(`R ${height} ${width}\n`);
  }

  raw() {
    return this.screen.styled();
  }

  worked() {
    return this.didWork;
  }
}

const startPty = (cwd, launch, onData, onClose, env) => {
  const python = findPython(env);
  if (!python) return null;
  const proc = new PtyProcess(onData, onClose);
  return proc.start(python, cwd, launch, env) ? proc : null;
};

module.exports = { startPty };
