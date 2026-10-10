'use strict';

const { isHashObject } = require('metautil');

const models = require('../../agents/models.js');
const { catalogOf, fitEffort, withoutFast, contextMenu } = models;

const RESTORED_FIELDS = ['model', 'effort', 'context'];

const concrete = (name) => {
  const text = `${name ?? ''}`.trim();
  return text === 'default' ? '' : text;
};

const menuNames = (catalog) => {
  const names = catalog.entries.map((entry) => concrete(entry.model));
  const known = new Set(names);
  const shown = names.filter((name) => {
    const base = withoutFast(name);
    return name && (name === base || !known.has(base));
  });
  return [...new Set(shown)];
};

class AgentOptions {
  constructor(row) {
    this.row = row;
    this.catalog = catalogOf(row.models);
    this.names = menuNames(this.catalog);
  }

  shown(model) {
    const saved = concrete(model);
    const base = withoutFast(saved);
    if (this.names.includes(base)) return base;
    if (this.names.includes(saved)) return saved;
    return this.names[0] || '';
  }

  levels(model) {
    const resolved = this.catalog.resolve({ model, effort: 'default' });
    return resolved.encoded ? resolved.levels : this.row.spec.efforts;
  }

  efforts(model) {
    return this.levels(model).filter((level) => concrete(level));
  }

  contexts(model) {
    return contextMenu(
      model,
      this.row.wide,
      this.catalog,
      this.row.spec.contexts,
    );
  }

  hasFast(model) {
    const base = withoutFast(concrete(model));
    return Boolean(base) && this.catalog.find(`${base}-fast`) !== null;
  }

  firstModel(accept) {
    return this.names.find(accept) ?? '';
  }

  fitContext(model, context) {
    const want = concrete(context);
    if (!want) return '';
    const sizes = this.contexts(model);
    return sizes.includes(want) ? want : sizes[0] || '';
  }

  align(picked, model = '') {
    const shown = model || this.shown(picked.model);
    const basis = concrete(picked.model) || shown;
    picked.effort = fitEffort(this.levels(basis), picked.effort);
    picked.context = this.fitContext(shown, picked.context);
    const lost = this.catalog.hasFast() && !this.hasFast(shown);
    if (picked.fast && lost) picked.fast = false;
    return shown;
  }

  normalize(picked, model = '') {
    picked.model = this.catalog.resolve(picked).family;
    return this.align(picked, model || this.shown(picked.model));
  }

  preferEffort(picked, level) {
    if (concrete(picked.effort)) return;
    if (this.efforts(picked.model).includes(level)) picked.effort = level;
  }

  pickModel(picked, model) {
    picked.model = model;
    this.align(picked, model);
  }

  pickContext(picked, size) {
    picked.context = size;
    const offers = (model) => this.contexts(model).includes(size);
    if (!offers(this.shown(picked.model))) {
      picked.model = this.firstModel(offers) || picked.model;
    }
    const model = this.shown(picked.model);
    this.align(picked, model);
    if (offers(model)) picked.context = size;
  }

  toggleFast(picked) {
    picked.fast = picked.fast !== true;
    const shown = this.shown(picked.model);
    const missing = this.catalog.hasFast() && !this.hasFast(shown);
    if (picked.fast && missing) {
      const next = this.firstModel((name) => this.hasFast(name));
      if (next) picked.model = next;
      else picked.fast = false;
    }
    this.align(picked, this.shown(picked.model));
  }
}

const restoreChoice = (picked, saved) => {
  if (!isHashObject(saved)) return;
  for (const field of RESTORED_FIELDS) {
    const value = concrete(saved[field]);
    if (value) picked[field] = value;
  }
  if (saved.fast === true) picked.fast = true;
};

const storedChoice = (picked) => {
  const fields = [
    ['model', concrete(picked.model)],
    ['effort', concrete(picked.effort)],
    ['fast', picked.fast === true],
    ['context', concrete(picked.context)],
  ];
  const stored = Object.fromEntries(fields.filter((field) => field[1]));
  return Object.keys(stored).length ? stored : null;
};

module.exports = { AgentOptions, concrete, restoreChoice, storedChoice };
