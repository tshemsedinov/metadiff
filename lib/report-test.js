'use strict';

const model = require('./report-model.js');
const npmCommands = require('./npm-commands.js');
const { isPassingTest } = npmCommands;

const { summary, problem, report, userTrace } = model;

const KNOWN = [
  'message',
  'error',
  'code',
  'operator',
  'expected',
  'actual',
  'stack',
  'duration_ms',
  'duration',
  'name',
  'location',
  'severity',
  'type',
];

const show = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return `${value}`;
  }
  return JSON.stringify(value);
};

const extraFrom = (fields) => {
  const extra = [];
  for (const field of fields) {
    if (KNOWN.includes(field[0])) continue;
    const value = show(field[1]);
    if (!value) continue;
    const shown = value.length > 500 ? `${value.slice(0, 500)}…` : value;
    extra.push([field[0], shown]);
  }
  return extra;
};

const fieldMap = (fields) => {
  const map = new Map();
  for (const field of fields) map.set(field[0], field[1]);
  return map;
};

const problemFromFields = (name, fields, root) => {
  const map = fieldMap(fields);
  const message = show(map.get('error') || map.get('message'));
  const stack = show(map.get('stack'));
  const location = show(map.get('location'));
  const trace = userTrace(stack || location, root);
  const duration = show(map.get('duration_ms') || map.get('duration'));
  return problem({
    name,
    message,
    trace,
    duration,
    code: show(map.get('code')),
    operator: show(map.get('operator')),
    expected: show(map.get('expected')),
    actual: show(map.get('actual')),
    extra: extraFrom(fields),
  });
};

const yamlValue = (raw) => {
  const text = `${raw ?? ''}`.trim();
  if (text.length < 2) return text;
  const open = text[0];
  const close = text[text.length - 1];
  const code = open.charCodeAt(0);
  const quoted = open === close && (code === 34 || code === 39);
  if (quoted) return text.slice(1, -1);
  return text;
};

const yamlFields = (lines) => {
  const fields = [];
  let index = 0;
  while (index < lines.length) {
    const match = /^(\s*)([A-Za-z_][\w]*)\s*:\s*(.*)$/.exec(lines[index]);
    if (!match) {
      index += 1;
      continue;
    }
    const key = match[2];
    const value = match[3].trim().replace(/,$/, '');
    const block = value === '|-' || value === '|' || value === '>';
    if (!block) {
      fields.push([key, yamlValue(value)]);
      index += 1;
      continue;
    }
    const rows = [];
    index += 1;
    while (index < lines.length && /^\s+\S/.test(lines[index])) {
      rows.push(lines[index].trim());
      index += 1;
    }
    fields.push([key, rows.join('\n')]);
  }
  return fields;
};

const readYaml = (lines, start) => {
  const body = [];
  let index = start + 1;
  for (; index < lines.length; index++) {
    if (lines[index].trim() === '...') break;
    body.push(lines[index]);
  }
  return { fields: yamlFields(body), next: index + 1 };
};

const tapName = (line) => {
  const match = /^(?:not )?ok\s+\d+\s+-?\s*(.*)$/.exec(line.trim());
  if (!match) return line.trim();
  return match[1].trim();
};

const applyTapComment = (stats, line) => {
  const match = /^#\s+(\w+)\s+(.+)$/.exec(line.trim());
  if (!match) return;
  const key = match[1];
  const value = match[2].trim();
  if (key === 'tests') stats.tests = Number(value);
  if (key === 'pass') stats.passed = Number(value);
  if (key === 'fail') stats.failed = Number(value);
  if (key === 'skipped' || key === 'skip') stats.skipped = Number(value);
  if (key === 'duration_ms') stats.duration = value;
};

const isTapLine = (line) => {
  const text = line.trim();
  if (text.startsWith('TAP version')) return true;
  if (/^(not )?ok\s+\d+\b/.test(text)) return true;
  if (/^1\.\.\d+/.test(text)) return true;
  if (text.startsWith('Bail out!')) return true;
  return false;
};

const parseTap = (text, root) => {
  const lines = `${text ?? ''}`.split(/\r?\n/);
  let seen = false;
  for (const line of lines) {
    if (isTapLine(line)) seen = true;
  }
  if (!seen) return null;
  const stats = summary();
  const problems = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed.startsWith('# ')) applyTapComment(stats, trimmed);
    if (trimmed.startsWith('Bail out!')) {
      problems.push(problem({ name: 'Bail out!', message: trimmed }));
    }
    const failed = /^not ok\s+\d+\b/.test(trimmed);
    const passed = /^ok\s+\d+\b/.test(trimmed);
    if (!failed && !passed) {
      index += 1;
      continue;
    }
    const name = tapName(trimmed);
    let fields = [];
    if (lines[index + 1] && lines[index + 1].trim() === '---') {
      const yaml = readYaml(lines, index + 1);
      fields = yaml.fields;
      index = yaml.next;
    } else {
      index += 1;
    }
    if (failed) problems.push(problemFromFields(name, fields, root));
  }
  return report('test', { summary: stats, problems });
};

const countStatus = (stats, status) => {
  if (status === 'passed' || status === 'pass') {
    stats.passed = (stats.passed || 0) + 1;
    return;
  }
  if (status === 'failed' || status === 'fail' || status === 'timedOut') {
    stats.failed = (stats.failed || 0) + 1;
    return;
  }
  if (status === 'skipped' || status === 'pending' || status === 'todo') {
    stats.skipped = (stats.skipped || 0) + 1;
  }
};

const nodeEventProblem = (event, root) => {
  const data = event.data || {};
  const details = data.details || {};
  const error = details.error || {};
  const fields = [];
  for (const key of Object.keys(error)) fields.push([key, error[key]]);
  if (details.duration_ms !== undefined) {
    fields.push(['duration_ms', details.duration_ms]);
  }
  const name = data.name || '';
  return problemFromFields(name, fields, root);
};

const parseNodeEvents = (events, root) => {
  const stats = summary();
  const problems = [];
  let seen = false;
  for (const event of events) {
    const type = event && event.type;
    if (typeof type !== 'string' || !type.startsWith('test:')) continue;
    seen = true;
    if (type === 'test:pass') countStatus(stats, 'passed');
    if (type === 'test:fail') {
      countStatus(stats, 'failed');
      problems.push(nodeEventProblem(event, root));
    }
    if (type === 'test:skip' || type === 'test:todo') {
      countStatus(stats, 'skipped');
    }
  }
  if (!seen) return null;
  const skipped = stats.skipped || 0;
  stats.tests = (stats.passed || 0) + (stats.failed || 0) + skipped;
  return report('test', { summary: stats, problems });
};

const parseNodeJsonl = (text, root) => {
  const lines = `${text ?? ''}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  const events = [];
  for (const line of lines) {
    if (line[0] !== '{') return null;
    try {
      events.push(JSON.parse(line));
    } catch {
      return null;
    }
  }
  return parseNodeEvents(events, root);
};

const jestTrace = (text, file, root) => {
  const stacks = `${text ?? ''}`
    .split('\n')
    .filter((line) => /^\s*at\s/.test(line));
  const trace = userTrace(stacks.join('\n'), root);
  if (trace) return trace;
  return userTrace(file, root);
};

const jestProblem = (item, file, root) => {
  const messages = item.failureMessages || [];
  const text = messages.join('\n');
  const expected = /Expected:\s*(.*)/.exec(text);
  const received = /Received:\s*(.*)/.exec(text);
  return problem({
    name: item.fullName || item.title || '',
    message: text,
    trace: jestTrace(text, file, root),
    expected: expected ? expected[1] : '',
    actual: received ? received[1] : '',
    duration: item.duration === undefined ? '' : `${item.duration}`,
  });
};

const parseJest = (data, root) => {
  if (!data || !Array.isArray(data.testResults)) return null;
  if (data.numFailedTests === undefined && data.numPassedTests === undefined) {
    return null;
  }
  const stats = summary();
  stats.passed = data.numPassedTests ?? null;
  stats.failed = data.numFailedTests ?? null;
  stats.skipped = data.numPendingTests ?? null;
  if (stats.passed !== null || stats.failed !== null) {
    const skipped = stats.skipped || 0;
    stats.tests = (stats.passed || 0) + (stats.failed || 0) + skipped;
  }
  const problems = [];
  for (const file of data.testResults) {
    const assertions = file.assertionResults || [];
    for (const item of assertions) {
      if (item.status !== 'failed') continue;
      problems.push(jestProblem(item, file.name || '', root));
    }
  }
  return report('test', { summary: stats, problems });
};

const walkPlaywright = (suite, problems, root) => {
  const specs = suite.specs || [];
  for (const spec of specs) {
    const tests = spec.tests || [];
    for (const item of tests) {
      const results = item.results || [];
      for (const result of results) {
        const status = result.status;
        if (status !== 'failed' && status !== 'timedOut') continue;
        const error = result.error || {};
        problems.push(
          problem({
            name: spec.title || '',
            message: error.message || status,
            trace: userTrace(error.stack || '', root),
            duration: result.duration === undefined ? '' : `${result.duration}`,
          }),
        );
      }
    }
  }
  const children = suite.suites || [];
  for (const child of children) walkPlaywright(child, problems, root);
};

const parsePlaywright = (data, root) => {
  if (!data || !Array.isArray(data.suites)) return null;
  const stats = summary();
  const box = data.stats || {};
  if (box.expected !== undefined) stats.passed = box.expected;
  if (box.unexpected !== undefined) stats.failed = box.unexpected;
  if (box.skipped !== undefined) stats.skipped = box.skipped;
  if (box.duration !== undefined) stats.duration = `${box.duration}`;
  const problems = [];
  for (const suite of data.suites) walkPlaywright(suite, problems, root);
  if (stats.passed === null && stats.failed === null && !problems.length) {
    return null;
  }
  return report('test', { summary: stats, problems });
};

const parseTestJson = (data, root) => {
  const jest = parseJest(data, root);
  if (jest) return jest;
  return parsePlaywright(data, root);
};

const specStats = (stats, line) => {
  const match = /^[ℹi]\s+(\w+)\s+(.+)$/.exec(line.trim());
  if (!match) return false;
  const key = match[1];
  const value = match[2].trim();
  if (key === 'tests') stats.tests = Number(value);
  if (key === 'pass') stats.passed = Number(value);
  if (key === 'fail') stats.failed = Number(value);
  if (key === 'skipped') stats.skipped = Number(value);
  if (key === 'duration_ms') stats.duration = value;
  return key === 'tests' || key === 'pass' || key === 'fail';
};

const specHeader = (line) =>
  /^[✖●]\s+(failing|cancelled|todo) tests:?$/.test(line.trim());

const failureStart = (line) => {
  const text = line.trim();
  if (specHeader(line)) return false;
  if (text.startsWith('✖') && !/✖\s+\d+\s+problems?\b/.test(text)) return true;
  if (text.startsWith('FAIL ') || text === 'FAIL') return true;
  if (/^not ok\s+\d+\b/.test(text)) return true;
  if (text.startsWith('● ')) return true;
  return false;
};

const failureName = (line) => {
  const text = line
    .trim()
    .replace(/^[✖●]\s*/, '')
    .replace(/^FAIL\s+/, '');
  return text.replace(/\s+\([\d.]+m?s\)$/, '');
};

const readSpecObject = (lines, start) => {
  const body = [];
  let index = start + 1;
  for (; index < lines.length; index++) {
    if (lines[index].trim() === '}') break;
    body.push(lines[index]);
  }
  return { fields: yamlFields(body), next: index + 1 };
};

const pushSpec = (problems, current, root) => {
  if (!current) return;
  const fields = current.fields;
  const item = problemFromFields(current.name, fields, root);
  if (current.message && !item.message) item.message = current.message;
  const trace = userTrace(current.trace.join('\n'), root);
  if (trace) item.trace = trace;
  if (current.expected) item.expected = current.expected;
  if (current.actual) item.actual = current.actual;
  problems.push(item);
};

const takeSpecLine = (current, line) => {
  const text = line.trim();
  if (/^(AssertionError|Error)\b/.test(text)) {
    current.message = text;
    return;
  }
  const expected = /^Expected:\s*(.*)$/.exec(text);
  if (expected) current.expected = expected[1];
  const received = /^Received:\s*(.*)$/.exec(text);
  if (received) current.actual = received[1];
};

const takeSpecFrame = (lines, index, current) => {
  const line = lines[index];
  if (!/^\s*at\s/.test(line)) return 0;
  if (!/\{\s*$/.test(line)) {
    current.trace.push(line);
    return 1;
  }
  const frame = line.replace(/\s*\{\s*$/, '');
  if (frame.trim()) current.trace.push(frame);
  const block = readSpecObject(lines, index);
  current.fields.push(...block.fields);
  return block.next - index;
};

const hasDetail = (item) =>
  item.message ||
  item.trace ||
  item.code ||
  item.operator ||
  item.expected ||
  item.actual;

const dropPreviews = (problems) => {
  const named = new Set();
  for (const item of problems) {
    if (item.name && hasDetail(item)) named.add(item.name);
  }
  const kept = [];
  for (const item of problems) {
    if (item.name && named.has(item.name) && !hasDetail(item)) continue;
    kept.push(item);
  }
  return kept;
};

const parseSpec = (text, root) => {
  const lines = `${text ?? ''}`.split(/\r?\n/);
  const stats = summary();
  const problems = [];
  let current = null;
  let marked = false;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (specStats(stats, line)) marked = true;
    if (isPassingTest(line)) {
      marked = true;
      index += 1;
      continue;
    }
    if (line.trim() === '{') {
      const block = readSpecObject(lines, index);
      if (current) current.fields.push(...block.fields);
      index = block.next;
      continue;
    }
    if (failureStart(line)) {
      pushSpec(problems, current, root);
      current = {
        name: failureName(line),
        message: '',
        trace: [],
        fields: [],
        expected: '',
        actual: '',
      };
      marked = true;
      index += 1;
      continue;
    }
    if (current) {
      const skip = takeSpecFrame(lines, index, current);
      if (skip) {
        index += skip;
        continue;
      }
      takeSpecLine(current, line);
    }
    index += 1;
  }
  pushSpec(problems, current, root);
  const kept = dropPreviews(problems);
  if (!marked && !kept.length) return null;
  return report('test', { summary: stats, problems: kept });
};

module.exports = {
  parseTap,
  parseNodeJsonl,
  parseTestJson,
  parseSpec,
};
