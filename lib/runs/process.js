'use strict';

const { spawn } = require('node:child_process');
const { spawnBase } = require('../common/process.js');

const signalPid = (pid, signal) => {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
};

const killTree = (proc) => {
  const pid = proc.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    const killer = spawn(
      'taskkill',
      ['/pid', String(pid), '/t', '/f'],
      spawnBase({ stdio: 'ignore' }),
    );
    killer.on('error', () => proc.kill());
    return;
  }
  const group = -pid;
  if (!signalPid(group, 'SIGTERM')) signalPid(pid, 'SIGTERM');
  const timer = setTimeout(() => {
    if (!signalPid(group, 'SIGKILL')) signalPid(pid, 'SIGKILL');
  }, 200);
  timer.unref();
  proc.once('close', () => clearTimeout(timer));
};

const commandEnv = (base = process.env) => {
  const env = { ...base };
  if (!env.NO_COLOR && !env.FORCE_COLOR) env.FORCE_COLOR = '1';
  if (!env.TERM) env.TERM = 'xterm-256color';
  env.RESLOP_OUTPUT = 'raw';
  return env;
};

class RunProcess {
  constructor(onData, onClose) {
    this.onData = onData;
    this.onClose = onClose;
    this.child = null;
    this.text = '';
    this.settled = false;
    this.stopped = false;
  }

  get closed() {
    return this.stopped || this.settled;
  }

  show(text) {
    this.text = text;
    this.onData(text);
  }

  finish(status) {
    if (this.settled) return;
    this.settled = true;
    this.onClose({ status, text: this.text });
  }

  kill() {
    if (this.closed) return;
    this.stopped = true;
    killTree(this.child);
  }

  raw() {
    return this.text;
  }
}

class PipeProcess extends RunProcess {
  start(cmd, args, options) {
    try {
      this.child = spawn(cmd, args, options);
    } catch (error) {
      this.text = `${error.message}\n`;
      this.finish(1);
      return this;
    }
    const { child } = this;
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => this.push(chunk));
    }
    child.on('error', (error) => {
      if (!this.stopped) this.text += `${error.message}\n`;
      this.finish(1);
    });
    child.on('close', (status) => this.finish(status));
    return this;
  }

  push(chunk) {
    if (!this.closed) this.show(this.text + chunk);
  }

  closeInput() {
    const stdin = this.child && this.child.stdin;
    if (stdin) stdin.on('error', () => {}).end();
  }
}

module.exports = { commandEnv, RunProcess, PipeProcess };
