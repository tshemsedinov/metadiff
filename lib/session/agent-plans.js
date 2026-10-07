'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { visibleWidth } = require('../ansi.js');
const review = require('../review.js');
const { parseReview, reviewProgress, frontmatterStatus } = review;

const planKey = (value) => {
  const text = `${value ?? ''}`.trim();
  if (!text) return '';
  const gap = text.indexOf('  ');
  return gap > 0 ? text.slice(0, gap) : path.basename(text);
};

const isLive = (store, file) => {
  const live = store ? store.reviewPath : '';
  return Boolean(live) && path.basename(live) === path.basename(file);
};

const planState = (file, store) => {
  if (isLive(store, file)) {
    const status = `${store.status ?? ''}`.trim() || 'editing';
    return { status, ...reviewProgress(store) };
  }
  try {
    const text = fs.readFileSync(file, 'utf8');
    const progress = reviewProgress(parseReview(text, file));
    const status = frontmatterStatus(text) || (progress.total ? 'editing' : '');
    return { status, done: progress.done, total: progress.total };
  } catch {
    return null;
  }
};

const planProgress = (file, root, store) => {
  if (!file) return '';
  const abs = path.isAbsolute(file) ? file : path.join(root, file);
  const state = planState(abs, store);
  return state && state.total ? `${state.done}/${state.total}` : '';
};

const planPart = (dir, name, store) => {
  const base = planKey(name);
  if (!base) return null;
  const state = planState(path.join(dir, base), store);
  if (!state || !state.status) return { name: base, status: '', progress: '' };
  const progress = `${state.done}/${state.total}`;
  return { name: base, status: state.status, progress };
};

const planLabel = (part) => {
  if (!part.status) return part.name;
  return `${part.name}  ${part.status}  ${part.progress}`;
};

const padVisible = (text, width) =>
  `${text}${' '.repeat(Math.max(0, width - visibleWidth(text)))}`;

const alignPlanLabels = (parts) => {
  let nameW = 0;
  let statusW = 0;
  for (const part of parts) {
    if (!part.status) continue;
    nameW = Math.max(nameW, visibleWidth(part.name));
    statusW = Math.max(statusW, visibleWidth(part.status));
  }
  return parts.map((part) => {
    if (!part.status) return part.name;
    const name = padVisible(part.name, nameW);
    const status = padVisible(part.status, statusW);
    return planLabel({ name, status, progress: part.progress });
  });
};

module.exports = {
  planKey,
  planProgress,
  planPart,
  planLabel,
  alignPlanLabels,
};
