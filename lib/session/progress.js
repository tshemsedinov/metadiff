'use strict';

class Progress {
  constructor(term, onTick, intervalMs) {
    this.term = term;
    this.onTick = onTick;
    this.intervalMs = intervalMs;
    this.active = new Set();
  }

  tick() {
    if (!this.active.size) return;
    this.onTick();
    this.schedule();
  }

  schedule() {
    this.term.later('progress', () => this.tick(), this.intervalMs);
  }

  start(id) {
    this.active.add(id);
    this.schedule();
  }

  stop(id) {
    this.active.delete(id);
    if (!this.active.size) this.term.cancel('progress');
  }

  clear() {
    this.active.clear();
    this.term.cancel('progress');
  }

  size() {
    return this.active.size;
  }
}

module.exports = { Progress };
