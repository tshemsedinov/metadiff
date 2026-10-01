'use strict';

const model = require('./report-model.js');
const npmCommands = require('./npm-commands.js');
const { isPassingTest } = npmCommands;
const utilities = require('./utilities.js');
const { unquote } = utilities;

const { summary, problem, report, userTrace, errorKey } = model;

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
  'at',
  'found',
  'wanted',
  'got',
  'expect',
];

const HIDDEN = ['generatedMessage', 'diff'];

const ERROR_HEAD = /^([\w.]*Error)(?: \[([^\]]+)\])?:\s*/;

const exceptionFields = (lines) => {
  const rows = lines.map((line) => line.replace(/^\s*# ?/, ''));
  const header = rows.findIndex((line) => ERROR_HEAD.test(line.trim()));
  const frame = rows.findIndex((line) => /^\s*at\s/.test(line));
  const start = header < 0 ? 0 : header;
  const end = frame < 0 ? rows.length : frame;
  const text = rows
    .slice(start, end)
    .map((line) => line.trim())
    .join('\n');
  const match = ERROR_HEAD.exec(text);
  const message = match ? text.slice(match[0].length).trim() : text.trim();
  const stack = frame < 0 ? '' : rows.slice(frame).join('\n');
  return [
    ['message', message],
    ['name', match ? match[1] : ''],
    ['code', match ? match[2] || '' : ''],
    ['stack', stack],
  ];
};

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
    if (KNOWN.includes(field[0]) || HIDDEN.includes(field[0])) continue;
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

const problemFromFields = (name, fields, root, fallback = '') => {
  const map = fieldMap(fields);
  const stack = show(map.get('stack'));
  const parsed = fieldMap(exceptionFields(stack.split(/\r?\n/)));
  const text = show(
    map.get('error') || map.get('message') || parsed.get('message'),
  );
  const header = ERROR_HEAD.exec(text);
  const message = header ? text.slice(header[0].length).trim() : text;
  const location = show(map.get('at') || map.get('location'));
  const duration = show(map.get('duration_ms') || map.get('duration'));
  const details = {
    name,
    message,
    duration,
    code: show(map.get('code') || (header && header[2]) || parsed.get('code')),
    operator: show(map.get('operator')),
    expected: show(
      map.get('expected') ?? map.get('wanted') ?? map.get('expect'),
    ),
    actual: show(map.get('actual') ?? map.get('found') ?? map.get('got')),
    extra: extraFrom(fields),
  };
  const type = show(
    map.get('name') || (header && header[1]) || parsed.get('name'),
  );
  if (type) details.extra.unshift(['type', type]);
  const known =
    message ||
    stack ||
    location ||
    details.operator ||
    details.code ||
    details.expected ||
    details.actual;
  if (!known) {
    details.message = fallback;
  }
  const source = show(map.get('at')) || stack || location;
  const key = errorKey({ ...details, type }, source, root);
  const trace = userTrace(parsed.get('stack') || stack || location, root);
  return problem({ ...details, key, trace });
};

const quoted = (value) => value.startsWith('"') || value.startsWith('\x27');

const scalarText = (value) => {
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value.replace(/\r?\n/g, '\\n'));
    } catch {
      return unquote(value);
    }
  }
  return unquote(value);
};

const blockText = (lines) => {
  let indent = Infinity;
  for (const line of lines) {
    if (line.trim()) indent = Math.min(indent, line.match(/^\s*/)[0].length);
  }
  return lines
    .map((line) => line.slice(indent))
    .join('\n')
    .trimEnd();
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
    let value = match[3].trim().replace(/,$/, '');
    const block = value === '|-' || value === '|' || value === '>';
    index += 1;
    if (key === 'error' && !value) continue;
    if (quoted(value)) {
      const quote = value[0];
      while (
        index < lines.length &&
        (value.length < 2 || value.at(-1) !== quote)
      ) {
        value = `${value}\n${lines[index]}`;
        index += 1;
      }
      fields.push([key, scalarText(value)]);
      continue;
    }
    const rows = [];
    const indent = match[1].length;
    while (index < lines.length) {
      const line = lines[index];
      if (line.trim() && line.match(/^\s*/)[0].length <= indent) break;
      rows.push(lines[index]);
      index += 1;
    }
    if (block || rows.some((line) => line.trim())) {
      const text = blockText(rows);
      fields.push([key, block ? text : `${value}\n${text}`.trim()]);
    } else {
      fields.push([key, scalarText(value)]);
    }
  }
  return fields;
};

const tapPoint = (line) => {
  const match = /^\s*(not ok|ok)\b(?:\s+\d+)?(?:\s+-)?(?:\s+(.*))?$/.exec(line);
  if (!match) return null;
  const text = match[2] || '';
  return {
    passed: match[1] === 'ok',
    name: text
      .split(/\s+#/)[0]
      .replace(/\s*\{\s*$/, '')
      .trim(),
    skipped: /#\s*(SKIP|TODO)\b/i.test(text),
    container: /\{\s*$/.test(text),
  };
};

const STAT_FIELD = {
  tests: 'tests',
  pass: 'passed',
  fail: 'failed',
  skipped: 'skipped',
  skip: 'skipped',
};

const applyStat = (stats, key, value) => {
  if (key === 'duration_ms') stats.duration = value;
  const field = Object.hasOwn(STAT_FIELD, key) ? STAT_FIELD[key] : '';
  if (field) stats[field] = Number(value);
};

const applyTapComment = (stats, line) => {
  const match = /^#\s+(\w+)\s+(.+)$/.exec(line.trim());
  if (match) applyStat(stats, match[1], match[2].trim());
};

const isTapLine = (line) => {
  const text = line.trim();
  if (text.startsWith('TAP version')) return true;
  if (tapPoint(text)) return true;
  if (/^1\.\.\d+/.test(text)) return true;
  if (text.startsWith('Bail out!')) return true;
  return false;
};

const tapBoundary = (line) => {
  if (isTapLine(line) || line.trim() === '}') return true;
  const stats =
    /^\s*#\s+(?:Subtest:|(?:tests|pass|fail|skipped|duration_ms)\s+\d)/;
  return stats.test(line);
};

const readYaml = (lines, start) => {
  const body = [];
  const indent = lines[start].match(/^\s*/)[0].length;
  let index = start + 1;
  for (; index < lines.length; index++) {
    if (lines[index].trim() === '...') break;
    const lead = lines[index].match(/^\s*/)[0].length;
    if (lead <= indent && tapBoundary(lines[index])) break;
    body.push(lines[index]);
  }
  const end = lines[index] && lines[index].trim() === '...';
  return { fields: yamlFields(body), next: end ? index + 1 : index };
};

const readTapFields = (lines, start) => {
  const fields = [];
  const body = [];
  let index = start;
  while (index < lines.length && !tapBoundary(lines[index])) {
    if (lines[index].trim() === '---') {
      const yaml = readYaml(lines, index);
      fields.push(...yaml.fields);
      index = yaml.next;
    } else {
      body.push(lines[index]);
      index += 1;
    }
  }
  if (!fields.length) fields.push(...exceptionFields(body));
  return { fields, next: index };
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
  const counts = { tests: 0, passed: 0, failed: 0, skipped: 0 };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed.startsWith('# ')) applyTapComment(stats, trimmed);
    if (trimmed.startsWith('Bail out!')) {
      problems.push(problem({ name: 'Bail out!', message: trimmed }));
    }
    const point = tapPoint(line);
    if (!point || point.container) {
      index += 1;
      continue;
    }
    const body = readTapFields(lines, index + 1);
    index = body.next;
    const map = fieldMap(body.fields);
    if (map.get('failureType') === 'subtestsFailed') continue;
    counts.tests += 1;
    if (point.skipped) {
      counts.skipped += 1;
    } else if (point.passed) {
      counts.passed += 1;
    } else {
      counts.failed += 1;
      problems.push(
        problemFromFields(point.name, body.fields, root, point.name),
      );
    }
  }
  for (const key of Object.keys(counts)) {
    if (stats[key] === null) stats[key] = counts[key];
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

const durationText = (value) => (value === undefined ? '' : `${value}`);

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
    duration: durationText(item.duration),
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

const PLAYWRIGHT_FAILED = ['failed', 'timedOut'];

const playwrightProblem = (spec, result, root) => {
  const error = result.error || {};
  return problem({
    name: spec.title || '',
    message: error.message || result.status,
    trace: userTrace(error.stack || '', root),
    duration: durationText(result.duration),
  });
};

const walkPlaywright = (suite, problems, root) => {
  for (const spec of suite.specs || []) {
    const results = (spec.tests || []).flatMap((item) => item.results || []);
    for (const result of results) {
      if (!PLAYWRIGHT_FAILED.includes(result.status)) continue;
      problems.push(playwrightProblem(spec, result, root));
    }
  }
  for (const child of suite.suites || []) walkPlaywright(child, problems, root);
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
  applyStat(stats, key, match[2].trim());
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
  const fields = [...current.fields];
  if (current.message) fields.push(['error', current.message.trimEnd()]);
  if (current.trace.length) fields.push(['stack', current.trace.join('\n')]);
  if (current.expected) fields.push(['expected', current.expected]);
  if (current.actual) fields.push(['actual', current.actual]);
  const item = problemFromFields(current.name, fields, root);
  problems.push(item);
};

const takeSpecLine = (current, line) => {
  const text = line.trim();
  if (/^[\w.]*Error(?: \[[^\]]+\])?:/.test(text)) {
    current.message = text;
    return;
  }
  const expected = /^Expected:\s*(.*)$/.exec(text);
  if (expected) current.expected = expected[1];
  const received = /^Received:\s*(.*)$/.exec(text);
  if (received) current.actual = received[1];
  if (current.message && !current.trace.length) {
    current.message = `${current.message}\n${text}`;
  }
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
