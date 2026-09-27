'use strict';

const accessors = require('./accessors.js');
const { stateView } = accessors;

const utilities = require('../utilities.js');
const { isAbort: isAbortError } = utilities;

const createLoadCoordinator = () => {
  const state = {
    gen: 0,
    abort: null,
    promise: null,
    pendingExtras: false,
    didLoad: false,
  };

  const bump = () => {
    state.gen += 1;
    state.abort?.abort();
    state.abort = new AbortController();
    return state.gen;
  };

  const isCurrent = (gen, done = false) => gen === state.gen && !done;
  const accept = isCurrent;

  const abort = () => {
    state.abort?.abort();
  };

  const reset = () => {
    abort();
    state.gen += 1;
    state.abort = null;
    state.promise = null;
    state.pendingExtras = false;
    state.didLoad = false;
  };

  const tag = (loaded, gen) => ({ ...loaded, generation: gen });

  const fetchSnapshot = async (repo, cwd, paths, options) => {
    if (repo.loadAsync) return repo.loadAsync(cwd, paths, options);
    return repo.load(cwd, paths, options);
  };

  const fetchExtras = async (repo, loaded, extra) => {
    if (!repo.loadExtras) return null;
    return repo.loadExtras(loaded, extra);
  };

  return stateView(
    state,
    {
      get signal() {
        return state.abort?.signal;
      },
      bump,
      isCurrent,
      accept,
      abort,
      reset,
      tag,
      fetchSnapshot,
      fetchExtras,
    },
    ['promise', 'pendingExtras', 'didLoad'],
    ['gen'],
  );
};

module.exports = { isAbortError, createLoadCoordinator };
