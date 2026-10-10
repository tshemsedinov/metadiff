'use strict';

const BUSY_MARK = 'ctrl+c to stop';
const FOLLOW_UP = 'Add a follow-up';
const FILES_EDITED = /(\d[\d,]*)\s+files?\s+edited/i;

const sawWork = (text) => {
  const body = `${text ?? ''}`;
  if (body.includes(BUSY_MARK)) return true;
  const match = FILES_EDITED.exec(body);
  if (!match) return false;
  const count = Number(match[1].replaceAll(',', ''));
  return count > 0;
};

const DECISION_TITLES = [
  'Run this command outside the sandbox?',
  'Run this command?',
  'Run this MCP tool?',
  'Delete this file?',
  'Write to this file?',
  'Read this file?',
  'Allow this web search?',
  'Allow this web fetch?',
  'Proceed with this edit?',
  'Approve mode switch',
  'Waiting for decision',
];

const pendingKind = (text) => {
  const body = `${text ?? ''}`;
  if (!body.trim()) return '';
  if (body.includes('empty to skip') || body.includes('Enter to send')) {
    return 'text';
  }
  if (body.includes('Edit the image prompt')) return 'text';
  if (body.includes('Describe how to revise')) return 'text';
  if (body.includes('Answer questions (')) return 'question';
  for (const title of DECISION_TITLES) {
    if (body.includes(title)) return 'decision';
  }
  if (body.includes(FOLLOW_UP) && !body.includes(BUSY_MARK)) return 'idle';
  return '';
};

const agentBusy = (text, kind) => {
  if (kind === 'decision' || kind === 'question' || kind === 'text') {
    return true;
  }
  return `${text ?? ''}`.includes(BUSY_MARK);
};

const requestTitle = (text) => {
  const body = `${text ?? ''}`;
  for (const title of DECISION_TITLES) {
    if (body.includes(title)) return title.replace(/\?$/, '');
  }
  if (pendingKind(body) === 'question') return 'Answer questions';
  if (pendingKind(body) === 'text') return 'Reply to the agent';
  return 'Approval';
};

const HINTS = {
  decision: 'y once   a always   n reject',
  question: 'arrows select   enter next   esc skip   ctrl-q log',
  text: 'type a reply   enter send   esc cancel   ctrl-q log',
};

const pendingHint = (kind) => HINTS[kind] || '';

const NAV_BYTES = {
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  enter: '\r',
  escape: '\x1b',
  tab: '\t',
  backspace: '\x7f',
};

const DECISION_BYTES = {
  y: 'y',
  Y: 'Y',
  n: 'n',
  N: 'N',
  p: 'p',
  P: 'P',
  a: '\t',
  A: '\t',
  tab: '\t',
  enter: '\r',
};

const answerBytes = (key, kind) => {
  if (kind === 'decision') return DECISION_BYTES[key] ?? null;
  if (kind !== 'question' && kind !== 'text') return null;
  if (NAV_BYTES[key]) return NAV_BYTES[key];
  if (key.length === 1) return key;
  return null;
};

const remembersAnswer = (key) => key === 'a' || key === 'A' || key === 'tab';

const PERMISSION = /\b(Shell|Write|Read|Delete|Mcp|WebFetch)\(([^)\n]+)\)/g;

const permissionTokens = (text) => {
  const found = [];
  const body = `${text ?? ''}`;
  for (const match of body.matchAll(PERMISSION)) {
    const token = `${match[1]}(${match[2].trim()})`;
    if (!found.includes(token)) found.push(token);
  }
  return found;
};

const shellBin = (token) => {
  const match = /^Shell\((.*)\)$/.exec(token);
  if (!match) return '';
  return match[1].split(/\s+/)[0] || '';
};

const rememberedTokens = (tokens) => {
  const out = [];
  const add = (token) => {
    if (token && !out.includes(token)) out.push(token);
  };
  for (const token of tokens) {
    add(token);
    const bin = shellBin(token);
    if (bin === 'npm' || bin === 'npx' || bin === 'node' || bin === 'reslop') {
      add(`Shell(${bin})`);
    }
    const write = /^Write\((.*)\)$/.exec(token);
    if (!write) continue;
    const file = write[1].replaceAll('\\', '/');
    if (!file.includes('.plan/') || !file.endsWith('.md')) continue;
    add('Write(.plan/**/*.md)');
    add('Write(**/.plan/**/*.md)');
  }
  return out;
};

module.exports = {
  pendingKind,
  sawWork,
  agentBusy,
  pendingHint,
  requestTitle,
  answerBytes,
  remembersAnswer,
  permissionTokens,
  rememberedTokens,
};
