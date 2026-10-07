'use strict';

const { parseAuditReport, parseOutdatedReport } = require('./deps.js');
const { summary, problem, report, userTrace } = require('./report-model.js');

const PRETTIER_SUMMARY = [
  'Code style issues',
  'All matched files use Prettier',
];

const place = (file, line, column, root) =>
  userTrace(`${file}:${line}:${column}`, root);

const errorReport = (tool, problems) => {
  const stats = summary();
  stats.errors = problems.length;
  return report(tool, { summary: stats, problems });
};

const eslintReport = (problems) => {
  const stats = summary();
  const isWarning = (item) => item.severity === 'warning';
  stats.warnings = problems.filter(isWarning).length;
  stats.errors = problems.length - stats.warnings;
  return report('eslint', { summary: stats, problems });
};

const parseEslintJson = (data, root) => {
  const rows = Array.isArray(data) ? data : data && data.results;
  if (!Array.isArray(rows) || !rows.length) return null;
  if (!rows[0] || !Array.isArray(rows[0].messages)) return null;
  const problems = [];
  for (const file of rows) {
    for (const item of file.messages || []) {
      const trace = place(
        file.filePath || '',
        item.line || 0,
        item.column || 0,
        root,
      );
      problems.push(
        problem({
          severity: item.severity === 1 ? 'warning' : 'error',
          message: item.message || '',
          code: item.ruleId || '',
          trace,
        }),
      );
    }
  }
  return eslintReport(problems);
};

const eslintLine = (line) => {
  const match = /^\s*(\d+):(\d+)\s+(error|warning)\s+(.*)$/.exec(line);
  if (!match) return null;
  const rest = match[4];
  const ruleAt = rest.lastIndexOf('  ');
  const message = ruleAt < 0 ? rest : rest.slice(0, ruleAt);
  const code = ruleAt < 0 ? '' : rest.slice(ruleAt + 2).trim();
  return {
    line: match[1],
    column: match[2],
    severity: match[3],
    message: message.trim(),
    code,
  };
};

const isPathLine = (line) => {
  const text = line.trim();
  if (!text || text.startsWith('✖')) return false;
  if (eslintLine(text)) return false;
  return text.includes('/') || text.includes('\\') || /\.\w+$/.test(text);
};

const parseEslintStylish = (text, root) => {
  const problems = [];
  let file = '';
  let seen = false;
  for (const line of `${text ?? ''}`.split(/\r?\n/)) {
    const item = eslintLine(line);
    if (item) {
      seen = true;
      const { severity, message, code } = item;
      const trace = place(file, item.line, item.column, root);
      problems.push(problem({ severity, message, code, trace }));
      continue;
    }
    if (/✖\s+\d+\s+problems?\b/.test(line)) seen = true;
    if (isPathLine(line)) file = line.trim();
  }
  return seen ? eslintReport(problems) : null;
};

const TSC_LINE = /^(.*)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/;

const parseTsc = (text, root) => {
  const problems = [];
  for (const line of `${text ?? ''}`.split(/\r?\n/)) {
    const match = TSC_LINE.exec(line.trim());
    if (!match) continue;
    const trace = place(match[1], match[2], match[3], root);
    problems.push(problem({ message: match[5], code: match[4], trace }));
  }
  return problems.length ? errorReport('tsc', problems) : null;
};

const prettierFile = (line) => {
  const warn = /^\[(?:warn|error)\]\s+(\S+)$/.exec(line.trim());
  if (warn && !warn[1].startsWith('Code')) return warn[1];
  return '';
};

const isPrettierSummary = (line) =>
  PRETTIER_SUMMARY.some((text) => line.includes(text));

const parsePrettier = (text, root) => {
  const problems = [];
  let seen = false;
  for (const line of `${text ?? ''}`.split(/\r?\n/)) {
    if (isPrettierSummary(line)) seen = true;
    const file = prettierFile(line);
    if (!file) continue;
    seen = true;
    problems.push(problem({ message: 'format', trace: userTrace(file, root) }));
  }
  return seen ? errorReport('prettier', problems) : null;
};

const auditExtra = (item) => {
  const extra = [];
  if (item.range) extra.push(['range', item.range]);
  if (item.fix) extra.push(['fix', item.fix]);
  return extra;
};

const parseAudit = (text) => {
  const problems = [];
  for (const item of parseAuditReport(text).values()) {
    problems.push(
      problem({
        severity: item.severity || 'error',
        name: item.name,
        message: item.title || '',
        extra: auditExtra(item),
      }),
    );
  }
  return problems.length ? errorReport('audit', problems) : null;
};

const behind = (item) => {
  if (!item.current) return true;
  if (item.wanted && item.wanted !== item.current) return true;
  return !!item.latest && item.latest !== item.current;
};

const parseOutdated = (text) => {
  const problems = [];
  for (const [name, item] of parseOutdatedReport(text)) {
    if (!behind(item)) continue;
    problems.push(
      problem({
        severity: 'warning',
        name,
        message: `${item.current} ${item.wanted} ${item.latest}`.trim(),
        extra: [
          ['current', item.current],
          ['wanted', item.wanted],
          ['latest', item.latest],
        ],
      }),
    );
  }
  if (!problems.length) return null;
  const stats = summary();
  stats.warnings = problems.length;
  return report('outdated', { summary: stats, problems });
};

const pushLs = (problems, text) => {
  const message = `${text ?? ''}`.trim();
  if (message) problems.push(problem({ message }));
};

const walkLs = (node, problems) => {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node.problems)) {
    for (const item of node.problems) pushLs(problems, item);
  }
  if (node.missing) {
    pushLs(problems, `missing ${node.required || node.version || ''}`);
  }
  if (node.invalid) pushLs(problems, `invalid ${node.version || ''}`);
  if (node.extraneous) pushLs(problems, `extraneous ${node.version || ''}`);
  const deps = node.dependencies;
  if (!deps || typeof deps !== 'object') return;
  for (const name of Object.keys(deps)) walkLs(deps[name], problems);
};

const parseLs = (data) => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const listed = Array.isArray(data.problems);
  if (!data.dependencies && !listed) return null;
  const problems = [];
  walkLs(data, problems);
  if (!problems.length && !listed) return null;
  return errorReport('ls', problems);
};

const parseToolJson = (data, root) => {
  const eslint = parseEslintJson(data, root);
  if (eslint) return [eslint];
  const vulns = data && (data.vulnerabilities || data.advisories);
  const audit = vulns ? parseAudit(JSON.stringify(data)) : null;
  if (audit) return [audit];
  const ls = parseLs(data);
  if (ls) return [ls];
  const outdated = parseOutdated(JSON.stringify(data));
  if (outdated) return [outdated];
  return null;
};

const parseAuditText = (text) => {
  if (`${text ?? ''}`.trim().startsWith('{')) return null;
  const lines = `${text ?? ''}`.split(/\r?\n/);
  const problems = [];
  for (let index = 0; index < lines.length; index++) {
    const match = /^Severity:\s+(\w+)\s*$/.exec(lines[index].trim());
    if (!match) continue;
    const name = (lines[index - 1] || '').trim();
    const severity = match[1].toLowerCase();
    problems.push(problem({ severity, name, message: name }));
  }
  return problems.length ? errorReport('audit', problems) : null;
};

const parseToolText = (text, root) => {
  const reports = [
    parseEslintStylish(text, root),
    parseTsc(text, root),
    parsePrettier(text, root),
    parseAuditText(text),
  ];
  return reports.filter(Boolean);
};

const isPrettierLine = (line) => {
  const text = line.trim();
  if (!text) return false;
  if (prettierFile(text) || isPrettierSummary(text)) return true;
  return text.startsWith('Checking formatting');
};

const stderrRest = (text, reports) => {
  if (!reports.some((item) => item.tool === 'prettier')) return text;
  const lines = `${text ?? ''}`.split(/\r?\n/);
  return lines
    .filter((line) => !isPrettierLine(line))
    .join('\n')
    .trim();
};

module.exports = {
  parseToolJson,
  parseToolText,
  stderrRest,
};
