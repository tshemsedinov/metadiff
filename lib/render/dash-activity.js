'use strict';

const tiles = require('./tiles.js');
const { seg, spinner } = tiles;
const table = require('./dash-table.js');
const { ago, duration, isHot, cell, cellSegs } = table;
const { flexCell, tableLines, stat, pairRows, titleAside } = table;

const NAME_MAX = 18;
const RECENT_SHOWN = 8;
const RUN_GAP = 3;

const waiting = (text) => ({ badge: [], lines: [[seg(text, 'muted')]] });

const ageCell = (at, now) => cell(at ? ago(at, now) : '', 'muted', 'r');

const rebaseText = (rebase) => {
  const total = rebase.total ? `/${rebase.total}` : '';
  const step = rebase.step ? `${rebase.step}` : '?';
  return `⟳ rebase ${step}${total}`;
};

const commitRow = (entry, ctx, hot) => {
  const tone = hot ? 'warn' : 'text';
  return [
    cell(entry.short, hot ? 'warn' : 'sha', 'l', true),
    flexCell(entry.subject, tone),
    ageCell(entry.at, ctx.now),
  ];
};

const commitsBlock = (model, width, height, ctx, tile) => {
  const data = model.commits;
  if (!data.ready) return waiting('reading git…');
  const info = data.info;
  const total = info ? info.total : 0;
  const badge = data.rebase ? [seg(rebaseText(data.rebase), 'warn', true)] : [];
  const aside = [seg(`${total}`, 'muted')];
  const titleLine = titleAside(tile, aside, width, badge);
  const recent = info && info.recent ? info.recent : [];
  if (!recent.length) {
    const lines = [[seg('none', 'muted')]];
    return { badge: [], titleLine, lines };
  }
  const hot = isHot(data.changedAt, ctx.now);
  const cap = Math.min(recent.length, RECENT_SHOWN, Math.max(0, height));
  const rows = [];
  for (let i = 0; i < cap; i++) {
    rows.push(commitRow(recent[i], ctx, hot && i === 0));
  }
  return { badge: [], titleLine, lines: tableLines(rows, width) };
};

const trackText = (entry) => {
  if (entry.gone) return 'gone';
  if (!entry.upstream) return '';
  const parts = [];
  if (entry.ahead) parts.push(`↑${entry.ahead}`);
  if (entry.behind) parts.push(`↓${entry.behind}`);
  return parts.length ? parts.join('') : '=';
};

const branchOrder = (list) =>
  [...list].sort((left, right) => {
    if (left.current !== right.current) return left.current ? -1 : 1;
    return right.at - left.at || left.name.localeCompare(right.name, 'en');
  });

const blinkTone = (frame) => (Math.abs(frame) % 2 ? 'hot' : 'warn');

const branchRow = (entry, data, ctx) => {
  const hot = isHot(data.hot.get(entry.name) ?? 0, ctx.now);
  const tone = hot ? blinkTone(ctx.frame) : 'text';
  const mark = entry.current ? '▶' : ' ';
  const name = entry.name.slice(0, NAME_MAX);
  const track = trackText(entry);
  const trackTone = entry.behind || entry.gone ? 'error' : 'warn';
  return [
    cellSegs([
      seg(mark, 'sha', true),
      seg(` ${name}`, tone, entry.current || hot),
    ]),
    cell(track, track === '=' ? 'muted' : trackTone),
    flexCell(entry.subject),
    ageCell(entry.at, ctx.now),
  ];
};

const branchExtras = (data, ctx) => {
  const rows = [];
  if (data.rebase) {
    const { step, total } = data.rebase;
    const text = `${step || '?'}${total ? `/${total}` : ''}`;
    rows.push([cell('rebase', 'muted'), cell(text, 'warn', 'l', true)]);
  }
  const last = data.switches[0];
  if (last) {
    rows.push([
      cell('switched', 'muted'),
      flexCell(`${last.from} → ${last.to}`),
      ageCell(last.at, ctx.now),
    ]);
  }
  return rows;
};

const branchesBlock = (model, width, height, ctx, tile) => {
  const data = model.branches;
  if (!data.ready) return waiting('reading git…');
  const badge = data.rebase ? [seg('⟳', 'warn', true)] : [];
  const aside = [seg(`${data.list.length}`, 'text', true)];
  const titleLine = titleAside(tile, aside, width, badge);
  if (!data.list.length) {
    const lines = [[seg('no branches', 'muted')]];
    return { badge: [], titleLine, lines };
  }
  const extras = branchExtras(data, ctx);
  const room = Math.max(1, height - extras.length);
  const shown = branchOrder(data.list).slice(0, room);
  const rows = shown.map((entry) => branchRow(entry, data, ctx));
  const lines = tableLines(rows, width);
  const fits = extras.slice(0, Math.max(0, height - lines.length));
  return {
    badge: [],
    titleLine,
    lines: [...lines, ...tableLines(fits, width)],
  };
};

const RUN_ICON = {
  passed: ['✔', 'add'],
  failed: ['✖', 'error'],
  aborted: ['⊘', 'muted'],
};

const runIcon = (run, ctx) => {
  if (run.status === 'running') return [spinner(ctx.frame), 'warn'];
  return RUN_ICON[run.status] ?? ['?', 'muted'];
};

const doneCount = (run) => run.done + run.failed;

const metric = (value, label, tone) => {
  if (typeof value !== 'number') return cell('', 'muted', 'r');
  return cell(`${value} ${label}`, tone, 'r');
};

const failTone = (value) => (value ? 'error' : 'muted');

const warnTone = (value) => (value ? 'warn' : 'muted');

const emptyMetrics = () => [
  cell('', 'muted', 'r'),
  cell('', 'muted', 'r'),
  cell('', 'muted', 'r'),
];

const testMetrics = (done, ok, fail) => [
  metric(done, 'done', 'text'),
  metric(ok, 'ok', ok ? 'add' : 'muted'),
  metric(fail, 'fail', failTone(fail)),
];

const lintMetrics = (errors, warnings) => [
  metric(errors, 'err', failTone(errors)),
  metric(warnings, 'warn', warnTone(warnings)),
  cell('', 'muted', 'r'),
];

const runMetrics = (run) => {
  const result = run.result;
  if (result && typeof result.tests === 'number') {
    const fail = result.failed ?? 0;
    const ok = result.passed ?? Math.max(0, result.tests - fail);
    return testMetrics(result.tests, ok, fail);
  }
  const live = run.status === 'running' && run.source !== 'reslop';
  if (live) return testMetrics(doneCount(run), run.done, run.failed);
  if (result && typeof result.errors === 'number') {
    const warnings = result.warnings;
    const warns = typeof warnings === 'number' ? warnings : null;
    return lintMetrics(result.errors, warns);
  }
  return emptyMetrics();
};

const runEnd = (run, ctx) => {
  if (run.status === 'running') {
    return cell(duration(ctx.now - run.startedAt), 'warn', 'r');
  }
  return ageCell(run.endedAt, ctx.now);
};

const named = (icon, tone, name, nameTone) => ({
  segs: [seg(icon, tone, true), seg(' '), seg(name, nameTone)],
  align: 'l',
  flex: true,
});

const runRow = (run, ctx) => {
  const icon = runIcon(run, ctx);
  const tone = run.status === 'running' ? 'text' : 'muted';
  const label = named(icon[0], icon[1], run.name, tone);
  return [label, ...runMetrics(run), runEnd(run, ctx)];
};

const busyRow = (model, ctx) => [
  named(spinner(ctx.frame), 'warn', model.busy, 'warn'),
];

const runsBlock = (model, width, height, ctx) => {
  const rows = [];
  if (model.busy) rows.push(busyRow(model, ctx));
  const running = model.runs.some((run) => run.status === 'running');
  for (const run of model.runs) rows.push(runRow(run, ctx));
  if (!rows.length) {
    const items = [
      stat('status', 'idle', 'muted'),
      stat('usage', 'reslop t -- <command>', 'muted'),
    ];
    rows.push(...pairRows(items, 1));
  }
  const spin = [seg(spinner(ctx.frame), 'warn', true)];
  const badge = running || model.busy ? spin : [];
  const shown = rows.slice(0, Math.max(1, height));
  return { badge, lines: tableLines(shown, width, RUN_GAP) };
};

module.exports = {
  commitsBlock,
  branchesBlock,
  runsBlock,
  trackText,
  rebaseText,
  runMetrics,
};
