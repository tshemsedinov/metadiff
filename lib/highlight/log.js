'use strict';

const core = require('./core.js');
const { emit } = core;

const LOG_DATETIME_RE = new RegExp(
  '^(\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}' +
    '(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?)',
);

const LOG_TAG_STYLE = {
  error: 'logError',
  err: 'logError',
  warn: 'logWarn',
  warning: 'logWarn',
  info: 'logInfo',
  debug: 'logDebug',
  log: 'plain',
};

const highlightLogLine = (line) => {
  if (!line) return [];
  const out = [];
  let rest = line;
  const dm = rest.match(LOG_DATETIME_RE);
  if (dm) {
    emit(out, 'logDate', dm[1]);
    rest = rest.slice(dm[1].length);
  }
  const tag = rest.match(/^(\s*)(\[[^\]]+\])/);
  if (tag) {
    emit(out, 'plain', tag[1]);
    const name = tag[2].replace(/^\[|\]$/g, '').toLowerCase();
    emit(out, LOG_TAG_STYLE[name] || 'plain', tag[2]);
    rest = rest.slice(tag[0].length);
  }
  if (rest.includes('\t')) {
    const parts = rest.split('\t');
    for (let i = 0; i < parts.length; i += 1) {
      if (i) emit(out, 'plain', '\t');
      emit(out, `logCol${i}`, parts[i]);
    }
    return out;
  }
  if (rest) emit(out, 'logCol0', rest);
  return out;
};

const highlight = (source) => {
  const lines = source.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (i) emit(out, 'plain', '\n');
    for (const t of highlightLogLine(lines[i])) out.push(t);
  }
  return out;
};

module.exports = { langs: ['log'], highlight };
