'use strict';

const render = require('../render/render.js');
const { presentRows, presentCursor } = render;
const utilities = require('../utilities.js');
const { listen, watchResize } = utilities;

const ENTER_TERM = '\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?1002h\x1b[?1006h';
const LEAVE_TERM =
  '\x1b[?1006l\x1b[?1002l\x1b[?7h\x1b[0 q\x1b[?12l\x1b[?25h\x1b[?1049l';

const sameCursor = (a, b) => {
  if (!a || !b) return !a && !b;
  return a.x === b.x && a.y === b.y;
};

const sameSize = (a, b) =>
  a !== null && a.width === b.width && a.height === b.height;

class Terminal {
  constructor({ stdin = null, stdout, proc = process }) {
    this.stdin = stdin;
    this.stdout = stdout;
    this.proc = proc;
    this.timers = new Map();
    this.disposers = [];
    this.open = false;
    this.disposed = false;
    this.resetCache();
  }

  resetCache() {
    this.carry = '';
    this.lastFrame = null;
    this.lastCursor = null;
    this.lastSize = null;
  }

  hasTimer(name) {
    return this.timers.has(name);
  }

  cancel(name) {
    const id = this.timers.get(name);
    if (id === undefined) return;
    clearTimeout(id);
    this.timers.delete(name);
  }

  later(name, fn, ms) {
    if (this.disposed || this.timers.has(name)) return;
    const id = setTimeout(() => {
      this.timers.delete(name);
      fn();
    }, ms);
    id.unref();
    this.timers.set(name, id);
  }

  clearTimers() {
    for (const id of this.timers.values()) clearTimeout(id);
    this.timers.clear();
  }

  enter() {
    if (this.disposed) return;
    const stdin = this.stdin;
    if (stdin && stdin.setRawMode) stdin.setRawMode(true);
    if (stdin && stdin.resume) stdin.resume();
    this.stdout.write(ENTER_TERM);
    this.open = true;
  }

  leave() {
    if (!this.open) return;
    this.stdout.write(LEAVE_TERM);
    if (this.stdin && this.stdin.setRawMode) this.stdin.setRawMode(false);
    this.open = false;
  }

  close() {
    this.stopListening();
    this.clearTimers();
    this.leave();
    this.disposed = true;
  }

  startListening({ onData, onResize }) {
    if (this.disposed) return;
    this.listenOpts = { onData, onResize };
    this.disposers.push(listen(this.stdin, 'data', onData));
    this.disposers.push(watchResize(this.stdout, this.proc, onResize));
  }

  stopListening() {
    while (this.disposers.length) this.disposers.pop()();
  }

  pause() {
    this.stopListening();
    this.leave();
    if (this.stdin && this.stdin.pause) this.stdin.pause();
    this.resetCache();
  }

  resume() {
    if (this.disposed || this.open) return;
    this.enter();
    if (this.listenOpts) this.startListening(this.listenOpts);
  }

  paint(frame, size, cursor) {
    if (this.disposed) return;
    const resized = !sameSize(this.lastSize, size);
    const last = this.lastFrame;
    this.lastFrame = frame;
    if (!resized && last && last.text === frame.text) {
      if (sameCursor(this.lastCursor, cursor)) return;
      this.lastCursor = cursor;
      return void this.stdout.write(presentCursor(cursor));
    }
    this.lastSize = size;
    this.lastCursor = cursor;
    this.stdout.write(presentRows(frame.rows, { clear: resized, cursor }));
  }
}

module.exports = { ENTER_TERM, LEAVE_TERM, Terminal };
