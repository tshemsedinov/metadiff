'use strict';

const path = require('node:path');
const { stripAnsi, visibleWidth } = require('../term/ansi.js');
const utilities = require('../common/utilities.js');
const { unquote } = utilities;

const isPassingTest = (line) => {
  const plain = stripAnsi(line);
  const text = plain.trim();
  if (!text) return false;
  if (/^\s*[✔✓√] /.test(plain)) return true;
  if (/^ok \d+ /.test(text)) return true;
  return /^\s*PASS\b/.test(plain);
};

const indentStack = (line) => {
  if (!/^\s*at\s/.test(stripAnsi(line))) return line;
  return `  ${line.trimStart()}`;
};

const withoutNodeFrame = (line) => {
  const plain = stripAnsi(line);
  if (!plain.includes('(node:')) return line;
  return /\{\s*$/.test(plain) ? '{' : null;
};

const withSep = (dir) => {
  const sep = dir.includes('\\') ? '\\' : '/';
  if (dir.endsWith(sep)) return dir;
  return `${dir}${sep}`;
};

const stripOne = (text, dir) => {
  if (!dir) return text;
  let next = text.split(withSep(dir)).join('');
  if (next.includes(dir)) next = next.split(dir).join('.');
  return next;
};

const relativize = (text, root) => {
  if (!root) return text;
  const slash = root.replaceAll('\\', '/');
  const back = slash.replaceAll('/', '\\');
  const resolved = path.resolve(root).replaceAll('\\', '/');
  const resolvedBack = resolved.replaceAll('/', '\\');
  let next = text;
  for (const dir of [slash, back, resolved, resolvedBack]) {
    next = stripOne(next, dir);
  }
  return next;
};

const traceLine = (line, root) => {
  const next = withoutNodeFrame(line);
  if (next === null) return null;
  return relativize(indentStack(next), root);
};

const objectEnd = (lines, start) => {
  if (stripAnsi(lines[start]).trim() !== '{') return -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (stripAnsi(lines[i]).trim() === '}') return i;
  }
  return -1;
};

const parseInspect = (lines) => {
  const entries = [];
  for (const line of lines) {
    const plain = stripAnsi(line).trim().replace(/,$/, '');
    const match = /^([A-Za-z_][\w]*)\s*:\s*([\s\S]*)$/.exec(plain);
    if (!match) {
      if (!entries.length) return null;
      const last = entries[entries.length - 1];
      last[1] = `${last[1]}\n${plain}`;
      continue;
    }
    entries.push([match[1], unquote(match[2])]);
  }
  return entries.length ? entries : null;
};

const showValue = (value) => {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return `${value}`;
  }
  return JSON.stringify(value);
};

const parseObject = (lines) => {
  try {
    const value = JSON.parse(lines.join('\n'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const entries = Object.keys(value).map((key) => [
      key,
      showValue(value[key]),
    ]);
    return entries.length ? entries : null;
  } catch {
    return parseInspect(lines.slice(1, -1));
  }
};

const TABLE_KEY = '\x1b[900m';

const TABLE_VAL = '\x1b[901m';

const formatTable = (entries) => {
  const prepared = [];
  let keyWidth = 0;
  for (const entry of entries) {
    const lines = `${entry[1]}`.split('\n').filter((line) => line.trim());
    if (!lines.length) continue;
    prepared.push([entry[0], lines]);
    keyWidth = Math.max(keyWidth, visibleWidth(entry[0]));
  }
  const rows = [];
  for (const entry of prepared) {
    const lines = entry[1];
    for (let i = 0; i < lines.length; i++) {
      const name = i === 0 ? entry[0] : '';
      const pad = ' '.repeat(Math.max(0, keyWidth - visibleWidth(name)));
      const key = ` ${pad}${name} `;
      const value = ` ${lines[i]} `;
      rows.push(`${TABLE_KEY}${key}${TABLE_VAL}  ${value}`);
    }
  }
  return rows;
};

const foldObjects = (lines) => {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const end = objectEnd(lines, i);
    const entries = end < 0 ? null : parseObject(lines.slice(i, end + 1));
    if (!entries) {
      out.push(lines[i]);
      continue;
    }
    if (out.length && out[out.length - 1] !== '') out.push('');
    out.push(...formatTable(entries));
    i = end;
  }
  return out;
};

const reduceOutput = (text, root, status) => {
  const kept = [];
  for (const line of `${text ?? ''}`.split(/\r?\n/)) {
    if (isPassingTest(line)) continue;
    const next = traceLine(line, root);
    if (next !== null) kept.push(next);
  }
  const folded = foldObjects(kept);
  while (folded.length && folded[folded.length - 1] === '') folded.pop();
  if (status !== '') folded.push(`exit ${status ?? 'null'}`);
  if (!folded.length) return '';
  return `${folded.join('\n')}\n`;
};

module.exports = {
  isPassingTest,
  relativize,
  traceLine,
  TABLE_KEY,
  TABLE_VAL,
  formatTable,
  reduceOutput,
};
