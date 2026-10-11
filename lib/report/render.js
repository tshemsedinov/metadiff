'use strict';

const { unquote } = require('../common/utilities.js');
const { formatTable } = require('../runs/output.js');

const NOTICE_HEAD =
  'reslop: reduced output; passing results are omitted ' +
  'and similar problems are grouped';

const notice = (rawFile) => {
  const target = rawFile
    ? `the raw log \`.log/${rawFile}\``
    : 'the matching raw log under `.log/`';
  const hint = `Agent: if this report hides a needed detail, read ${target}.`;
  return `${NOTICE_HEAD}\n${hint}`;
};

const addRow = (rows, key, value) => {
  if (value === null || value === undefined || value === '') return;
  rows.push([key, `${value}`]);
};

const isComparison = (line) => {
  const match = /^(.*) (?:!==|===|!=|==) (\S.*)$/.exec(line.trim());
  return !!match && match[1].trim() !== '';
};

const isDiffHeader = (line) => {
  const text = line.trim().replace(/^[+-]\s*/, '');
  return /^actual\s+[+-]?\s*expected$/.test(text);
};

const isMarkedDiff = (line) => /^[+-](?:\s|$)/.test(line.trim());

const sameValue = (line, value) => {
  if (!value) return false;
  const text = line.trim();
  return text === value || unquote(text) === value;
};

const startsDiff = (line, item) =>
  isComparison(line) ||
  isDiffHeader(line) ||
  isMarkedDiff(line) ||
  sameValue(line, item.expected) ||
  sameValue(line, item.actual);

const displayMessage = (item) => {
  const values = item.expected !== '' || item.actual !== '';
  const lines = [];
  for (const line of `${item.message}`.split('\n')) {
    if (line.trim() === '') continue;
    if (values && startsDiff(line, item)) break;
    lines.push(line);
  }
  if (lines.length && lines[0].trimEnd().endsWith(':')) {
    lines[0] = lines[0].trimEnd().slice(0, -1);
  }
  if (lines.length && lines[0].trim() === '') lines.shift();
  return lines.join('\n');
};

const summaryRows = (stats) => {
  const rows = [];
  addRow(rows, 'passed', stats.passed);
  addRow(rows, 'failed', stats.failed);
  addRow(rows, 'skipped', stats.skipped);
  addRow(rows, 'errors', stats.errors);
  addRow(rows, 'warnings', stats.warnings);
  addRow(rows, 'duration', stats.duration);
  return rows;
};

const problemRows = (item) => {
  const rows = [];
  if (item.severity !== 'error') addRow(rows, 'severity', item.severity);
  addRow(rows, 'duration', item.duration);
  addRow(rows, 'code', item.code);
  addRow(rows, 'operator', item.operator);
  addRow(rows, 'expected', item.expected);
  addRow(rows, 'actual', item.actual);
  for (const pair of item.extra) addRow(rows, pair[0], pair[1]);
  if (item.count > 1) addRow(rows, 'count', item.count);
  if (item.omitted > 0) addRow(rows, 'omitted', item.omitted);
  return rows;
};

const prefixLines = (prefix, text) =>
  `${text}`
    .replace(/\n+$/, '')
    .split('\n')
    .map((line) => `${prefix}${line}`);

const quoteLines = (text) => prefixLines('│ ', text);

const markdownProblem = (item) => {
  const title = item.name || item.message || item.code || 'problem';
  const lines = ['', `## ${title}`, ''];
  for (const row of problemRows(item)) {
    const value = row[1].includes('\n') ? `\n${row[1]}` : row[1];
    lines.push(`- ${row[0]}: ${value}`);
  }
  const message = displayMessage(item);
  if (message) lines.push('', ...prefixLines('> ', message), '');
  if (item.trace) lines.push(`- trace:\n${item.trace}`);
  if (item.related.length) {
    lines.push('- related:');
    for (const row of item.related) lines.push(`  - ${row}`);
  }
  return lines;
};

const markdownReport = (item) => {
  const lines = ['', `# ${item.tool}`, '', `ok: ${item.ok}`];
  for (const row of summaryRows(item.summary)) {
    lines.push(`${row[0]}: ${row[1]}`);
  }
  for (const entry of item.problems) lines.push(...markdownProblem(entry));
  return lines;
};

const renderDocument = (doc, rawFile) => {
  const lines = [notice(rawFile)];
  for (const item of doc.reports) lines.push(...markdownReport(item));
  if (doc.stderr) lines.push('', '# stderr', '', doc.stderr);
  lines.push('', `exit: ${doc.exit}`);
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
};

const loggedText = (text, rawFile) => {
  const body = `${text ?? ''}`;
  if (body.startsWith(NOTICE_HEAD)) return body;
  const head = notice(rawFile);
  if (!body.trim()) return `${head}\n`;
  return `${head}\n\n${body}`;
};

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

module.exports = {
  NOTICE_HEAD,
  notice,
  displayMessage,
  loggedText,
  renderDocument,
  renderReport,
};
