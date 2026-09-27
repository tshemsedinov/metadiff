'use strict';

const path = require('node:path');
const childProcess = require('node:child_process');
const { spawn } = childProcess;

const utilities = require('./utilities.js');
const { spawnBase } = utilities;
const npmCommands = require('./npm-commands.js');
const { writeLog } = npmCommands;
const reportParse = require('./report-parse.js');
const { toolHint, buildDocument } = reportParse;
const reportRender = require('./report-render.js');
const { renderDocument } = reportRender;

const OUTPUTS = new Set(['md', 'raw']);

const outputMode = (env) => {
  const value = env.RESLOP_OUTPUT;
  if (value) return OUTPUTS.has(value) ? value : '';
  return 'md';
};

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

const spawnCommand = (program, args, options) => {
  const { cwd, env, stdio } = options;
  const base = { cwd, env, stdio };
  if (process.platform !== 'win32') {
    return spawn(program, args, spawnBase(base));
  }
  const command = winCommand(program, args);
  const shell = process.env.comspec || 'cmd.exe';
  return spawn(
    shell,
    ['/d', '/s', '/c', command],
    spawnBase({ ...base, windowsVerbatimArguments: true }),
  );
};

const waitStatus = (child) =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      resolve(status);
    };
    child.on('error', () => finish(1));
    child.on('close', (status) => finish(status === null ? 1 : status));
  });

const collect = (child) =>
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
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        err += chunk;
      });
    }
    child.on('error', (error) => {
      err += `${error.message}\n`;
      finish(1);
    });
    child.on('close', (status) => finish(status === null ? 1 : status));
  });

const commandArgs = (argv) => {
  if (argv[0] !== 't' || argv[1] !== '--' || !argv[2]) return null;
  return { program: argv[2], args: argv.slice(3) };
};

const usage = (stderr) => {
  stderr.write('reslop: missing command\n');
  stderr.write('Usage: reslop t -- <program> [args]\n');
  return 1;
};

const runInherit = async (spawnFn, program, args, options) => {
  let child;
  try {
    child = spawnFn(program, args, { ...options, stdio: 'inherit' });
  } catch {
    return 1;
  }
  return waitStatus(child);
};

const runCapture = async (proc, deps = {}) => {
  const env = proc.env || {};
  const argv = proc.argv.slice(2);
  const command = commandArgs(argv);
  if (!command) return usage(proc.stderr);
  const mode = outputMode(env);
  if (!mode) {
    proc.stderr.write(`reslop: unknown RESLOP_OUTPUT ${env.RESLOP_OUTPUT}\n`);
    return 1;
  }
  const cwd = deps.cwd ? deps.cwd : proc.cwd();
  const spawnFn = deps.spawn || spawnCommand;
  const capture = env.RESLOP_CAPTURE === '1';
  if (mode === 'raw' || capture) {
    return runInherit(spawnFn, command.program, command.args, { cwd, env });
  }
  const childEnv = { ...env, RESLOP_CAPTURE: '1' };
  let child;
  try {
    child = spawnFn(command.program, command.args, {
      cwd,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    proc.stderr.write(`reslop: ${error.message}\n`);
    return 1;
  }
  const result = await collect(child);
  const hint = toolHint(command.program, command.args);
  const doc = buildDocument(
    result.stdout,
    result.stderr,
    cwd,
    result.status,
    hint,
  );
  const text = renderDocument(doc);
  proc.stdout.write(text);
  try {
    writeLog(cwd, path.basename(command.program), text);
  } catch (error) {
    proc.stderr.write(`reslop: ${error.message}\n`);
  }
  return result.status;
};

module.exports = {
  outputMode,
  winCommand,
  runCapture,
};
