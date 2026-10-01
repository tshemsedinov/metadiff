'use strict';

const core = require('./core.js');
const { emit, highlightLines, wordStyles } = core;

const LOG_DATETIME_RE = new RegExp(
  '^(\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}' +
    '(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?)',
);

const LOG_TAG_RE = /^(\s*)(\[[^\]]+\])/;

const LOG_TAG_STYLE = wordStyles({
  logError: ['error', 'err'],
  logWarn: ['warn', 'warning'],
  logInfo: ['info'],
  logDebug: ['debug'],
});

const highlightLogLine = (line) => {
  const out = [];
  let rest = line;
  const date = LOG_DATETIME_RE.exec(rest);
  if (date) {
    emit(out, 'logDate', date[1]);
    rest = rest.slice(date[1].length);
  }
  const tag = LOG_TAG_RE.exec(rest);
  if (tag) {
    emit(out, 'plain', tag[1]);
    const name = tag[2].slice(1, -1).toLowerCase();
    emit(out, LOG_TAG_STYLE[name] || 'plain', tag[2]);
    rest = rest.slice(tag[0].length);
  }
  const columns = rest.split('\t');
  for (let i = 0; i < columns.length; i += 1) {
    if (i) emit(out, 'plain', '\t');
    emit(out, `logCol${i}`, columns[i]);
  }
  return out;
};

module.exports = {
  langs: ['log'],
  highlight: highlightLines(highlightLogLine),
};
