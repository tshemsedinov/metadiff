'use strict';

const fs = require('node:fs');
const path = require('node:path');
const files = require('../common/files.js');
const { REVIEW_DIR } = files;
const { toInt } = require('../common/utilities.js');

const TEMPLATE_SHOW = 5;

const rankedTemplates = (templates) => {
  const ranked = [...templates];
  ranked.sort((a, b) => {
    const byCount = b.count - a.count;
    if (byCount) return byCount;
    return a.text.localeCompare(b.text);
  });
  return ranked;
};

const prefixTemplates = (templates, prefix) => {
  if (!prefix) return templates;
  return templates.filter((entry) => entry.text.startsWith(prefix));
};

const upsertTemplate = (templates, text) => {
  const trimmed = text.trim();
  if (!trimmed) return templates;
  const next = [...templates];
  const i = next.findIndex((entry) => entry.text === trimmed);
  if (i < 0) {
    next.push({ text: trimmed, count: 1 });
    return next;
  }
  const prev = next[i];
  next[i] = { text: prev.text, count: prev.count + 1 };
  return next;
};

const rememberTemplate = (store, prevText, nextText) => {
  const trimmed = nextText.trim();
  if (!trimmed) return;
  const prev = (prevText ?? '').trim();
  if (prev === trimmed) return;
  store.templates = upsertTemplate(store.templates, trimmed);
  store.dirty = true;
};

const TEMPLATES_FILE = '.templates';

const LEGACY_TEMPLATES = 'templates.json';

const templateEntries = (data) => {
  if (!Array.isArray(data)) return [];
  const templates = [];
  for (const entry of data) {
    if (!entry || typeof entry.text !== 'string') continue;
    const count = toInt(entry.count);
    templates.push({
      text: entry.text,
      count: Number.isFinite(count) ? count : 1,
    });
  }
  return templates;
};

const readTemplateFile = (file) => {
  try {
    return templateEntries(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    return [];
  }
};

const loadTemplates = (dir) => {
  const folder = path.join(dir, REVIEW_DIR);
  const current = readTemplateFile(path.join(folder, TEMPLATES_FILE));
  if (current) return current;
  const legacy = readTemplateFile(path.join(folder, LEGACY_TEMPLATES));
  return legacy ?? [];
};

module.exports = {
  TEMPLATE_SHOW,
  rankedTemplates,
  prefixTemplates,
  upsertTemplate,
  rememberTemplate,
  TEMPLATES_FILE,
  LEGACY_TEMPLATES,
  loadTemplates,
};
