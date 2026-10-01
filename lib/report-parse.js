'use strict';

const ansi = require('./ansi.js');
const { stripAnsi } = ansi;
const model = require('./report-model.js');
const testParse = require('./report-test.js');
const toolParse = require('./report-tools.js');

const { problem, report, groupReport } = model;
const { reduceStderr, shortTail, envelope } = model;
const { parseTap, parseNodeJsonl, parseTestJson, parseSpec } = testParse;
const { parseToolJson, parseToolText, stderrRest } = toolParse;

const KNOWN = ['test', 'tsc', 'eslint', 'prettier', 'audit', 'outdated', 'ls'];

const toolHint = (program, args) => {
  const name = `${program ?? ''}`.split(/[/\\]/).pop();
  const list = args || [];
  const joined = [name, ...list].join(' ');
  if (name === 'eslint') return 'eslint';
  if (name === 'tsc') return 'tsc';
  if (name === 'prettier') return 'prettier';
  if (/\baudit\b/.test(joined)) return 'audit';
  if (/\boutdated\b/.test(joined)) return 'outdated';
  if (name === 'npm' || name === 'pnpm' || name === 'npm.cmd') {
    if (/\b(ls|list)\b/.test(joined)) return 'ls';
  }
  if (name === 'node' && (args || []).includes('--test')) return 'test';
  return '';
};

const parseJson = (text) => {
  const trimmed = `${text ?? ''}`.trim();
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
  const tools = parseToolJson(data, root);
  if (tools) return tools;
  return [];
};

const parseReports = (text, root) => {
  const json = parseJsonReports(text, root);
  if (json) return json;
  const reports = [];
  const tap = parseTap(text, root);
  if (tap) reports.push(tap);
  const tools = parseToolText(text, root);
  for (const item of tools) reports.push(item);
  if (!tap) {
    const spec = parseSpec(text, root);
    if (spec) reports.push(spec);
  }
  return reports;
};

const withHint = (reports, text, exit, hint) => {
  if (reports.length || !`${text ?? ''}`.trim() || exit === 0) return reports;
  const tool = KNOWN.includes(hint) ? hint : 'test';
  return [report(tool, { problems: [problem({ message: shortTail(text) })] })];
};

const sameTool = (left, right) => left.tool === right.tool;

const mergeSummary = (left, right) => {
  const stats = { ...left };
  const keys = ['tests', 'passed', 'failed', 'skipped', 'errors', 'warnings'];
  for (const key of keys) {
    if (right[key] === null || right[key] === undefined) continue;
    const empty = stats[key] === null || stats[key] === undefined;
    if (empty) stats[key] = right[key];
    else stats[key] += right[key];
  }
  if (!stats.duration && right.duration) stats.duration = right.duration;
  return stats;
};

const mergeReports = (left, right) => {
  const merged = left.slice();
  for (const item of right) {
    const at = merged.findIndex((entry) => sameTool(entry, item));
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
  const fromOut = parseReports(out, root);
  const fromErr = parseReports(err, root);
  const reports = mergeReports(fromOut, fromErr);
  const text = out.trim() ? out : err;
  const hinted = withHint(reports, text, exit, hint);
  const grouped = new Array(hinted.length);
  for (let i = 0; i < hinted.length; i++) grouped[i] = groupReport(hinted[i]);
  const rest = stderrRest(err, grouped);
  return envelope(grouped, exit, reduceStderr(rest, root));
};

module.exports = {
  toolHint,
  buildDocument,
};
