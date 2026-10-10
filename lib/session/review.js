'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { REVIEW_DIR } = require('../common/files.js');
const review = require('../review/review.js');
const { ReviewStore } = review;
const { listReviewNames, loadTemplates, resolveReviewPath } = review;
const { loadReview, flushReview } = review;

const ISSUE_TASK_FILE = 'issue';

const issueTasks = (imported) => {
  const todos = imported.tasks ?? imported.todos ?? [];
  return todos.filter((todo) => (todo.file || '') === ISSUE_TASK_FILE);
};

class ReviewController {
  constructor() {
    this.reset();
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
      : new ReviewStore(resolved.reviewPath, templates);
    return this.store;
  }

  applyImported(imported) {
    if (!imported || !this.store) return false;
    if (this.importedRemote) return false;
    const notes = this.didResume ? { tasks: issueTasks(imported) } : imported;
    this.store.applyImportedNotes(notes);
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

  usePlan(dir, name) {
    const store = this.store;
    if (!store || !name) return false;
    const next = path.join(dir, REVIEW_DIR, name);
    if (next === store.reviewPath) return false;
    this.flush();
    const templates = store.templates;
    const loaded = fs.existsSync(next);
    this.store = loaded
      ? loadReview(next, templates)
      : new ReviewStore(next, templates);
    return true;
  }
}

module.exports = { ReviewController };
