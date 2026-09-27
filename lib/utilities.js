'use strict';

const childProcess = require('node:child_process');
const { spawn, spawnSync } = childProcess;
const metautil = require('metautil');
const { split } = metautil;

const IS_WIN = process.platform === 'win32';
const DEFAULT_ENCODING = 'utf8';
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;

const UNIX_CLIP = [
  { cmd: 'wl-copy', args: [] },
  { cmd: 'xclip', args: ['-selection', 'clipboard'] },
  { cmd: 'xsel', args: ['--clipboard', '--input'] },
];

const parseVersion = (text) => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(`${text ?? ''}`);
  if (!match) return null;
  const [, major, minor, patch] = match.map(Number);
  return { major, minor, patch };
};

const cmpVersion = (left, right) =>
  left.major - right.major ||
  left.minor - right.minor ||
  left.patch - right.patch;

const oneLine = (text, fallback = '') =>
  split(`${text ?? ''}`.trim(), '\n')[0] || fallback;

const npmBin = (platform = process.platform) =>
  platform === 'win32' ? 'npm.cmd' : 'npm';

const spawnBase = (extra = {}) => ({ windowsHide: true, ...extra });

const npmOpts = (extra = {}, platform = process.platform) =>
  spawnBase({ shell: platform === 'win32', ...extra });

const clipTools = (platform = process.platform) => {
  if (platform === 'win32') return [{ cmd: 'clip', args: [] }];
  if (platform === 'darwin') return [{ cmd: 'pbcopy', args: [] }];
  return UNIX_CLIP;
};

const listen = (emitter, event, handler) => {
  if (!emitter || typeof emitter.on !== 'function') return () => {};
  emitter.on(event, handler);
  return () => {
    if (typeof emitter.removeListener === 'function') {
      return void emitter.removeListener(event, handler);
    }
    if (typeof emitter.off === 'function') emitter.off(event, handler);
  };
};

const watchResize = (stdout, proc, onResize, signal) => {
  const stopStdout = listen(stdout, 'resize', onResize);
  let stopProc = () => {};
  try {
    stopProc = listen(proc, 'SIGWINCH', onResize);
  } catch {
    // SIGWINCH is not available on Windows
  }
  const stop = () => {
    stopStdout();
    stopProc();
  };
  if (signal) {
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  }
  return stop;
};

const abortError = () => {
  const error = new Error('aborted');
  error.code = 'ABORT';
  return error;
};

const isAbort = (error) => !!(error && error.code === 'ABORT');

const asOutput = (value) => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  return `${value}`;
};

const procResult = (values = {}) => {
  const status = values.status ?? null;
  const stdout = asOutput(values.stdout);
  const stderr = asOutput(values.stderr);
  const error = values.error ?? null;
  return { status, stdout, stderr, error };
};

const spawnOptions = (options = {}) => {
  const encoding = options.encoding ?? DEFAULT_ENCODING;
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const opts = spawnBase({
    cwd: options.cwd,
    env: options.env,
    encoding,
    input: options.input,
    maxBuffer,
    timeout: options.timeout,
  });
  if (options.shell) opts.shell = true;
  return opts;
};

const runProcSync = (cmd, args, options = {}) => {
  const result = spawnSync(cmd, args, spawnOptions(options));
  return procResult(result);
};

const attachOutput = (stream, encoding, onChunk) => {
  if (!stream) return;
  stream.setEncoding(encoding);
  stream.on('data', onChunk);
};

const writeInput = (child, input) => {
  if (!child.stdin) return;
  try {
    if (input) child.stdin.end(input);
    else child.stdin.end();
  } catch {
    // closed
  }
};

const listenChild = (child, options, resolve) => {
  const encoding = options.encoding ?? DEFAULT_ENCODING;
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const timeout = options.timeout;
  const input = options.input;
  const signal = options.signal;
  let stdout = '';
  let stderr = '';
  let settled = false;
  let timer = null;
  let onAbort = null;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    timer = null;
    if (signal && onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
    onAbort = null;
    resolve(result);
  };
  onAbort = () => {
    child.kill();
    finish(procResult({ stdout, stderr, error: abortError() }));
  };
  const append = (kind, chunk) => {
    if (kind === 'out') stdout += chunk;
    else stderr += chunk;
    if (stdout.length + stderr.length <= maxBuffer) return;
    child.kill();
    const error = new Error('maxBuffer exceeded');
    error.code = 'ENOBUFS';
    finish(procResult({ stdout, stderr, error }));
  };
  if (signal) signal.addEventListener('abort', onAbort);
  if (timeout) {
    timer = setTimeout(() => {
      child.kill();
      const error = new Error('timed out');
      error.code = 'ETIMEDOUT';
      finish(procResult({ stdout, stderr, error }));
    }, timeout);
  }
  if (signal && signal.aborted) onAbort();
  attachOutput(child.stdout, encoding, (chunk) => append('out', chunk));
  attachOutput(child.stderr, encoding, (chunk) => append('err', chunk));
  child.on('error', (error) => {
    finish(procResult({ stdout, stderr, error }));
  });
  child.on('close', (status) => {
    finish(procResult({ status, stdout, stderr }));
  });
  writeInput(child, input);
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
  DEFAULT_ENCODING,
  DEFAULT_MAX_BUFFER,
  parseVersion,
  cmpVersion,
  oneLine,
  npmBin,
  spawnBase,
  npmOpts,
  clipTools,
  listen,
  watchResize,
  abortError,
  isAbort,
  procResult,
  runProcSync,
  runProc,
};
