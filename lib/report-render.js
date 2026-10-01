'use strict';

const NOTICE_HEAD =
  'reslop: reduced output; passing results are omitted ' +
  'and similar problems are grouped';

const rawHint = (rawFile) => {
  const target = rawFile
    ? `the raw log \`.log/${rawFile}\``
    : 'the matching raw log under `.log/`';
  return `Agent: if this report hides a needed detail, read ${target}.`;
};

const notice = (rawFile) => [NOTICE_HEAD, rawHint(rawFile)].join('\n');

const NOTICE = notice();

const SUMMARY_ROWS = 6;
const PROBLEM_FIELDS = 6;

const writeRow = (rows, index, key, value) => {
  if (value === null || value === undefined || value === '') return index;
  rows[index] = [key, `${value}`];
  return index + 1;
};

const isComparison = (line) => {
  const match = /^(.*) (?:!==|===|!=|==) (\S.*)$/.exec(line.trim());
  if (!match) return false;
  return match[1].trim() !== '';
};

const isDiffHeader = (line) => {
  const text = line.trim().replace(/^[+-]\s*/, '');
  return /^actual\s+[+-]?\s*expected$/.test(text);
};

const isMarkedDiff = (line) => /^[+-](?:\s|$)/.test(line.trim());

const sameValue = (line, value) => {
  if (!value) return false;
  const text = line.trim();
  if (text === value) return true;
  const open = text[0];
  const tick = String.fromCharCode(39);
  const quote = open === '"' || open === tick;
  const wrapped = text.length > 2 && open === text.at(-1);
  return quote && wrapped && text.slice(1, -1) === value;
};

const startsDiff = (line, item) => {
  if (isComparison(line) || isDiffHeader(line) || isMarkedDiff(line)) {
    return true;
  }
  return sameValue(line, item.expected) || sameValue(line, item.actual);
};

const displayMessage = (item) => {
  const values = item.expected !== '' || item.actual !== '';
  const lines = [];
  let diff = false;
  for (const line of `${item.message}`.split('\n')) {
    if (line.trim() === '') continue;
    if (values && (diff || startsDiff(line, item))) {
      diff = true;
      continue;
    }
    lines.push(line);
  }
  if (lines.length && lines[0].trimEnd().endsWith(':')) {
    lines[0] = lines[0].trimEnd().slice(0, -1);
  }
  if (lines.length && lines[0].trim() === '') lines.shift();
  return lines.join('\n');
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
  if (item.severity !== 'error') {
    index = writeRow(rows, index, 'severity', item.severity);
  }
  index = writeRow(rows, index, 'duration', item.duration);
  index = writeRow(rows, index, 'code', item.code);
  index = writeRow(rows, index, 'operator', item.operator);
  index = writeRow(rows, index, 'expected', item.expected);
  index = writeRow(rows, index, 'actual', item.actual);
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

const QUOTE_BAR = '│';

const quoteLines = (text) => {
  const rows = `${text}`.replace(/\n+$/, '').split('\n');
  const lines = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) lines[i] = `${QUOTE_BAR} ${rows[i]}`;
  return lines;
};

const markdownQuote = (text) => {
  const lines = [];
  for (const line of `${text}`.replace(/\n+$/, '').split('\n')) {
    lines.push(`> ${line}`);
  }
  return lines.join('\n');
};

const markdownProblem = (item) => {
  const title = item.name || item.message || item.code || 'problem';
  const lines = ['', `## ${title}`, ''];
  for (const row of problemRows(item)) {
    lines.push(`- ${row[0]}: ${markdownValue(row[1])}`);
  }
  const message = displayMessage(item);
  if (message) lines.push('', markdownQuote(message), '');
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
  for (const problem of item.problems) {
    lines.push(...markdownProblem(problem));
  }
  return lines;
};

const renderMarkdown = (doc, rawFile) => {
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

const renderDocument = (doc, rawFile) => renderMarkdown(doc, rawFile);

module.exports = {
  NOTICE,
  NOTICE_HEAD,
  notice,
  summaryRows,
  problemRows,
  displayMessage,
  quoteLines,
  loggedText,
  renderMarkdown,
  renderDocument,
};
