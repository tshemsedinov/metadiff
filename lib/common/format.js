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

const shortAge = (text) => {
  const raw = trimText(text);
  if (/^yesterday$/i.test(raw)) return '1d ago';
  const match = AGE_AGO.exec(raw);
  if (match) return shortUnit(match[1], match[2].toLowerCase());
  const brief = AGE_SHORT.exec(raw);
  if (brief) return `${brief[1]}${brief[2].toLowerCase()} ago`;
  return raw;
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

module.exports = { shortAge, relativeAge, num, size, ago, duration };
