'use strict';

const render = require('../render/render.js');
const { presentRows, presentCursor } = render;
const utilities = require('../utilities.js');
const { listen, watchResize } = utilities;

const ENTER_TERM = '\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?1002h\x1b[?1006h';
const LEAVE_TERM =
  '\x1b[?1006l\x1b[?1002l\x1b[?7h\x1b[0 q\x1b[?12l\x1b[?25h\x1b[?1049l';

const sameCursor = (a, b) => {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y;
};

const hasTimer = (api, name) => api.timers.has(name);

const stopTimer = (api, name) => {
  const id = api.timers.get(name);
  if (id === undefined) return;
  clearInterval(id);
  api.timers.delete(name);
};

const startTimer = (api, name, fn, ms) => {
  if (api.state.disposed) return;
  if (api.timers.has(name)) return;
  const id = setInterval(fn, ms);
  if (id && typeof id.unref === 'function') id.unref();
  api.timers.set(name, id);
};

const restartTimer = (api, name, fn, ms) => {
  stopTimer(api, name);
  startTimer(api, name, fn, ms);
};

const clearTimers = (api) => {
  for (const name of [...api.timers.keys()]) stopTimer(api, name);
};

const stopListening = (api) => {
  while (api.disposers.length) {
    const stop = api.disposers.pop();
    stop();
  }
};

const enter = (api) => {
  if (api.state.disposed) return;
  const { stdin, stdout, state } = api;
  if (stdin && stdin.setRawMode) stdin.setRawMode(true);
  if (stdin && typeof stdin.resume === 'function') stdin.resume();
  stdout.write(ENTER_TERM);
  state.open = true;
};

const leave = (api) => {
  if (!api.state.open) return;
  api.stdout.write(LEAVE_TERM);
  if (api.stdin && api.stdin.setRawMode) api.stdin.setRawMode(false);
  api.state.open = false;
};

const resetCache = (api) => {
  api.state.carry = '';
  api.state.lastFrame = null;
  api.state.lastPresentedCursor = null;
  api.state.lastSize = null;
};

const close = (api) => {
  stopListening(api);
  clearTimers(api);
  leave(api);
  api.state.disposed = true;
};

const startListening = (api, handlers) => {
  if (api.state.disposed) return;
  const onData = (chunk) => handlers.onData(chunk);
  const onResize = () => handlers.onResize();
  api.disposers.push(listen(api.stdin, 'data', onData));
  api.disposers.push(watchResize(api.stdout, api.proc, onResize));
};

const paint = (api, frame, size, cursor) => {
  if (api.state.disposed) return;
  const lastSize = api.state.lastSize;
  const resized =
    !lastSize ||
    lastSize.width !== size.width ||
    lastSize.height !== size.height;
  if (
    !resized &&
    api.state.lastFrame &&
    api.state.lastFrame.text === frame.text
  ) {
    if (sameCursor(api.state.lastPresentedCursor, cursor)) return;
    api.state.lastPresentedCursor = cursor;
    api.stdout.write(presentCursor(cursor));
    return;
  }
  api.state.lastSize = size;
  api.state.lastFrame = frame;
  api.state.lastPresentedCursor = cursor;
  api.stdout.write(presentRows(frame.rows, { clear: resized, cursor }));
};

const createTerminal = (options) => {
  const state = {
    open: false,
    disposed: false,
    carry: '',
    lastFrame: null,
    lastPresentedCursor: null,
    lastSize: null,
  };
  const api = {
    stdin: options.stdin ?? null,
    stdout: options.stdout,
    proc: options.proc ?? process,
    timers: new Map(),
    disposers: [],
    state,
  };
  return {
    get lastFrame() {
      return state.lastFrame;
    },
    get lastSize() {
      return state.lastSize;
    },
    get carry() {
      return state.carry;
    },
    set carry(value) {
      state.carry = value;
    },
    get disposed() {
      return state.disposed;
    },
    enter: () => enter(api),
    leave: () => leave(api),
    close: () => close(api),
    paint: (frame, size, cursor) => paint(api, frame, size, cursor),
    startListening: (handlers) => startListening(api, handlers),
    stopListening: () => stopListening(api),
    startTimer: (name, fn, ms) => startTimer(api, name, fn, ms),
    stopTimer: (name) => stopTimer(api, name),
    restartTimer: (name, fn, ms) => restartTimer(api, name, fn, ms),
    clearTimers: () => clearTimers(api),
    hasTimer: (name) => hasTimer(api, name),
    resetCache: () => resetCache(api),
  };
};

module.exports = {
  ENTER_TERM,
  LEAVE_TERM,
  sameCursor,
  createTerminal,
};
