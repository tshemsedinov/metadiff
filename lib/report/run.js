'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

const { spawnBase } = require('../common/process.js');
const { withNewline } = require('../common/utilities.js');
const { nextLogFile, saveLogs } = require('../runs/logs.js');
const { toolHint, buildDocument } = require('./parse.js');
const { renderDocument } = require('./render.js');
const {
  RunRecorder,
  commandLabel,
  summarizeDocument,
} = require('../runs/runs.js');

const OUTPUTS = ['md', 'raw'];
const PIPE = ['ignore', 'pipe', 'pipe'];
const CMD_SAFE = /^[\w./:=@+-]+$/;

const quoteCmdArg = (arg) => {
  const text = `${arg}`;
  if (text && CMD_SAFE.test(text)) return text;
  const escaped = text.replaceAll('"', '""').replaceAll('%', '"%"');
  return `"${escaped}"`;
};

const winCommand = (program, args) => {
  const parts = [program, ...args].map(quoteCmdArg);
  return `"${parts.join(' ')}"`;
};

const spawnCommand = (command, options) => {
  const { program, args } = command;
  if (process.platform !== 'win32') {
    return spawn(program, args, spawnBase(options));
  }
  const shell = process.env.comspec || 'cmd.exe';
  const line = winCommand(program, args);
  const opts = spawnBase({ ...options, windowsVerbatimArguments: true });
  return spawn(shell, ['/d', '/s', '/c', line], opts);
};

const collect = (child, onOut, onErr) =>
  new Promise((resolve) => {
    let out = '';
    let err = '';
    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      resolve({ status, stdout: out, stderr: err });
    };
    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        out += chunk;
        if (onOut) onOut(chunk);
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        err += chunk;
        if (onErr) onErr(chunk);
      });
    }
    child.on('error', (error) => {
      err += `${error.message}\n`;
      finish(1);
    });
    child.on('close', (status) => finish(status ?? 1));
  });

const beginRun = (cwd, command) => {
  let slot = null;
  try {
    slot = nextLogFile(cwd, path.basename(command.program));
  } catch {
    // ignore errors
  }
  const label = commandLabel(command.program, command.args);
  return new RunRecorder(cwd, label, { slot });
};

const documentOf = (command, result, cwd) => {
  const hint = toolHint(command.program, command.args);
  const { stdout, stderr, status } = result;
  return buildDocument(stdout, stderr, cwd, status, hint);
};

const rawStreams = (stdout, stderr) => {
  if (!stderr.trim()) return stdout;
  const lead = withNewline(stdout);
  return `${lead}# stderr\n${stderr}`;
};

const runInherit = async (command, cwd, env) => {
  try {
    const child = spawnCommand(command, { cwd, env, stdio: 'inherit' });
    return (await collect(child)).status;
  } catch {
    return 1;
  }
};

const runRaw = async (proc, command, cwd, env) => {
  const recorder = beginRun(cwd, command);
  const onOut = (chunk) => {
    proc.stdout.write(chunk);
    recorder.feed(chunk);
  };
  const onErr = (chunk) => proc.stderr.write(chunk);
  const childEnv = { ...env, RESLOP_CAPTURE: '1' };
  let child;
  try {
    child = spawnCommand(command, { cwd, env: childEnv, stdio: PIPE });
  } catch {
    recorder.finish(1);
    return 1;
  }
  const result = await collect(child, onOut, onErr);
  const doc = documentOf(command, result, cwd);
  const slot = recorder.slot;
  recorder.finish(result.status, summarizeDocument(doc));
  if (!slot) return result.status;
  const text = renderDocument(doc, slot.rawName);
  const raw = rawStreams(result.stdout, result.stderr);
  try {
    await saveLogs(slot, text, raw);
  } catch {
    // the record remains even if the log files cannot be written
  }
  return result.status;
};

const runReport = async (proc, command, cwd, env) => {
  const recorder = beginRun(cwd, command);
  const fail = (error) => proc.stderr.write(`reslop: ${error.message}\n`);
  let child;
  try {
    const childEnv = { ...env, RESLOP_CAPTURE: '1' };
    child = spawnCommand(command, { cwd, env: childEnv, stdio: PIPE });
  } catch (error) {
    fail(error);
    recorder.finish(1);
    return 1;
  }
  const result = await collect(child, (chunk) => recorder.feed(chunk));
  const doc = documentOf(command, result, cwd);
  const slot = recorder.slot;
  const text = renderDocument(doc, slot ? slot.rawName : '');
  recorder.finish(result.status, summarizeDocument(doc));
  proc.stdout.write(text);
  if (!slot) return result.status;
  try {
    await saveLogs(slot, text, rawStreams(result.stdout, result.stderr));
  } catch (error) {
    fail(error);
  }
  return result.status;
};

const runCapture = async (proc, deps = {}) => {
  const argv = proc.argv.slice(2);
  if (argv[1] !== '--' || !argv[2]) {
    proc.stderr.write('reslop: missing command\n');
    proc.stderr.write('Usage: reslop t -- <program> [args]\n');
    return 1;
  }
  const command = { program: argv[2], args: argv.slice(3) };
  const env = proc.env ?? {};
  const mode = env.RESLOP_OUTPUT || 'md';
  if (!OUTPUTS.includes(mode)) {
    proc.stderr.write(`reslop: unknown RESLOP_OUTPUT ${env.RESLOP_OUTPUT}\n`);
    return 1;
  }
  const cwd = deps.cwd ?? proc.cwd();
  if (env.RESLOP_CAPTURE === '1') return runInherit(command, cwd, env);
  if (mode === 'raw') return runRaw(proc, command, cwd, env);
  return runReport(proc, command, cwd, env);
};

module.exports = {
  winCommand,
  runCapture,
};
