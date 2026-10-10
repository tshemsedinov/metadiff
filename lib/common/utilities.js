'use strict';

const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const { split } = require('metautil');

const IS_WIN = process.platform === 'win32';
const DEFAULT_ENCODING = 'utf8';
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;

const parseVersion = (text) => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(`${text ?? ''}`);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return { major, minor, patch };
};

const cmpVersion = (left, right) =>
  left.major - right.major ||
  left.minor - right.minor ||
  left.patch - right.patch;

const toInt = (text) => parseInt(text, 10);

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

const bindAccessors = (target, owner, names) => {
  for (const name of names) {
    Object.defineProperty(target, name, {
      configurable: true,
      enumerable: true,
      get: () => owner[name],
      set: (value) => {
        owner[name] = value;
      },
    });
  }
};

const bindGetters = (target, owner, names) => {
  for (const name of names) {
    Object.defineProperty(target, name, {
      configurable: true,
      enumerable: true,
      get: () => owner[name],
    });
  }
};

const oneLine = (text, fallback = '') =>
  split(`${text ?? ''}`.trim(), '\n')[0] || fallback;

const withNewline = (text) => {
  const body = `${text ?? ''}`;
  return !body || body.endsWith('\n') ? body : `${body}\n`;
};

const withNotice = (text, notice) => {
  const body = `${text ?? ''}`;
  if (body.endsWith(`${notice}\n`)) return body;
  return `${withNewline(body)}${notice}\n`;
};

const asText = (value) => (typeof value === 'string' ? value : '');

const unquote = (value) => {
  const text = `${value ?? ''}`;
  if (text.length < 2) return text;
  const open = text[0];
  const quoted = open === text.at(-1) && (open === '"' || open === '\x27');
  return quoted ? text.slice(1, -1) : text;
};

const pad2 = (n) => `${n}`.padStart(2, '0');

const dateStamp = (date) => {
  const month = pad2(date.getMonth() + 1);
  return `${date.getFullYear()}-${month}-${pad2(date.getDate())}`;
};

const npmBin = () => (IS_WIN ? 'npm.cmd' : 'npm');

const spawnBase = (extra = {}) => ({ windowsHide: true, ...extra });

const npmOpts = (extra = {}, platform = process.platform) =>
  spawnBase({ shell: platform === 'win32', ...extra });

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
  parseVersion,
  cmpVersion,
  toInt,
  clamp,
  readText,
  bindAccessors,
  bindGetters,
  oneLine,
  asText,
  withNewline,
  withNotice,
  unquote,
  pad2,
  dateStamp,
  npmBin,
  spawnBase,
  npmOpts,
  listen,
  watchResize,
  abortError,
  isAbort,
  runProcSync,
  runProc,
};
