'use strict';

const { stripAnsi } = require('./ansi.js');
const model = require('./report-model.js');
const testParse = require('./report-test.js');
const toolParse = require('./report-tools.js');

const { problem, report, userTrace, groupReport, envelope } = model;
const { parseTap, parseNodeJsonl, parseTestJson, parseSpec } = testParse;
const { parseToolJson, parseToolText, stderrRest } = toolParse;

const COUNTS = ['tests', 'passed', 'failed', 'skipped', 'errors', 'warnings'];

const toolHint = (program, args) => {
  const name = program.split(/[/\\]/).pop();
  const joined = [name, ...args].join(' ');
  if (name === 'eslint' || name === 'tsc' || name === 'prettier') return name;
  if (/\baudit\b/.test(joined)) return 'audit';
  if (/\boutdated\b/.test(joined)) return 'outdated';
  const isNpm = name === 'npm' || name === 'pnpm' || name === 'npm.cmd';
  if (isNpm && /\b(ls|list)\b/.test(joined)) return 'ls';
  if (name === 'node' && args.includes('--test')) return 'test';
  return '';
};

const parseJson = (text) => {
  const trimmed = text.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
};

const parseJsonReports = (text, root) => {
  const node = parseNodeJsonl(text, root);
  if (node) return [node];
  const data = parseJson(text);
  if (!data) return null;
  const test = parseTestJson(data, root);
  if (test) return [test];
  return parseToolJson(data, root) || [];
};

const parseReports = (text, root) => {
  const json = parseJsonReports(text, root);
  if (json) return json;
  const tap = parseTap(text, root);
  const spec = tap ? null : parseSpec(text, root);
  const reports = [tap, ...parseToolText(text, root), spec];
  return reports.filter(Boolean);
};

const shortTail = (text) => text.trim().split(/\r?\n/).slice(-20).join('\n');

const withHint = (reports, text, exit, hint) => {
  if (reports.length || !text.trim() || exit === 0) return reports;
  const fallback = problem({ message: shortTail(text) });
  return [report(hint || 'test', { problems: [fallback] })];
};

const mergeSummary = (left, right) => {
  const stats = { ...left };
  for (const key of COUNTS) {
    if (right[key] === null) continue;
    stats[key] = (stats[key] ?? 0) + right[key];
  }
  if (!stats.duration && right.duration) stats.duration = right.duration;
  return stats;
};

const mergeReports = (left, right) => {
  const merged = left.slice();
  for (const item of right) {
    const at = merged.findIndex((entry) => entry.tool === item.tool);
    if (at < 0) {
      merged.push(item);
      continue;
    }
    const prev = merged[at];
    merged[at] = report(item.tool, {
      summary: mergeSummary(prev.summary, item.summary),
      problems: prev.problems.concat(item.problems),
    });
  }
  return merged;
};

const buildDocument = (stdout, stderr, root, exit, hint) => {
  const out = stripAnsi(stdout);
  const err = stripAnsi(stderr);
  const reports = mergeReports(
    parseReports(out, root),
    parseReports(err, root),
  );
  const text = out.trim() ? out : err;
  const grouped = withHint(reports, text, exit, hint).map(groupReport);
  const rest = stderrRest(err, grouped);
  return envelope(grouped, exit, userTrace(rest, root));
};

module.exports = {
  toolHint,
  buildDocument,
};
