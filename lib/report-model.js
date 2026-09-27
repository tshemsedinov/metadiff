'use strict';

const { stripAnsi } = require('./ansi.js');
const { displayLine } = require('./npm-commands.js');

const textLines = (text) => `${text ?? ''}`.split(/\r?\n/);

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
  const kept = [];
  for (const line of textLines(stripAnsi(`${text ?? ''}`))) {
    const next = displayLine(line, root);
    if (next === null) continue;
    kept.push(next.trimEnd());
  }
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
  for (const item of problems) {
    const key = groupKey(item);
    let group = groups.get(key);
    if (!group) {
      group = problem({ ...item, count: 0, traces: [], omitted: 0 });
      groups.set(key, group);
    }
    group.count += 1;
    if (item.trace && group.traces.length < 3) group.traces.push(item.trace);
  }
  for (const group of groups.values()) {
    group.trace = group.traces[0] || '';
    group.omitted = Math.max(0, group.count - group.traces.length);
  }
  return [...groups.values()];
};

const groupReport = (item) =>
  report(item.tool, {
    ok: item.ok,
    summary: item.summary,
    problems: groupProblems(item.problems),
  });

const shortTail = (text) => {
  const lines = textLines(`${text ?? ''}`.trim());
  if (lines.length <= 20) return lines.join('\n');
  return lines.slice(-20).join('\n');
};

const envelope = (reports, exit, stderr) => {
  const status = exit === null || exit === undefined ? 1 : exit;
  const ok = status === 0;
  const items = reports.map((item) => report(item.tool, { ...item, ok }));
  return { ok, exit: status, reports: items, stderr: stderr || '' };
};

module.exports = {
  textLines,
  summary,
  problem,
  report,
  userTrace,
  groupReport,
  shortTail,
  envelope,
};
