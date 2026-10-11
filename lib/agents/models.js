'use strict';

const { stripAnsi } = require('../term/ansi.js');
const { trimText } = require('../common/utilities.js');

const MODEL_ID = /^[A-Za-z][A-Za-z0-9_./:+#-]*$/;
const SKIP_TOKEN = new RegExp(
  '^(no|available|loading|usage|help|try|tip|error|' +
    'warning|command|commands|options|flag|version|' +
    'unknown|invalid)$',
  'i',
);
const CURSOR_ROW = /^([A-Za-z][A-Za-z0-9_./:+#-]*)\s+-\s+\S/;
const CURSOR_NOISE = /^(?:loading models|available models$|tip:|no models)/i;
const AVAILABLE_LINE = /^Available models:\s*(.+)$/i;
const WIDE_LABEL = /\b1M\b/;
const CONTEXT_TAG = /\[context=[^\]]*\]$/;
// list-models repeats one slug for every context, so 500k is unlabeled
const MODEL_CONTEXTS = {
  'grok-4.7': ['256k', '500k'],
};
const JSON_KEYS = ['slug', 'id', 'model', 'modelID', 'name'];
const FAST = '-fast';
const THINKING = '-thinking';

const EFFORT_LEVELS = [
  'extra-high',
  'xhigh',
  'minimal',
  'medium',
  'none',
  'high',
  'max',
  'low',
];

const EFFORT_RANK = [
  'default',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'extra-high',
  'max',
];

const textLines = (text) => {
  const lines = [];
  for (const raw of stripAnsi(`${text ?? ''}`).split('\n')) {
    const line = raw.trim();
    if (line) lines.push(line);
  }
  return lines;
};

const uniqueNames = (names) => {
  const unique = new Set();
  for (const raw of names) {
    const name = trimText(raw);
    if (name) unique.add(name);
  }
  return [...unique];
};

const parseNameList = (text) => {
  const names = [];
  for (const line of textLines(text)) {
    const token = line.split(/\s+/)[0].replace(/:+$/, '');
    if (MODEL_ID.test(token) && !SKIP_TOKEN.test(token)) names.push(token);
  }
  return uniqueNames(names);
};

const parseCursorModels = (text) => {
  const names = [];
  for (const line of textLines(text)) {
    if (CURSOR_NOISE.test(line)) continue;
    const listed = AVAILABLE_LINE.exec(line);
    const row = listed ? null : CURSOR_ROW.exec(line);
    if (listed) names.push(...listed[1].split(','));
    else if (row) names.push(row[1]);
  }
  return names.length ? uniqueNames(names) : parseNameList(text);
};

const parseCursorWide = (text) => {
  const names = [];
  for (const line of textLines(text)) {
    const row = CURSOR_ROW.exec(line);
    if (row && WIDE_LABEL.test(line)) names.push(row[1]);
  }
  return uniqueNames(names);
};

const jsonStart = (text) => {
  const starts = [text.indexOf('{'), text.indexOf('[')].filter((at) => at >= 0);
  return starts.length ? Math.min(...starts) : -1;
};

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const jsonModelId = (value) => {
  for (const key of JSON_KEYS) {
    const id = value[key];
    if (typeof id === 'string' && id.trim()) return id.trim();
  }
  return '';
};

const collectJsonIds = (value, names) => {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') names.push(item);
      else collectJsonIds(item, names);
    }
    return names;
  }
  if (!value || typeof value !== 'object') return names;
  const id = jsonModelId(value);
  if (id) names.push(id);
  if (value.models) collectJsonIds(value.models, names);
  if (value.data) collectJsonIds(value.data, names);
  return names;
};

const parseJsonModels = (text) => {
  const plain = stripAnsi(`${text ?? ''}`);
  const start = jsonStart(plain);
  const data = start < 0 ? null : parseJson(plain.slice(start));
  const names = collectJsonIds(data, []);
  return names.length ? uniqueNames(names) : parseNameList(plain);
};

const mergeModels = (fallback, listed) =>
  uniqueNames(['default'].concat(listed || [], fallback || []));

const cutSuffix = (name, suffix) => {
  if (!name.endsWith(suffix) || name.length <= suffix.length) return '';
  return name.slice(0, -suffix.length);
};

const withoutFast = (name) => cutSuffix(name, FAST) || name;

const effortTail = (name) => {
  for (const level of EFFORT_LEVELS) {
    const base = cutSuffix(name, `-${level}`);
    if (base) return { base, level };
  }
  return null;
};

const hasFastTail = (name) => {
  const unfast = cutSuffix(name, FAST);
  if (!unfast) return false;
  const unthink = cutSuffix(unfast, THINKING);
  return Boolean(effortTail(unfast) || (unthink && effortTail(unthink)));
};

const splitEffortModel = (id) => {
  const name = trimText(id);
  if (!name) return null;
  const fast = hasFastTail(name);
  let rest = fast ? cutSuffix(name, FAST) : name;
  let thinking = '';
  const unthink = cutSuffix(rest, THINKING);
  if (unthink && effortTail(unthink)) {
    rest = unthink;
    thinking = 'after';
  }
  const hit = effortTail(rest);
  if (!hit) return null;
  const before = cutSuffix(hit.base, THINKING);
  if (before) thinking = 'before';
  const base = before || hit.base;
  return { base, effort: hit.level, thinking, fast, id: name };
};

const contextFamily = (model) => {
  const raw = `${model ?? ''}`.replace(CONTEXT_TAG, '').trim();
  const base = withoutFast(raw);
  const part = splitEffortModel(base);
  return part ? part.base : base;
};

const contextMenu = (model, wide, catalog, fallback) => {
  const sizes = [];
  for (const size of fallback ?? []) {
    const text = trimText(size);
    if (text && text !== 'default') sizes.push(text);
  }
  if (!sizes.length) return [];
  const named = MODEL_CONTEXTS[contextFamily(model)];
  if (named) return named.slice();
  if (!trimText(model) || catalog.hasWide(wide, model)) return sizes;
  return sizes.filter((size) => size !== '1m');
};

const modelLabel = (part) => {
  const thinking = part.thinking ? THINKING : '';
  return `${part.base}${thinking}${part.fast ? FAST : ''}`;
};

const groupKey = (part) =>
  `${part.base}\0${part.thinking}\0${part.fast ? 'fast' : ''}`;

const rankedLevels = (ids) => {
  const levels = EFFORT_RANK.filter((level) => ids.has(level));
  for (const level of ids.keys()) {
    if (!levels.includes(level)) levels.push(level);
  }
  return levels;
};

const groupEntry = (group) => ({
  model: group.model,
  encoded: true,
  levels: rankedLevels(group.ids),
  ids: group.ids,
});

const plainEntry = (name) => ({
  model: name,
  encoded: false,
  levels: [],
  ids: new Map([['default', name]]),
});

const defaultGroup = (groups, name) => {
  const direct = groups.get(`${name}\0\0`);
  if (direct && !direct.ids.has('default')) return direct;
  for (const group of groups.values()) {
    if (group.model === name && !group.ids.has('default')) return group;
  }
  return null;
};

const groupModels = (ids) => {
  const names = uniqueNames(ids ?? []);
  const groups = new Map();
  const owners = new Map();
  const plain = [];
  for (const name of names) {
    const part = splitEffortModel(name);
    if (!part) {
      plain.push(name);
      continue;
    }
    const key = groupKey(part);
    if (!groups.has(key)) {
      groups.set(key, { model: modelLabel(part), ids: new Map() });
    }
    const group = groups.get(key);
    if (!group.ids.has(part.effort)) group.ids.set(part.effort, name);
    owners.set(name, group);
  }
  for (const name of plain) {
    const group = defaultGroup(groups, name);
    if (!group) continue;
    group.ids.set('default', name);
    owners.set(name, group);
  }
  const entries = [];
  const listed = new Set();
  for (const name of names) {
    const group = owners.get(name) ?? null;
    const slot = group ?? name;
    if (listed.has(slot)) continue;
    listed.add(slot);
    entries.push(group ? groupEntry(group) : plainEntry(name));
  }
  return entries;
};

const fitEffort = (levels, effort) => {
  const want = trimText(effort) || 'default';
  if (!levels || !levels.length) return 'default';
  if (levels.includes(want)) return want;
  const named = levels.find((level) => {
    const name = trimText(level);
    return name && name !== 'default';
  });
  return named ?? levels[0];
};

const plainResolved = (model, effort) => ({
  model,
  encoded: false,
  effort,
  family: model,
  levels: [],
});

const entryResolved = (entry, effort) => {
  if (!entry.encoded) return plainResolved(entry.model, effort);
  const level = fitEffort(entry.levels, effort);
  return {
    model: entry.ids.get(level) ?? entry.model,
    encoded: true,
    effort: level,
    family: entry.model,
    levels: entry.levels,
  };
};

const entryNames = (entry) => [entry.model, ...entry.ids.values()];

class ModelCatalog {
  constructor(ids) {
    this.entries = groupModels(ids);
    this.byName = new Map();
    for (const entry of this.entries) {
      if (!this.byName.has(entry.model)) this.byName.set(entry.model, entry);
    }
  }

  find(name) {
    return this.byName.get(name) ?? null;
  }

  hasFast() {
    return this.entries.some((entry) => entry.model.endsWith(FAST));
  }

  prefixed(entry, name) {
    if (entry && entry.encoded) return null;
    const base = withoutFast(entry ? entry.model : trimText(name));
    if (!base || base.startsWith('cursor-')) return null;
    const found = this.find(`cursor-${base}`);
    return found && found.encoded ? found : null;
  }

  resolve(choice) {
    const effort = trimText(choice.effort) || 'default';
    const entry = this.find(choice.model);
    const prefixed = this.prefixed(entry, choice.model);
    if (prefixed) return entryResolved(prefixed, effort);
    if (entry) return entryResolved(entry, effort);
    const part = splitEffortModel(choice.model);
    const family = part ? this.find(modelLabel(part)) : null;
    if (!family) return plainResolved(choice.model, effort);
    return entryResolved(family, effort === 'default' ? part.effort : effort);
  }

  withFast(resolved, fast) {
    const family = `${resolved.family ?? ''}`;
    const onFast = family.endsWith(FAST);
    if (!family || (fast === true) === onFast) return resolved;
    const other = onFast ? withoutFast(family) : `${family}${FAST}`;
    const entry = this.find(other);
    return entry ? entryResolved(entry, resolved.effort) : resolved;
  }

  hasWide(wide, model) {
    if (!(wide instanceof Set)) return true;
    const raw = `${model ?? ''}`.replace(CONTEXT_TAG, '');
    const base = withoutFast(raw);
    if (!base || base === 'default') return true;
    if (wide.has(raw) || wide.has(base)) return true;
    const wanted = new Set([base, `${base}${FAST}`, raw]);
    return this.entries.some((entry) => {
      const names = entryNames(entry);
      if (!names.some((name) => wanted.has(name))) return false;
      return names.some((name) => wide.has(name));
    });
  }
}

const EMPTY_CATALOG = new ModelCatalog([]);
const catalogs = new WeakMap();

const catalogOf = (models) => {
  if (!Array.isArray(models)) return EMPTY_CATALOG;
  if (!catalogs.has(models)) catalogs.set(models, new ModelCatalog(models));
  return catalogs.get(models);
};

const emptyChoice = (row) => ({
  model: row && row.models && row.models[0] ? row.models[0] : 'default',
  effort: 'default',
  extra: '',
  fast: false,
  context: '',
});

module.exports = {
  catalogOf,
  parseNameList,
  parseCursorModels,
  parseCursorWide,
  parseJsonModels,
  mergeModels,
  contextMenu,
  groupModels,
  fitEffort,
  withoutFast,
  emptyChoice,
};
