'use strict';

const accessors = require('./accessors.js');
const { stateView } = accessors;

const review = require('../review.js');
const { createStore, applyImportedNotes, setStatus } = review;
const { listReviewNames, loadTemplates, resolveReviewPath } = review;
const { loadReview, flushReview } = review;

const createReviewController = () => {
  const state = {
    store: null,
    didResume: false,
    importedRemote: false,
  };

  const reset = () => {
    state.store = null;
    state.didResume = false;
    state.importedRemote = false;
  };

  const init = (dir, date, extra = {}) => {
    const names = listReviewNames(dir);
    const templates = loadTemplates(dir);
    const resolved = resolveReviewPath(dir, date, names, extra);
    if (resolved.resume) {
      state.store = loadReview(resolved.reviewPath, templates);
      state.didResume = true;
      return state.store;
    }
    state.store = createStore(resolved.reviewPath, templates);
    state.didResume = false;
    return state.store;
  };

  const applyImported = (imported) => {
    if (!imported || !state.store) return false;
    if (state.didResume || state.importedRemote) return false;
    applyImportedNotes(state.store, imported);
    state.importedRemote = true;
    return true;
  };

  const flush = (force = false) => {
    if (!state.store) return { ok: true, wrote: false };
    try {
      const wrote = flushReview(state.store, force);
      return { ok: true, wrote };
    } catch (error) {
      return { ok: false, wrote: false, error };
    }
  };

  const finishQuit = (status) => {
    setStatus(state.store, status);
    return flush();
  };

  return stateView(
    state,
    {
      reset,
      init,
      applyImported,
      flush,
      finishQuit,
    },
    [],
    ['store', 'didResume', 'importedRemote'],
  );
};

module.exports = { createReviewController };
