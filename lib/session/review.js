'use strict';

const review = require('../review.js');
const { createStore, applyImportedNotes, setStatus } = review;
const { listReviewNames, loadTemplates, resolveReviewPath } = review;
const { loadReview, flushReview } = review;

class ReviewController {
  constructor() {
    this.store = null;
    this.didResume = false;
    this.importedRemote = false;
  }

  reset() {
    this.store = null;
    this.didResume = false;
    this.importedRemote = false;
  }

  init(dir, date, extra = {}) {
    const names = listReviewNames(dir);
    const templates = loadTemplates(dir);
    const resolved = resolveReviewPath(dir, date, names, extra);
    this.didResume = resolved.resume === true;
    this.store = this.didResume
      ? loadReview(resolved.reviewPath, templates)
      : createStore(resolved.reviewPath, templates);
    return this.store;
  }

  applyImported(imported) {
    if (!imported || !this.store) return false;
    if (this.didResume || this.importedRemote) return false;
    applyImportedNotes(this.store, imported);
    this.importedRemote = true;
    return true;
  }

  flush(force = false) {
    if (!this.store) return { ok: true, wrote: false };
    try {
      const wrote = flushReview(this.store, force);
      return { ok: true, wrote };
    } catch (error) {
      return { ok: false, wrote: false, error };
    }
  }

  finishQuit(status) {
    setStatus(this.store, status);
    return this.flush();
  }
}

module.exports = { ReviewController };
