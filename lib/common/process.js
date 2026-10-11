'use strict';

const { spawn, spawnSync } = require('node:child_process');

const IS_WIN = process.platform === 'win32';
const INSTALL_MS = 120000;
const DEFAULT_ENCODING = 'utf8';
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;

const npmBin = () => (IS_WIN ? 'npm.cmd' : 'npm');

const spawnBase = (extra = {}) => ({ windowsHide: true, ...extra });

const npmOpts = (extra = {}, platform = process.platform) =>
  spawnBase({ shell: platform === 'win32', ...extra });

const codeError = (message, code) =>
  Object.assign(new Error(message), { code });

const abortError = () => codeError('aborted', 'ABORT');

const isAbort = (error) => !!(error && error.code === 'ABORT');

const procResult = (values = {}) => ({
  status: values.status ?? null,
  stdout: `${values.stdout ?? ''}`,
  stderr: `${values.stderr ?? ''}`,
  error: values.error ?? null,
});

const runProcSync = (cmd, args, options = {}) => {
  const opts = spawnBase({
    cwd: options.cwd,
    env: options.env,
    encoding: options.encoding ?? DEFAULT_ENCODING,
    input: options.input,
    maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
    timeout: options.timeout,
  });
  if (options.shell) opts.shell = true;
  return procResult(spawnSync(cmd, args, opts));
};

const listenChild = (child, options, resolve) => {
  const encoding = options.encoding ?? DEFAULT_ENCODING;
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const signal = options.signal;
  let stdout = '';
  let stderr = '';
  let settled = false;
  let timer = null;
  let onAbort = null;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    resolve(result);
  };
  const fail = (error) => {
    child.kill();
    finish(procResult({ stdout, stderr, error }));
  };
  onAbort = () => fail(abortError());
  const append = (chunk, isOut) => {
    if (isOut) stdout += chunk;
    else stderr += chunk;
    if (stdout.length + stderr.length > maxBuffer) {
      fail(codeError('maxBuffer exceeded', 'ENOBUFS'));
    }
  };
  if (signal) signal.addEventListener('abort', onAbort);
  if (options.timeout) {
    const onTimeout = () => fail(codeError('timed out', 'ETIMEDOUT'));
    timer = setTimeout(onTimeout, options.timeout);
  }
  if (signal && signal.aborted) onAbort();
  if (child.stdout) {
    child.stdout.setEncoding(encoding);
    child.stdout.on('data', (chunk) => append(chunk, true));
  }
  if (child.stderr) {
    child.stderr.setEncoding(encoding);
    child.stderr.on('data', (chunk) => append(chunk, false));
  }
  child.on('error', (error) => {
    finish(procResult({ stdout, stderr, error }));
  });
  child.on('close', (status) => {
    finish(procResult({ status, stdout, stderr }));
  });
  if (!child.stdin) return;
  try {
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  } catch {
    // closed
  }
};

const runProc = (cmd, args, options = {}) =>
  new Promise((resolve) => {
    const signal = options.signal;
    if (signal && signal.aborted) {
      resolve(procResult({ error: abortError() }));
      return;
    }
    const spawnOpts = { cwd: options.cwd, env: options.env };
    if (options.shell) spawnOpts.shell = true;
    let child;
    try {
      child = spawn(cmd, args, spawnBase(spawnOpts));
    } catch (error) {
      resolve(procResult({ error }));
      return;
    }
    listenChild(child, options, resolve);
  });

module.exports = {
  IS_WIN,
  INSTALL_MS,
  npmBin,
  spawnBase,
  npmOpts,
  abortError,
  isAbort,
  runProcSync,
  runProc,
};
