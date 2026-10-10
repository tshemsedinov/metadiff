'use strict';

const fs = require('node:fs');
const path = require('node:path');
const files = require('../common/files.js');
const { REVIEW_DIR, taskKind } = files;
const { captureBaseline, mergeReview } = require('./merge.js');
const { pad2, dateStamp, toInt } = require('../common/utilities.js');
const formatPart = require('./format.js');
const { parseFrontmatterStatus, parseReview, serializeReview } = formatPart;
const { frontmatterStatus } = formatPart;
const storePart = require('./store.js');
const { hasNotes, createStore, noteCounts, reviewProgress } = storePart;
const { setFeedback, setCode, addTask, removeTask } = storePart;
const { setTaskText, setTaskDone, setFeedbackDone, moveTask } = storePart;
const { moveFeedback, checkLabel, feedbackKey, applyImportedNotes } = storePart;
const templatesPart = require('./templates.js');
const { TEMPLATES_FILE, LEGACY_TEMPLATES, TEMPLATE_SHOW, rankedTemplates } =
  templatesPart;
const { prefixTemplates, upsertTemplate, rememberTemplate, loadTemplates } =
  templatesPart;

const AUTOSAVE_MS = 3000;

const REVIEW_NAME = /^(\d{4}-\d{2}-\d{2})-(\d+)\.md$/;

const allocateReviewPath = (dir, date, existingNames) => {
  const stamp = dateStamp(date);
  let max = -1;
  for (const name of existingNames) {
    const match = REVIEW_NAME.exec(name);
    if (!match) continue;
    if (match[1] !== stamp) continue;
    const n = toInt(match[2]);
    if (n > max) max = n;
  }
  const next = max + 1;
  return path.join(dir, REVIEW_DIR, `${stamp}-${pad2(next)}.md`);
};

const listReviewNames = (dir) => {
  const folder = path.join(dir, REVIEW_DIR);
  try {
    return fs.readdirSync(folder);
  } catch {
    return [];
  }
};

const compareReviewNames = (left, right) => {
  const a = REVIEW_NAME.exec(left);
  const b = REVIEW_NAME.exec(right);
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  if (a[1] < b[1]) return -1;
  if (a[1] > b[1]) return 1;
  return toInt(a[2]) - toInt(b[2]);
};

const latestReviewName = (names) => {
  let best = '';
  for (const name of names) {
    if (!REVIEW_NAME.test(name)) continue;
    if (!best || compareReviewNames(name, best) > 0) best = name;
  }
  return best;
};

const readEntries = (folder) => {
  try {
    return fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }
};

const planFiles = (dir) => {
  const reviews = [];
  const notes = [];
  for (const entry of readEntries(path.join(dir, REVIEW_DIR))) {
    const name = entry.name;
    if (!entry.isFile() || !name.endsWith('.md')) continue;
    if (REVIEW_NAME.test(name)) reviews.push(name);
    else notes.push(name);
  }
  return { reviews, notes };
};

const planFileNames = (dir) => {
  const { reviews, notes } = planFiles(dir);
  reviews.sort((left, right) => compareReviewNames(right, left));
  return reviews.concat(notes.sort());
};

const orderedPlanNames = (dir) => {
  const { reviews, notes } = planFiles(dir);
  reviews.sort(compareReviewNames);
  notes.sort();
  return notes.concat(reviews);
};

const readReviewStatus = (reviewPath) => {
  try {
    const text = fs.readFileSync(reviewPath, 'utf8');
    return parseFrontmatterStatus(text);
  } catch {
    return '';
  }
};

const resolveReviewPath = (dir, date, existingNames, extra = {}) => {
  if (!extra.forceNew) {
    const latest = latestReviewName(existingNames);
    if (latest) {
      const reviewPath = path.join(dir, REVIEW_DIR, latest);
      if (readReviewStatus(reviewPath) === 'editing') {
        return { reviewPath, resume: true };
      }
    }
  }
  return {
    reviewPath: allocateReviewPath(dir, date, existingNames),
    resume: false,
  };
};

const loadReview = (reviewPath, templates) => {
  const raw = fs.readFileSync(reviewPath, 'utf8');
  return parseReview(raw, reviewPath, templates);
};

const readReviewText = (reviewPath) => {
  try {
    return fs.readFileSync(reviewPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
};

const mergeDiskReview = (notes) => {
  const text = readReviewText(notes.reviewPath);
  if (!text.startsWith('---')) return;
  const disk = parseReview(text, notes.reviewPath, notes.templates);
  mergeReview(notes, disk);
};

const flushReview = (notes, force = false) => {
  if (!notes || !notes.dirty) return false;
  mergeDiskReview(notes);
  if (!hasNotes(notes) && !force) {
    notes.dirty = false;
    return false;
  }
  const folder = path.dirname(notes.reviewPath);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(notes.reviewPath, serializeReview(notes), 'utf8');
  const top = path.dirname(folder);
  const templatesFile = path.join(top, REVIEW_DIR, TEMPLATES_FILE);
  const body = `${JSON.stringify(notes.templates, null, 2)}\n`;
  fs.writeFileSync(templatesFile, body, 'utf8');
  const legacyFile = path.join(top, REVIEW_DIR, LEGACY_TEMPLATES);
  try {
    if (legacyFile !== templatesFile) fs.rmSync(legacyFile);
  } catch {
    // ignore when the old templates file is already gone
  }
  captureBaseline(notes);
  notes.dirty = false;
  return true;
};

module.exports = {
  TEMPLATE_SHOW,
  AUTOSAVE_MS,
  allocateReviewPath,
  listReviewNames,
  latestReviewName,
  planFileNames,
  orderedPlanNames,
  parseFrontmatterStatus,
  resolveReviewPath,
  rankedTemplates,
  prefixTemplates,
  upsertTemplate,
  createStore,
  noteCounts,
  reviewProgress,
  frontmatterStatus,
  hasNotes,
  rememberTemplate,
  setFeedback,
  setCode,
  addTask,
  taskKind,
  removeTask,
  setTaskText,
  setTaskDone,
  setFeedbackDone,
  moveTask,
  moveFeedback,
  checkLabel,
  feedbackKey,
  applyImportedNotes,
  serializeReview,
  parseReview,
  loadReview,
  loadTemplates,
  flushReview,
};
