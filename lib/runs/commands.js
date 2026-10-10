'use strict';

const { spawn } = require('node:child_process');
const utilities = require('../common/utilities.js');
const { npmBin, npmOpts, spawnBase } = utilities;
const scriptsPart = require('./scripts.js');
const { listCommands, saveScript, removeScript, reorderScript } = scriptsPart;
const outputPart = require('./output.js');
const { reduceOutput, isPassingTest, traceLine, relativize } = outputPart;
const { TABLE_KEY, TABLE_VAL, formatTable } = outputPart;
const logsPart = require('./logs.js');
const { logFileName, logText, nextLogFile, saveLogs } = logsPart;
const { readSavedRuns, readLogPair, staleLogFiles, removeStaleLogs } = logsPart;

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

const startNpm = (cwd, entry, onData, onClose) => {
  let raw = '';
  let settled = false;
  let stopped = false;
  const finish = (status) => {
    if (settled) return;
    settled = true;
    onClose({ status, text: raw });
  };
  const isBin = entry.kind === 'bin';
  const args = isBin ? ['exec', '--', entry.name] : ['run', entry.name];
  let child;
  try {
    const opts = npmOpts({
      cwd,
      env: commandEnv(),
      detached: process.platform !== 'win32',
    });
    child = spawn(npmBin(), args, opts);
  } catch (error) {
    raw = `${error.message}\n`;
    finish(1);
    return { kill() {} };
  }
  const push = (chunk) => {
    if (stopped || settled) return;
    raw += chunk;
    onData(raw);
  };
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    stream.setEncoding('utf8');
    stream.on('data', push);
  }
  child.on('error', (error) => {
    if (!stopped) raw += `${error.message}\n`;
    finish(1);
  });
  child.on('close', (status) => finish(status));
  return {
    kill() {
      if (stopped || settled) return;
      stopped = true;
      killTree(child);
    },
  };
};

module.exports = {
  listCommands,
  reduceOutput,
  logFileName,
  logText,
  nextLogFile,
  saveLogs,
  readSavedRuns,
  readLogPair,
  staleLogFiles,
  removeStaleLogs,
  saveScript,
  removeScript,
  reorderScript,
  startNpm,
  commandEnv,
  killTree,
  isPassingTest,
  traceLine,
  relativize,
  TABLE_KEY,
  TABLE_VAL,
  formatTable,
};
