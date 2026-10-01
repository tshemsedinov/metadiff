'use strict';

const commands = require('../npm-commands.js');
const { formatTable } = commands;
const reportRender = require('../report-render.js');
const { summaryRows, problemRows, displayMessage, quoteLines } = reportRender;

const reportProblem = (item) => {
  const title = item.name || item.message || item.code || 'problem';
  const mark = item.severity === 'warning' ? '△' : '✖';
  const count = item.count > 1 ? `  × ${item.count}` : '';
  const lines = ['', `${mark} ${title.split('\n')[0]}${count}`, ''];
  lines.push(...formatTable(problemRows(item)));
  const message = displayMessage(item);
  if (message) lines.push('', ...quoteLines(message));
  if (item.trace) {
    lines.push('', 'Stack');
    for (const row of item.trace.split(/\r?\n/)) {
      const frame = row.trim().replace(/^at\s+/, '');
      if (frame) lines.push(`  at ${frame}`);
    }
  }
  if (item.related.length) {
    lines.push('', 'Related failures');
    for (const row of item.related) lines.push(`  ↳ ${row}`);
  }
  return lines;
};

const renderReport = (doc) => {
  const lines = [];
  for (const item of doc.reports) {
    if (lines.length) lines.push('');
    const mark = item.ok ? '✔' : '✖';
    lines.push(`${mark} ${item.tool}  ·  exit ${doc.exit}`, '');
    lines.push(...formatTable(summaryRows(item.summary)));
    for (const entry of item.problems) lines.push(...reportProblem(entry));
  }
  if (doc.stderr) lines.push('', 'Stderr', doc.stderr);
  return `${lines.join('\n')}\n`;
};

module.exports = { renderReport };
