'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { split, jsonParse } = require('metautil');

const parseVersion = (text) => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(`${text ?? ''}`);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return { major, minor, patch };
};

const cmpVersion = (left, right) =>
  left.major - right.major ||
  left.minor - right.minor ||
  left.patch - right.patch;

const toInt = (text) => parseInt(text, 10);

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const resource = (dir, name) => fs.readFileSync(path.join(dir, name), 'utf8');

const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

const readJson = (file) => jsonParse(readText(file));

const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
};

const listDir = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

const trimText = (value) => `${value ?? ''}`.trim();

const oneLine = (text, fallback = '') =>
  split(`${text ?? ''}`.trim(), '\n')[0] || fallback;

const withNewline = (text) => {
  const body = `${text ?? ''}`;
  return !body || body.endsWith('\n') ? body : `${body}\n`;
};

const withNotice = (text, notice) => {
  const body = `${text ?? ''}`;
  if (body.endsWith(`${notice}\n`)) return body;
  return `${withNewline(body)}${notice}\n`;
};

const asText = (value) => (typeof value === 'string' ? value : '');

const unquote = (value) => {
  const text = `${value ?? ''}`;
  if (text.length < 2) return text;
  const open = text[0];
  const quoted = open === text.at(-1) && (open === '"' || open === '\x27');
  return quoted ? text.slice(1, -1) : text;
};

const pad2 = (n) => `${n}`.padStart(2, '0');

const dateStamp = (date) => {
  const month = pad2(date.getMonth() + 1);
  return `${date.getFullYear()}-${month}-${pad2(date.getDate())}`;
};

module.exports = {
  parseVersion,
  cmpVersion,
  toInt,
  clamp,
  resource,
  readText,
  readJson,
  writeJson,
  listDir,
  trimText,
  oneLine,
  asText,
  withNewline,
  withNotice,
  unquote,
  pad2,
  dateStamp,
};
