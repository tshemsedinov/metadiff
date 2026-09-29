'use strict';

const tiles = require('./tiles.js');
const { seg, barSegments, spinner } = tiles;
const table = require('./dash-table.js');
const { ago, duration, isHot, cell, cellSegs } = table;
const { flexCell, tableLines, stat, pairRows } = table;

const RUN_BAR_W = 8;
const SUBJECT_LINES = 2;
const NAME_MAX = 18;

const waiting = (text) => ({ badge: [], lines: [[seg(text, 'muted')]] });

const rebaseText = (rebase) => {
  const total = rebase.total ? `/${rebase.total}` : '';
  const step = rebase.step ? `${rebase.step}` : '?';
  return `⟳ rebase ${step}${total}`;
};

const NAME_CAP = 14;

const pushedItems = (info) => {
  if (info.upstream === '' || info.pushed === null) {
    return [stat('upstream', 'none', 'muted')];
  }
  const total = info.pushed + info.unpushed;
  const ratio = total ? info.pushed / total : 1;
  const pushed = [seg(`${info.pushed} `), ...barSegments(ratio, 4, 'sha')];
  const tone = info.unpushed ? 'warn' : 'muted';
  const unpushed = `${info.unpushed}${info.unpushed ? ' ↑' : ''}`;
  const items = [
    stat('pushed', pushed),
    stat('unpushed', unpushed, tone, true),
  ];
  if (info.behind) items.push(stat('behind', `↓${info.behind}`, 'error', true));
  return items;
};

const lastItems = (info, ctx, at) => {
  const last = info.last;
  if (!last) return [stat('last', 'none', 'muted')];
  const hot = isHot(at, ctx.now);
  const mark = seg(hot ? '● ' : '', 'warn', true);
  const sha = [mark, seg(last.short, 'sha', true)];
  return [stat('last', sha), stat('when', ago(last.at, ctx.now), 'muted')];
};

const commitItems = (data, ctx) => {
  const info = data.info;
  const name = data.detached ? 'detached' : data.branch || '…';
  const fixTone = info.fixups ? 'warn' : 'muted';
  return [
    stat('branch', name.slice(0, NAME_CAP), 'text', true),
    stat('commits', `${info.total}`),
    ...pushedItems(info),
    stat('fixups', `${info.fixups}`, fixTone, info.fixups > 0),
    ...lastItems(info, ctx, data.changedAt),
  ];
};

const subjectRows = (info, width, room, hot) => {
  const last = info.last;
  if (!last) return [];
  const cap = Math.min(SUBJECT_LINES, room);
  const span = Math.max(8, width);
  const rows = [];
  for (let i = 0; i < cap; i++) {
    const part = last.subject.slice(i * span, (i + 1) * span);
    if (part) rows.push([flexCell(part, hot ? 'warn' : 'text')]);
  }
  return rows;
};

const commitsBlock = (model, width, height, ctx) => {
  const data = model.commits;
  if (!data.ready) return waiting('reading git…');
  const info = data.info;
  const badge = data.rebase ? [seg(rebaseText(data.rebase), 'warn', true)] : [];
  if (!info) {
    const rows = pairRows([stat('commits', 'none', 'muted')], 1);
    return { badge, lines: tableLines(rows, width) };
  }
  const lines = tableLines(pairRows(commitItems(data, ctx), 2), width);
  const room = Math.max(0, height - lines.length);
  const hot = isHot(data.changedAt, ctx.now);
  const subject = subjectRows(info, width, room, hot);
  lines.push(...tableLines(subject, width));
  return { badge, lines };
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
    cell(ago(entry.at, ctx.now), 'muted', 'r'),
    flexCell(entry.subject),
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
      cell(`${last.from} → ${last.to}`),
      cell(ago(last.at, ctx.now), 'muted', 'r'),
    ]);
  }
  return rows;
};

const branchesBlock = (model, width, height, ctx) => {
  const data = model.branches;
  if (!data.ready) return waiting('reading git…');
  if (!data.list.length) return waiting('no branches');
  const extras = branchExtras(data, ctx);
  const room = Math.max(1, height - extras.length);
  const shown = branchOrder(data.list).slice(0, room);
  const rows = shown.map((entry) => branchRow(entry, data, ctx));
  const lines = tableLines(rows, width);
  const badge = data.rebase ? [seg('⟳', 'warn', true)] : [];
  const fits = extras.slice(0, Math.max(0, height - lines.length));
  return { badge, lines: [...lines, ...tableLines(fits, width)] };
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

const runProgress = (run) => {
  const done = doneCount(run);
  if (!run.expected) {
    return [seg(`${done} ok`, 'text'), seg(` ${run.lines} lines`, 'muted')];
  }
  const ratio = Math.min(1, done / run.expected);
  const parts = barSegments(ratio, RUN_BAR_W, 'sha');
  const label = `${Math.min(done, run.expected)}/${run.expected}`;
  return [...parts, seg(` ${label}`, 'text')];
};

const resultText = (result) => {
  if (!result) return [];
  if (typeof result.tests === 'number') {
    const failed = result.failed ?? 0;
    if (failed) return [seg(`${failed} failed of ${result.tests}`, 'error')];
    return [seg(`${result.passed ?? result.tests}/${result.tests} passed`)];
  }
  const parts = [];
  if (typeof result.errors === 'number') {
    const tone = result.errors ? 'error' : 'muted';
    parts.push(seg(`errors ${result.errors}`, tone));
  }
  if (typeof result.warnings === 'number') {
    const tone = result.warnings ? 'warn' : 'muted';
    parts.push(seg(` warnings ${result.warnings}`, tone));
  }
  return parts;
};

const runStats = (run) => {
  if (run.status === 'running') {
    return run.source === 'reslop' ? [] : runProgress(run);
  }
  const stats = resultText(run.result);
  if (stats.length) return stats;
  if (run.status === 'failed') return [seg(`exit ${run.exit}`, 'error')];
  return [];
};

const runTime = (run, ctx) => {
  if (run.status === 'running') {
    return [seg(duration(ctx.now - run.startedAt), 'warn')];
  }
  const took = run.endedAt ? duration(run.endedAt - run.startedAt) : '';
  const when = run.endedAt ? ago(run.endedAt, ctx.now) : '';
  return [seg(`${took} ${when}`.trim(), 'muted')];
};

const runRow = (run, ctx) => {
  const icon = runIcon(run, ctx);
  const tone = run.status === 'running' ? 'text' : 'muted';
  const mark = cellSegs([seg(icon[0], icon[1], true)]);
  const command = { segs: [seg(run.command, tone)], align: 'l', flex: true };
  return [mark, command, cellSegs(runStats(run)), cellSegs(runTime(run, ctx))];
};

const busyRow = (model, ctx) => [
  cellSegs([seg(spinner(ctx.frame), 'warn', true)]),
  { segs: [seg(model.busy, 'warn')], align: 'l', flex: true },
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
  return { badge, lines: tableLines(shown, width) };
};

module.exports = {
  commitsBlock,
  branchesBlock,
  runsBlock,
  trackText,
  rebaseText,
};
