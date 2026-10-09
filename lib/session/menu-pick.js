'use strict';

const { Editor } = require('../editor.js');

const MENU_ROWS = 8;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const menuRows = (bodyH, fraction = 1) => {
  const height = Math.min(bodyH > 0 ? bodyH : MENU_ROWS, MENU_ROWS);
  return Math.max(1, Math.floor(height * fraction));
};

const pickDelta = (key, page, half) => {
  const steps = {
    up: -1,
    down: 1,
    pageUp: -page,
    pageDown: page,
    'ctrl-b': -page,
    'ctrl-f': page,
    'ctrl-u': -half,
    'ctrl-d': half,
    home: -Infinity,
    end: Infinity,
  };
  return Object.hasOwn(steps, key) ? steps[key] : 0;
};

class MenuPick {
  constructor(field, cursor) {
    this.field = field;
    this.cursor = cursor;
    this.scroll = 0;
    this.editor = new Editor('');
  }

  get query() {
    return this.editor.text;
  }

  filter(items) {
    const query = this.query.trim().toLowerCase();
    if (!query) return items;
    return items.filter((name) => name.toLowerCase().includes(query));
  }

  touch() {
    this.cursor = 0;
    this.scroll = 0;
  }

  move(delta, items, isOff) {
    const last = items.length - 1;
    const step = delta < 0 ? -1 : 1;
    const goal = clamp(this.cursor + delta, 0, last);
    let cursor = this.cursor;
    for (let next = cursor; next !== goal;) {
      next += step;
      if (!isOff(items[next])) cursor = next;
    }
    if (isOff(items[cursor])) {
      let scan = goal;
      while (scan >= 0 && scan <= last && isOff(items[scan])) scan += step;
      if (scan >= 0 && scan <= last) cursor = scan;
    }
    this.cursor = cursor;
  }
}

module.exports = { menuRows, pickDelta, MenuPick };
