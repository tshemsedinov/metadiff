'use strict';

class LoadCoordinator {
  constructor() {
    this.gen = 0;
    this.abortController = null;
    this.promise = null;
    this.pendingExtras = false;
    this.didLoad = false;
  }

  get signal() {
    return this.abortController?.signal;
  }

  bump() {
    this.gen += 1;
    this.abortController?.abort();
    this.abortController = new AbortController();
    return this.gen;
  }

  isCurrent(gen, done = false) {
    return gen === this.gen && !done;
  }

  abort() {
    this.abortController?.abort();
  }

  reset() {
    this.abort();
    this.gen += 1;
    this.abortController = null;
    this.promise = null;
    this.pendingExtras = false;
    this.didLoad = false;
  }
}

const tagLoaded = (loaded, gen) => ({ ...loaded, generation: gen });

const fetchSnapshot = async (repo, cwd, paths, options) =>
  repo.load(cwd, paths, options);

const fetchExtras = async (repo, loaded, extra) => {
  if (!repo.loadExtras) return null;
  return repo.loadExtras(loaded, extra);
};

module.exports = { LoadCoordinator, tagLoaded, fetchSnapshot, fetchExtras };
