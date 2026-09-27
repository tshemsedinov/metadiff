'use strict';

const { parseAuditReport, parseOutdatedReport } = require('./deps.js');
const model = require('./report-model.js');

const { summary, problem, report, userTrace } = model;

const place = (file, line, column, root) =>
  userTrace(`${file}:${line}:${column}`, root);

const parseEslintJson = (data, root) => {
  const rows = Array.isArray(data) ? data : data && data.results;
  if (!Array.isArray(rows) || !rows.length) return null;
  if (!rows[0] || !Array.isArray(rows[0].messages)) return null;
  const stats = summary();
  let errors = 0;
  let warnings = 0;
  const problems = [];
  for (const file of rows) {
    const messages = file.messages || [];
    for (const item of messages) {
      const severity = item.severity === 1 ? 'warning' : 'error';
      if (severity === 'warning') warnings += 1;
      else errors += 1;
      problems.push(
        problem({
          severity,
          message: item.message || '',
          code: item.ruleId || '',
          trace: place(
            file.filePath || '',
            item.line || 0,
            item.column || 0,
            root,
          ),
        }),
      );
    }
  }
  stats.errors = errors;
  stats.warnings = warnings;
  return report('eslint', { summary: stats, problems });
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
  const lines = `${text ?? ''}`.split(/\r?\n/);
  const problems = [];
  let file = '';
  let errors = 0;
  let warnings = 0;
  let seen = false;
  for (const line of lines) {
    const item = eslintLine(line);
    if (item) {
      seen = true;
      if (item.severity === 'warning') warnings += 1;
      else errors += 1;
      problems.push(
        problem({
          severity: item.severity,
          message: item.message,
          code: item.code,
          trace: place(file, item.line, item.column, root),
        }),
      );
      continue;
    }
    if (/✖\s+\d+\s+problems?\b/.test(line)) seen = true;
    if (isPathLine(line)) file = line.trim();
  }
  if (!seen) return null;
  const stats = summary();
  stats.errors = errors;
  stats.warnings = warnings;
  return report('eslint', { summary: stats, problems });
};

const tscLine = (line) => {
  const match = /^(.*)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/.exec(
    line.trim(),
  );
  if (!match) return null;
  return {
    file: match[1],
    line: match[2],
    column: match[3],
    code: match[4],
    message: match[5],
  };
};

const parseTsc = (text, root) => {
  const problems = [];
  for (const line of `${text ?? ''}`.split(/\r?\n/)) {
    const item = tscLine(line);
    if (!item) continue;
    problems.push(
      problem({
        message: item.message,
        code: item.code,
        trace: place(item.file, item.line, item.column, root),
      }),
    );
  }
  if (!problems.length) return null;
  const stats = summary();
  stats.errors = problems.length;
  return report('tsc', { summary: stats, problems });
};

const prettierFile = (line) => {
  const warn = /^\[(?:warn|error)\]\s+(\S+)$/.exec(line.trim());
  if (warn && !warn[1].startsWith('Code')) return warn[1];
  return '';
};

const parsePrettier = (text, root) => {
  const lines = `${text ?? ''}`.split(/\r?\n/);
  const problems = [];
  let seen = false;
  for (const line of lines) {
    if (line.includes('Code style issues')) seen = true;
    if (line.includes('All matched files use Prettier')) seen = true;
    const file = prettierFile(line);
    if (!file) continue;
    seen = true;
    problems.push(
      problem({
        message: 'format',
        trace: userTrace(file, root),
      }),
    );
  }
  if (!seen) return null;
  const stats = summary();
  stats.errors = problems.length;
  return report('prettier', { summary: stats, problems });
};

const auditProblems = (text) => {
  const audit = parseAuditReport(text);
  const problems = [];
  for (const item of audit.values()) {
    const extra = [];
    if (item.range) extra.push(['range', item.range]);
    if (item.fix) extra.push(['fix', item.fix]);
    problems.push(
      problem({
        severity: item.severity || 'error',
        name: item.name,
        message: item.title || '',
        extra,
      }),
    );
  }
  return problems;
};

const parseAudit = (text) => {
  const problems = auditProblems(text);
  if (!problems.length) return null;
  const stats = summary();
  stats.errors = problems.length;
  return report('audit', { summary: stats, problems });
};

const behind = (item) => {
  if (!item.current) return true;
  if (item.wanted && item.wanted !== item.current) return true;
  if (item.latest && item.latest !== item.current) return true;
  return false;
};

const parseOutdated = (text) => {
  const outdated = parseOutdatedReport(text);
  const problems = [];
  for (const [name, item] of outdated) {
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
  if (!message) return;
  problems.push(problem({ message }));
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
  if (!data.dependencies && !Array.isArray(data.problems)) return null;
  const problems = [];
  walkLs(data, problems);
  if (!problems.length && !Array.isArray(data.problems)) return null;
  const stats = summary();
  stats.errors = problems.length;
  return report('ls', { summary: stats, problems });
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
    problems.push(
      problem({
        severity: match[1].toLowerCase(),
        name,
        message: name,
      }),
    );
  }
  if (!problems.length) return null;
  const stats = summary();
  stats.errors = problems.length;
  return report('audit', { summary: stats, problems });
};

const parseToolText = (text, root) => {
  const reports = [];
  const eslint = parseEslintStylish(text, root);
  if (eslint) reports.push(eslint);
  const tsc = parseTsc(text, root);
  if (tsc) reports.push(tsc);
  const prettier = parsePrettier(text, root);
  if (prettier) reports.push(prettier);
  const audit = parseAuditText(text);
  if (audit) reports.push(audit);
  return reports;
};

module.exports = {
  parseEslintJson,
  parseEslintStylish,
  parseTsc,
  parsePrettier,
  parseAudit,
  parseOutdated,
  parseLs,
  parseToolJson,
  parseToolText,
};
