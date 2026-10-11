'use strict';

const { bytesToSize } = require('metautil');
const { trimText, pad2 } = require('./utilities.js');

const AGE_UNIT = {
  second: 's',
  minute: 'm',
  hour: 'h',
  day: 'd',
  week: 'w',
  month: 'mo',
  year: 'y',
};
const AGE_AGO = /^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i;
const AGE_SHORT = /^(\d+)(mo|[smhdwy])(?: ago)?$/i;
const SECONDS_AGO = /^\d+s ago$/;

const shortUnit = (n, unit) => `${n}${AGE_UNIT[unit]} ago`;

const AGE_SEC = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
  mo: 2592000,
  y: 31536000,
};

const ageParts = (text) => {
  const raw = trimText(text);
  if (/^yesterday$/i.test(raw)) return { count: 1, unit: 'd' };
  const long = AGE_AGO.exec(raw);
  if (long) return { count: long[1], unit: AGE_UNIT[long[2].toLowerCase()] };
  const brief = AGE_SHORT.exec(raw);
  if (brief) return { count: brief[1], unit: brief[2].toLowerCase() };
  return null;
};

const shortAge = (text) => {
  const age = ageParts(text);
  return age ? `${age.count}${age.unit} ago` : trimText(text);
};

const ageSeconds = (text) => {
  const age = ageParts(text);
  if (!age) return Number.POSITIVE_INFINITY;
  return Number(age.count) * AGE_SEC[age.unit];
};

const relativeAge = (thenMs, nowMs = Date.now()) => {
  const diff = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (diff < 90) return shortUnit(diff, 'second');
  const minutes = Math.round(diff / 60);
  if (minutes < 90) return shortUnit(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 36) return shortUnit(hours, 'hour');
  const days = Math.round(hours / 24);
  if (days < 14) return shortUnit(days, 'day');
  if (days < 70) return shortUnit(Math.round(days / 7), 'week');
  if (days < 365) return shortUnit(Math.round(days / 30), 'month');
  return shortUnit(Math.round(days / 365), 'year');
};

const trimmed = (value) =>
  value >= 10 ? `${Math.round(value)}` : `${Math.round(value * 10) / 10}`;

const num = (value) => {
  const n = Math.max(0, Math.round(value));
  if (n >= 1e6) return `${trimmed(n / 1e6)}m`;
  if (n >= 1e4) return `${trimmed(n / 1e3)}k`;
  return `${n}`;
};

const size = (bytes) => bytesToSize(bytes > 0 ? bytes : 0);

const ago = (at, now) => {
  if (!at) return '';
  const text = relativeAge(at, now);
  return SECONDS_AGO.test(text) ? '<1m ago' : text;
};

const duration = (ms) => {
  const value = Math.max(0, ms);
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60000) return `${(value / 1000).toFixed(1)}s`;
  const minutes = Math.floor(value / 60000);
  const seconds = Math.floor((value % 60000) / 1000);
  return `${minutes}m${pad2(seconds)}s`;
};

module.exports = {
  shortAge,
  ageSeconds,
  relativeAge,
  num,
  size,
  ago,
  duration,
};
