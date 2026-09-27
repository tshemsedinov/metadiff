'use strict';

const actions = require('./session/actions.js');

const { ACTIONS, ACTION_IDS, BRANCH_ACTIONS, COMMIT_ACTIONS } = actions;
const { DIFF_DISABLED, FILES_DISABLED, FILES_GIT_DISABLED } = actions;
const { FILES_HIDDEN, FILES_TODO_DISABLED } = actions;
const { TODO_DISABLED, BRANCHES_DISABLED } = actions;
const { COMMITS_DISABLED, UNIT_DISABLED, NPM_DISABLED } = actions;
const { disabledActions, diffGitDisabled, branchGitDisabled } = actions;
const { commitGitDisabled } = actions;
const { actionFromKey, actionHot, actionLetter, buttonWord } = actions;
const { CONFIRM, CONFIRM_MODE, confirmKey, applyConfirm } = actions;
const { confirmPrefix, promptFromChoices } = actions;

const CSI_KEYS = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
};

const CSI_TILDE = {
  1: 'home',
  3: 'delete',
  4: 'end',
  5: 'pageUp',
  6: 'pageDown',
  7: 'home',
  8: 'end',
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

const parseCsiSeq = (rest) => {
  const body = rest.slice(2);
  let i = 0;
  while (i < body.length) {
    const code = body.charCodeAt(i);
    if (code >= 64 && code <= 126) break;
    i += 1;
  }
  if (i >= body.length) {
    if (rest.length > CSI_MAX) {
      return { event: { type: 'key', key: 'escape' }, eat: 1 };
    }
    return { needMore: true };
  }
  return { params: body.slice(0, i), final: body[i], eat: 2 + i + 1 };
};

const ctrlHeld = (modText) => {
  const mod = parseInt(modText, 10);
  return Number.isFinite(mod) && ((mod - 1) & 4) !== 0;
};

const keyFromCsi = (paramsText, final) => {
  const params = paramsText ? paramsText.split(';') : [];
  if (final === '~') return CSI_TILDE[params[0]] ?? null;
  const base = CSI_KEYS[final];
  if (!base) return null;
  if (params.length < 2) return base;
  const arrow =
    base === 'left' || base === 'right' || base === 'up' || base === 'down';
  if (ctrlHeld(params[1]) && arrow) return `ctrl-${base}`;
  return base;
};

const mouseKindFromButton = (button, press) => {
  const wheel = MOUSE_WHEEL[button];
  if (wheel) return wheel;
  if (!press) return 'release';
  if (button & 32) return 'drag';
  return 'press';
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
  const kind = mouseKindFromButton(button, press);
  return { type: 'mouse', button, x, y, press, kind, btn: button & 3 };
};

const parseEsc = (text, start) => {
  const rest = text.slice(start);
  if (rest === '\x1b') return { needMore: true };
  if (rest.startsWith('\x1b[') && rest.length === 2) return { needMore: true };
  if (rest.startsWith('\x1b[<')) {
    const endM = rest.search(/[Mm]/);
    if (endM < 0) return { needMore: true };
    const kind = rest[endM];
    const body = rest.slice(3, endM);
    const mouse = parseMouse(body, kind);
    if (!mouse) {
      return { event: { type: 'key', key: 'escape' }, end: start + endM + 1 };
    }
    return { event: mouse, end: start + endM + 1 };
  }
  if (rest.startsWith('\x1b[')) {
    const csi = parseCsiSeq(rest);
    if (csi.needMore) return csi;
    if (csi.event) return { event: csi.event, end: start + csi.eat };
    const key = keyFromCsi(csi.params, csi.final);
    if (key) return { event: { type: 'key', key }, end: start + csi.eat };
    return { event: { type: 'key', key: 'escape' }, end: start + 1 };
  }
  if (rest.startsWith('\x1bO')) {
    if (rest.length < 3) return { needMore: true };
    const key = CSI_KEYS[rest[2]];
    if (key) return { event: { type: 'key', key }, end: start + 3 };
    return { event: { type: 'key', key: 'escape' }, end: start + 1 };
  }
  return { event: { type: 'key', key: 'escape' }, end: start + 1 };
};

const decodeChunk = (text, carry = '') => {
  const source = carry + text;
  const events = new Array(source.length);
  let n = 0;
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\x1b') {
      const parsed = parseEsc(source, i);
      if (parsed.needMore) {
        events.length = n;
        return { events, carry: source.slice(i) };
      }
      events[n++] = parsed.event;
      i = parsed.end;
      continue;
    }
    const named = LITERAL_KEY[ch];
    if (named) {
      events[n++] = { type: 'key', key: named };
      i += 1;
      continue;
    }
    const code = source.charCodeAt(i);
    if (code >= 1 && code <= 26) {
      const letter = String.fromCharCode(96 + code);
      events[n++] = { type: 'key', key: `ctrl-${letter}` };
      i += 1;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < source.length) {
      events[n++] = { type: 'key', key: source.slice(i, i + 2) };
      i += 2;
      continue;
    }
    events[n++] = { type: 'key', key: ch };
    i += 1;
  }
  events.length = n;
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
  BRANCH_ACTIONS,
  COMMIT_ACTIONS,
  DIFF_DISABLED,
  FILES_DISABLED,
  FILES_HIDDEN,
  FILES_GIT_DISABLED,
  FILES_TODO_DISABLED,
  TODO_DISABLED,
  BRANCHES_DISABLED,
  COMMITS_DISABLED,
  NPM_DISABLED,
  UNIT_DISABLED,
  disabledActions,
  diffGitDisabled,
  branchGitDisabled,
  commitGitDisabled,
  decodeChunk,
  actionFromKey,
  actionHot,
  actionLetter,
  buttonWord,
  hitAction,
  CONFIRM,
  CONFIRM_MODE,
  confirmKey,
  applyConfirm,
  confirmPrefix,
  promptFromChoices,
};
