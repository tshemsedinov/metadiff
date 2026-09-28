'use strict';

const createProgress = (term, onTick, intervalMs) => {
  const active = new Set();

  const tick = () => {
    if (!active.size) return;
    onTick();
    term.later('progress', tick, intervalMs);
  };

  const start = (id) => {
    active.add(id);
    term.later('progress', tick, intervalMs);
  };

  const stop = (id) => {
    active.delete(id);
    if (active.size === 0) term.cancel('progress');
  };

  const clear = () => {
    active.clear();
    term.cancel('progress');
  };

  const size = () => active.size;

  return { start, stop, clear, size };
};

module.exports = { createProgress };
