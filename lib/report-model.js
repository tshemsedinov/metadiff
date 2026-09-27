'use strict';

const ansi = require('./ansi.js');
const { stripAnsi } = ansi;
const commands = require('./npm-commands.js');

const { withoutNodeFrame, indentStack, relativize } = commands;

const summary = () => ({
  tests: null,
  passed: null,
  failed: null,
  skipped: null,
  errors: null,
  warnings: null,
  duration: '',
});

const problem = (fields = {}) => {
  const trace = fields.trace || '';
  const traces = fields.traces || (trace ? [trace] : []);
  return {
    severity: fields.severity || 'error',
    name: fields.name || '',
    message: fields.message || '',
    trace,
    traces,
    duration: fields.duration || '',
    code: fields.code || '',
    operator: fields.operator || '',
    expected: fields.expected || '',
    actual: fields.actual || '',
    extra: fields.extra || [],
    count: fields.count === undefined ? 1 : fields.count,
    omitted: fields.omitted || 0,
  };
};

const report = (tool, fields = {}) => ({
  tool,
  ok: fields.ok !== false,
  summary: fields.summary || summary(),
  problems: fields.problems || [],
});

const userTrace = (text, root) => {
  const lines = stripAnsi(`${text ?? ''}`).split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    const next = withoutNodeFrame(line);
    if (next === null) continue;
    kept.push(relativize(indentStack(next), root).trimEnd());
  }
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  return kept.join('\n').trim();
};

const normalizeMessage = (message) => {
  const text = `${message ?? ''}`.trim().replace(/\s+/g, ' ');
  return text.replace(/\s+\S+:\d+:\d+$/, '');
};

const groupKey = (item) =>
  [
    item.severity,
    item.code,
    item.operator,
    item.expected,
    item.actual,
    normalizeMessage(item.message),
  ].join('\0');

const groupProblems = (problems) => {
  const groups = new Map();
  const order = [];
  for (const item of problems) {
    const key = groupKey(item);
    let group = groups.get(key);
    if (!group) {
      group = problem({ ...item, count: 0, traces: [], omitted: 0 });
      groups.set(key, group);
      order.push(group);
    }
    group.count += 1;
    if (item.trace && group.traces.length < 3) group.traces.push(item.trace);
  }
  for (const group of order) {
    group.trace = group.traces[0] || '';
    group.omitted = Math.max(0, group.count - group.traces.length);
  }
  return order;
};

const groupReport = (item) =>
  report(item.tool, {
    ok: item.ok,
    summary: item.summary,
    problems: groupProblems(item.problems),
  });

const reduceStderr = (text, root) => userTrace(text, root);

const shortTail = (text) => {
  const lines = `${text ?? ''}`.trim().split(/\r?\n/);
  if (lines.length <= 20) return lines.join('\n');
  return lines.slice(-20).join('\n');
};

const envelope = (reports, exit, stderr) => {
  const status = exit === null || exit === undefined ? 1 : exit;
  const ok = status === 0;
  const items = new Array(reports.length);
  for (let i = 0; i < reports.length; i++) {
    const item = reports[i];
    items[i] = report(item.tool, { ...item, ok });
  }
  return { ok, exit: status, reports: items, stderr: stderr || '' };
};

module.exports = {
  summary,
  problem,
  report,
  userTrace,
  groupReport,
  reduceStderr,
  shortTail,
  envelope,
};
