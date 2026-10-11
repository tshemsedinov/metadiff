'use strict';

const { stripAnsi } = require('../term/ansi.js');
const { traceLine, relativize } = require('../runs/output.js');
const { trimText } = require('../common/utilities.js');

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
    key: fields.key || '',
    trace,
    traces,
    related: fields.related || [],
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
  for (const line of stripAnsi(`${text ?? ''}`).split(/\r?\n/)) {
    const next = traceLine(line, root);
    if (next !== null) kept.push(next.trimEnd());
  }
  let start = 0;
  while (start < kept.length && kept[start].trim() === '') start += 1;
  let end = kept.length;
  while (end > start && kept[end - 1] === '') end -= 1;
  return kept.slice(start, end).join('\n');
};

const normalizeMessage = (message) => {
  const text = trimText(message).replace(/\s+/g, ' ');
  return text.replace(/\s+\S+:\d+:\d+$/, '');
};

// Build identity from raw diagnostics, before userTrace removes Node frames.
const errorKey = (fields, stack, root) => {
  const text = stripAnsi(fields.message || '');
  const header = /^([\w.]*Error)(?: \[[^\]]+\])?:\s*/.exec(text);
  const type = fields.type || (header ? header[1] : '');
  const message = header ? text.slice(header[0].length) : text;
  let origin = '';
  for (const row of stripAnsi(stack).split(/\r?\n/)) {
    const line = row.trim().replace(/^at\s+/, '');
    if (/^[\w.]*Error(?: \[[^\]]+\])?:/.test(line)) continue;
    if (line.includes('node:') || !/:\d+:\d+\)?$/.test(line)) continue;
    const location = line.replace(/^.*\((.*:\d+:\d+)\)$/, '$1');
    origin = relativize(location.replace(/file:\/\//g, ''), root).replace(
      /\\/g,
      '/',
    );
    break;
  }
  return JSON.stringify([
    fields.severity || 'error',
    type,
    fields.code || '',
    fields.operator || '',
    message.replace(/\r\n/g, '\n').trim(),
    fields.expected || '',
    fields.actual || '',
    origin,
  ]);
};

const normalizeTrace = (trace) => {
  if (!trace) return '';
  return `${trace}`
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/\\/g, '/').replace(/:\d+(?::\d+)?/g, ':X:Y'))
    .join('\n');
};

const groupKey = (item) => {
  if (item.key) return item.key;
  const trace = normalizeTrace(item.trace);
  return [
    item.severity,
    item.code,
    item.operator,
    trace || normalizeMessage(item.message),
  ].join('\0');
};

const relatedProblem = (item, group) => {
  const frames = item.trace.split(/\r?\n/).map((line) => line.trim());
  const sample = (group.traces[0] || '')
    .split(/\r?\n/)
    .map((line) => line.trim());
  let index = 0;
  while (index < frames.length && frames[index] === sample[index]) index++;
  if (index === frames.length && item.name === group.name) return '';
  const rows = [item.name];
  const branch = frames[index];
  const last = frames.at(-1) || '';
  let location = '';
  if (/:\d+:\d+\)?$/.test(last)) {
    const inner = last.replace(/^.*\((.*:\d+:\d+)\)$/, '$1');
    location = inner.replace(/^at\s+/, '');
  }
  if (branch) {
    let frame = branch.replace(/^at\s+/, '');
    if (index === frames.length - 1 && location) frame = location;
    rows.push(frame);
  }
  if (index < frames.length - 1 && location) rows.push(location);
  return rows.filter(Boolean).join(' | ');
};

const groupProblems = (problems) => {
  const groups = new Map();
  for (const item of problems) {
    const key = groupKey(item);
    let group = groups.get(key);
    if (!group) {
      group = problem({ ...item, count: 0, traces: [], related: [] });
      groups.set(key, group);
    }
    group.count += 1;
    if (item.trace && !group.traces.length) {
      group.traces.push(item.trace);
    } else if (group.count > 1 && group.related.length < 2) {
      const related = relatedProblem(item, group);
      if (related && !group.related.includes(related)) {
        group.related.push(related);
      }
    }
  }
  const order = [...groups.values()];
  for (const group of order) {
    group.trace = group.traces[0] || '';
    group.omitted = Math.max(0, group.count - 1 - group.related.length);
  }
  return order;
};

const groupReport = (item) =>
  report(item.tool, {
    ok: item.ok,
    summary: item.summary,
    problems: groupProblems(item.problems),
  });

const toolFailed = (item) => {
  const stats = item.summary;
  if (stats.failed || stats.errors) return true;
  return item.problems.some((entry) => entry.severity !== 'warning');
};

const keepReport = (item) => {
  const stats = item.summary;
  if (stats.tests || stats.passed || stats.failed || stats.skipped) return true;
  return !!(stats.errors || stats.warnings) || item.problems.length > 0;
};

const envelope = (reports, exit, stderr) => {
  const status = exit ?? 1;
  const kept = reports.filter(keepReport);
  const items = kept.map((item) =>
    report(item.tool, { ...item, ok: !toolFailed(item) }),
  );
  return { ok: status === 0, exit: status, reports: items, stderr };
};

module.exports = {
  summary,
  problem,
  report,
  userTrace,
  errorKey,
  groupReport,
  envelope,
};
