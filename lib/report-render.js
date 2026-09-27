'use strict';

const NOTICE_HEAD =
  'reslop: reduced output; passing results are omitted ' +
  'and similar problems are grouped';

const NOTICE = [
  NOTICE_HEAD,
  'If reduced output hides information needed for debugging,',
  'rerun the same command with RESLOP_OUTPUT=raw.',
].join('\n');

const addRow = (rows, key, value) => {
  if (value === null || value === undefined || value === '') return;
  rows.push([key, `${value}`]);
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
  addRow(rows, 'severity', item.severity);
  addRow(rows, 'duration', item.duration);
  addRow(rows, 'code', item.code);
  addRow(rows, 'operator', item.operator);
  addRow(rows, 'expected', item.expected);
  addRow(rows, 'actual', item.actual);
  addRow(rows, 'message', item.message);
  for (const extra of item.extra) addRow(rows, extra[0], extra[1]);
  if (item.count > 1) addRow(rows, 'count', item.count);
  if (item.omitted > 0) addRow(rows, 'omitted', item.omitted);
  return rows;
};

const markdownValue = (value) => {
  const text = `${value}`;
  if (!text.includes('\n')) return text;
  return `\n${text}`;
};

const markdownProblem = (item) => {
  const title = item.name || item.message || item.code || 'problem';
  const lines = ['', `## ${title}`, ''];
  for (const row of problemRows(item)) {
    lines.push(`- ${row[0]}: ${markdownValue(row[1])}`);
  }
  for (const trace of item.traces) {
    if (!trace) continue;
    lines.push(`- trace:\n${trace}`);
  }
  return lines;
};

const markdownReport = (item) => {
  const lines = ['', `# ${item.tool}`, '', `ok: ${item.ok}`];
  for (const row of summaryRows(item.summary)) {
    lines.push(`${row[0]}: ${row[1]}`);
  }
  for (const problem of item.problems) {
    lines.push(...markdownProblem(problem));
  }
  return lines;
};

const renderMarkdown = (doc) => {
  const lines = [NOTICE, '', `exit: ${doc.exit}`];
  for (const item of doc.reports) lines.push(...markdownReport(item));
  if (doc.stderr) lines.push('', '# stderr', '', doc.stderr);
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
};

const renderDocument = (doc) => renderMarkdown(doc);

module.exports = {
  NOTICE,
  renderMarkdown,
  renderDocument,
};
