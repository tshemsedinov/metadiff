'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { jsonParse, isHashObject } = require('metautil');
const { THEME_NAMES } = require('../../term/ansi.js');
const { REVIEW_DIR } = require('../../common/files.js');

const PREFS = '.reslop';

const LAYOUT_LABEL = {
  unified: 'unified',
  mixed: 'mixed',
  side: 'side-by-side',
};

const LAYOUT_VALUE = {
  unified: 'unified',
  mixed: 'mixed',
  'side-by-side': 'side',
};

const prefsFile = (root) => path.join(root, PREFS);

const planPath = (root, name) => path.join(root, REVIEW_DIR, name);

const readPrefs = (root) => {
  try {
    const data = jsonParse(fs.readFileSync(prefsFile(root), 'utf8'));
    if (!isHashObject(data)) return { agents: {} };
    const agents = isHashObject(data.agents) ? data.agents : {};
    return { ...data, agents };
  } catch {
    return { agents: {} };
  }
};

const writePrefs = (root, data) => {
  const stored = { ...data };
  delete stored.runs;
  try {
    fs.writeFileSync(prefsFile(root), `${JSON.stringify(stored, null, 2)}\n`);
  } catch {
    // The repo root can be read-only.
  }
};

const section = (data, name) => {
  const value = data[name];
  if (!isHashObject(value)) return {};
  return { ...value };
};

const readUiPrefs = (root) => {
  const data = readPrefs(root);
  const editor = section(data, 'editor');
  const general = section(data, 'general');
  const commits = section(data, 'commits');
  let lineNumbers = false;
  if (typeof editor.lineNumbers === 'boolean') {
    lineNumbers = editor.lineNumbers;
  } else if (typeof data.lineNumbers === 'boolean') {
    lineNumbers = data.lineNumbers;
  }
  const layout = LAYOUT_VALUE[editor.mode] || 'unified';
  const theme = THEME_NAMES.includes(general.theme) ? general.theme : 'dark';
  const commitView = commits.view === 'full' ? 'full' : 'brief';
  return { lineNumbers, layout, theme, commitView };
};

const saveUiPrefs = (root, patch) => {
  if (!root) return;
  const data = readPrefs(root);
  const editor = section(data, 'editor');
  const legacy = typeof data.lineNumbers === 'boolean';
  if (legacy && editor.lineNumbers === undefined) {
    editor.lineNumbers = data.lineNumbers;
  }
  delete data.lineNumbers;
  if (patch.lineNumbers !== undefined) {
    editor.lineNumbers = patch.lineNumbers === true;
  }
  if (patch.layout) editor.mode = LAYOUT_LABEL[patch.layout] || 'unified';
  const next = { ...data, editor };
  if (patch.theme) {
    const general = section(data, 'general');
    general.theme = patch.theme;
    next.general = general;
  }
  if (patch.commitView) {
    const commits = section(data, 'commits');
    const full = patch.commitView === 'full';
    commits.view = full ? 'full' : 'brief';
    next.commits = commits;
  }
  writePrefs(root, next);
};

const readStored = (file) => {
  try {
    return jsonParse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const writeStored = (file, data) => {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  } catch {
    // The plan directory can be read-only.
  }
};

module.exports = {
  LAYOUT_LABEL,
  planPath,
  readPrefs,
  writePrefs,
  readUiPrefs,
  saveUiPrefs,
  readStored,
  writeStored,
};
