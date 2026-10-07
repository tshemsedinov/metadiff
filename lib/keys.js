'use strict';

const actions = require('./session/actions.js');

const { ACTIONS, ACTION_IDS, BRANCH_ACTIONS, COMMIT_ACTIONS } = actions;
const { DASH_IDS, DASH_HIDDEN } = actions;
const { DIFF_DISABLED, FILES_GIT_DISABLED, FILES_HIDDEN } = actions;
const { TASKS_DISABLED, BRANCHES_DISABLED } = actions;
const { COMMITS_DISABLED, UNIT_DISABLED, NPM_DISABLED } = actions;
const { AGENTS_DISABLED } = actions;
const { diffGitDisabled, branchGitDisabled, commitGitDisabled } = actions;
const { entryHasDiff, lineHasDiff, withoutMoves } = actions;
const { actionLetter, buttonWord } = actions;
const { CONFIRM, confirmPrefix, promptFromChoices } = actions;

const CSI_KEYS = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  Z: 'shift-tab',
};

const SS3_KEYS = {
  ...CSI_KEYS,
  P: 'f1',
  Q: 'f2',
  R: 'f3',
  S: 'f4',
};

const CSI_TILDE = {
  1: 'home',
  2: 'insert',
  3: 'delete',
  4: 'end',
  5: 'pageUp',
  6: 'pageDown',
  7: 'home',
  8: 'end',
  11: 'f1',
  12: 'f2',
  13: 'f3',
  14: 'f4',
  15: 'f5',
  17: 'f6',
  18: 'f7',
  19: 'f8',
  20: 'f9',
  21: 'f10',
  23: 'f11',
  24: 'f12',
};

const CSI_MAX = 16;

const LITERAL_KEY = {
  '\x7f': 'backspace',
  '\x08': 'backspace',
  '\t': 'tab',
  '\x03': 'ctrl-c',
  '\r': 'enter',
  '\n': 'enter',
};

const MOUSE_WHEEL = {
  64: 'wheelUp',
  65: 'wheelDown',
};

const NEED_MORE = { needMore: true };

const keyAt = (key, end) => ({ event: { type: 'key', key }, end });

const modifiedKey = (base, modText) => {
  const arrow =
    base === 'left' || base === 'right' || base === 'up' || base === 'down';
  const end = base === 'home' || base === 'end';
  if (!arrow && !end) return base;
  const mod = parseInt(modText, 10);
  const bits = Number.isFinite(mod) ? mod - 1 : 0;
  const ctrl = (bits & 4) !== 0;
  const shift = (bits & 1) !== 0;
  if (ctrl && shift && arrow) return `ctrl-shift-${base}`;
  if (ctrl && arrow) return `ctrl-${base}`;
  if (shift) return `shift-${base}`;
  return base;
};

const keyFromCsi = (paramsText, final) => {
  const params = paramsText ? paramsText.split(';') : [];
  const base = final === '~' ? CSI_TILDE[params[0]] : CSI_KEYS[final];
  if (!base) return null;
  if (params.length < 2) return base;
  return modifiedKey(base, params[1]);
};

const parseCsi = (rest, start) => {
  let i = 2;
  while (i < rest.length) {
    const code = rest.charCodeAt(i);
    if (code >= 64 && code <= 126) break;
    i += 1;
  }
  if (i >= rest.length) {
    return rest.length > CSI_MAX ? keyAt('escape', start + 1) : NEED_MORE;
  }
  const key = keyFromCsi(rest.slice(2, i), rest[i]);
  return key ? keyAt(key, start + i + 1) : keyAt('escape', start + 1);
};

const mouseKind = (button, press) => {
  const wheel = MOUSE_WHEEL[button];
  if (wheel) return wheel;
  if (!press) return 'release';
  return button & 32 ? 'drag' : 'press';
};

const parseMouse = (body, flag) => {
  const parts = body.split(';');
  if (parts.length < 3) return null;
  const button = parseInt(parts[0], 10);
  const x = parseInt(parts[1], 10);
  const y = parseInt(parts[2], 10);
  if (!Number.isFinite(button) || !Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  const press = flag === 'M';
  const kind = mouseKind(button, press);
  return { type: 'mouse', button, x, y, press, kind, btn: button & 3 };
};

const parseEsc = (text, start) => {
  const rest = text.slice(start);
  if (rest === '\x1b' || rest === '\x1b[') return NEED_MORE;
  if (rest.startsWith('\x1b[<')) {
    const endM = rest.search(/[Mm]/);
    if (endM < 0) return NEED_MORE;
    const mouse = parseMouse(rest.slice(3, endM), rest[endM]);
    const end = start + endM + 1;
    return mouse ? { event: mouse, end } : keyAt('escape', end);
  }
  if (rest.startsWith('\x1b[')) return parseCsi(rest, start);
  if (rest.startsWith('\x1bO')) {
    if (rest.length < 3) return NEED_MORE;
    const key = SS3_KEYS[rest[2]];
    return key ? keyAt(key, start + 3) : keyAt('escape', start + 1);
  }
  return keyAt('escape', start + 1);
};

const decodeChunk = (text, carry = '') => {
  const source = carry + text;
  const events = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\x1b') {
      const parsed = parseEsc(source, i);
      if (parsed.needMore) return { events, carry: source.slice(i) };
      events.push(parsed.event);
      i = parsed.end;
      continue;
    }
    const named = LITERAL_KEY[ch];
    const code = source.charCodeAt(i);
    if (named) {
      events.push({ type: 'key', key: named });
      i += 1;
      continue;
    }
    if (code >= 1 && code <= 26) {
      const letter = String.fromCharCode(96 + code);
      events.push({ type: 'key', key: `ctrl-${letter}` });
      i += 1;
      continue;
    }
    const isPair = code >= 0xd800 && code <= 0xdbff && i + 1 < source.length;
    const size = isPair ? 2 : 1;
    events.push({ type: 'key', key: source.slice(i, i + size) });
    i += size;
  }
  return { events, carry: '' };
};

const hitAction = (hits, x) => {
  for (const hit of hits) {
    if (x >= hit.x0 && x < hit.x1) return hit.id;
  }
  return null;
};

module.exports = {
  ACTIONS,
  ACTION_IDS,
  DASH_IDS,
  DASH_HIDDEN,
  BRANCH_ACTIONS,
  COMMIT_ACTIONS,
  DIFF_DISABLED,
  FILES_HIDDEN,
  FILES_GIT_DISABLED,
  TASKS_DISABLED,
  BRANCHES_DISABLED,
  COMMITS_DISABLED,
  NPM_DISABLED,
  AGENTS_DISABLED,
  UNIT_DISABLED,
  diffGitDisabled,
  entryHasDiff,
  lineHasDiff,
  withoutMoves,
  branchGitDisabled,
  commitGitDisabled,
  decodeChunk,
  actionLetter,
  buttonWord,
  hitAction,
  CONFIRM,
  confirmPrefix,
  promptFromChoices,
};
