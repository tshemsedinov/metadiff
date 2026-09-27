'use strict';

const NOTICE_HEAD =
  'reslop: reduced output; passing results are omitted ' +
  'and similar problems are grouped';

const NOTICE = [
  NOTICE_HEAD,
  'If reduced output hides information needed for debugging,',
  'rerun the same command with RESLOP_OUTPUT=raw.',
].join('\n');

const SUMMARY_ROWS = 6;
const PROBLEM_FIELDS = 7;

const writeRow = (rows, index, key, value) => {
  if (value === null || value === undefined || value === '') return index;
  rows[index] = [key, `${value}`];
  return index + 1;
};

const summaryRows = (stats) => {
  const rows = new Array(SUMMARY_ROWS);
  let index = 0;
  index = writeRow(rows, index, 'passed', stats.passed);
  index = writeRow(rows, index, 'failed', stats.failed);
  index = writeRow(rows, index, 'skipped', stats.skipped);
  index = writeRow(rows, index, 'errors', stats.errors);
  index = writeRow(rows, index, 'warnings', stats.warnings);
  index = writeRow(rows, index, 'duration', stats.duration);
  rows.length = index;
  return rows;
};

const problemRows = (item) => {
  const extra = item.extra;
  let size = PROBLEM_FIELDS + extra.length;
  if (item.count > 1) size += 1;
  if (item.omitted > 0) size += 1;
  const rows = new Array(size);
  let index = 0;
  index = writeRow(rows, index, 'severity', item.severity);
  index = writeRow(rows, index, 'duration', item.duration);
  index = writeRow(rows, index, 'code', item.code);
  index = writeRow(rows, index, 'operator', item.operator);
  index = writeRow(rows, index, 'expected', item.expected);
  index = writeRow(rows, index, 'actual', item.actual);
  index = writeRow(rows, index, 'message', item.message);
  for (let i = 0; i < extra.length; i++) {
    const pair = extra[i];
    index = writeRow(rows, index, pair[0], pair[1]);
  }
  if (item.count > 1) index = writeRow(rows, index, 'count', item.count);
  if (item.omitted > 0) {
    index = writeRow(rows, index, 'omitted', item.omitted);
  }
  rows.length = index;
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
