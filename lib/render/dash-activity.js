'use strict';

const { seg, spinner } = require('./tiles.js');
const table = require('./dash-table.js');
const { ago, duration, isHot, waiting, cell, cellSegs, flexCell } = table;
const { tableLines, stat, pairRows, titleAside, captionOver } = table;

const NAME_MAX = 18;
const RUN_ICON = {
  passed: ['✔', 'add'],
  failed: ['✖', 'error'],
  aborted: ['⊘', 'muted'],
};

const blankCell = () => cell('', 'muted', 'r');

const ageCell = (at, now) => cell(at ? ago(at, now) : '', 'muted', 'r');

const rebaseStep = (rebase) => {
  const total = rebase.total ? `/${rebase.total}` : '';
  return `${rebase.step || '?'}${total}`;
};

const commitRow = (entry, ctx, hot) => [
  cell(entry.short, hot ? 'warn' : 'sha', 'l', true),
  flexCell(entry.subject, hot ? 'warn' : 'text'),
  ageCell(entry.at, ctx.now),
];

const commitsBlock = (model, width, height, ctx, tile) => {
  const data = model.commits;
  if (!data.ready) return waiting('reading git…');
  const { total, recent } = data.info;
  const badge = [];
  if (data.rebase) {
    const step = rebaseStep(data.rebase);
    badge.push(seg(`⟳ rebase ${step}`, 'warn', true));
  }
  const titleLine = titleAside(tile, [seg(`${total}`, 'muted')], width, badge);
  if (!recent.length) return { titleLine, lines: [[seg('none', 'muted')]] };
  const hot = isHot(data.changedAt, ctx.now);
  const shown = recent.slice(0, Math.max(0, height));
  const rows = shown.map((entry, i) => commitRow(entry, ctx, hot && i === 0));
  return { titleLine, lines: tableLines(rows, width) };
};

const trackText = (entry) => {
  if (entry.gone) return 'gone';
  if (!entry.upstream) return '';
  const ahead = entry.ahead ? `↑${entry.ahead}` : '';
  const behind = entry.behind ? `↓${entry.behind}` : '';
  return ahead + behind || '=';
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
    const step = cell(rebaseStep(data.rebase), 'warn', 'l', true);
    rows.push([cell('rebase', 'muted'), step]);
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
  const aside = [seg(`${data.list.length}`, 'muted')];
  const titleLine = titleAside(tile, aside, width, badge);
  if (!data.list.length) {
    return { titleLine, lines: [[seg('no branches', 'muted')]] };
  }
  const extras = branchExtras(data, ctx);
  const room = Math.max(1, height - extras.length);
  const shown = branchOrder(data.list).slice(0, room);
  const rows = shown.map((entry) => branchRow(entry, data, ctx));
  const lines = tableLines(rows, width);
  const fits = extras.slice(0, Math.max(0, height - lines.length));
  return { titleLine, lines: [...lines, ...tableLines(fits, width)] };
};

const runIcon = (run, ctx) => {
  if (run.status === 'running') return [spinner(ctx.frame), 'warn'];
  return RUN_ICON[run.status] ?? ['?', 'muted'];
};

const countCell = (value, tone) => {
  if (typeof value !== 'number') return blankCell();
  return cell(`${value}`, tone, 'r');
};

const failTone = (value) => (value ? 'error' : 'muted');

const testMetrics = (done, ok, fail, total) => [
  countCell(done, 'text'),
  countCell(ok, ok ? 'add' : 'muted'),
  countCell(fail, failTone(fail)),
  countCell(total, 'text'),
];

const runMetrics = (run) => {
  const result = run.result;
  if (result && typeof result.tests === 'number') {
    const fail = result.failed ?? 0;
    const ok = result.passed ?? Math.max(0, result.tests - fail);
    return testMetrics(result.tests, ok, fail, result.tests);
  }
  const live = run.status === 'running' && run.source !== 'reslop';
  if (!live) return [blankCell(), blankCell(), blankCell(), blankCell()];
  const total = run.expected > 0 ? run.expected : null;
  return testMetrics(run.done + run.failed, run.done, run.failed, total);
};

const lintNote = (run) => {
  const result = run.result;
  if (!result || typeof result.tests === 'number') return [];
  const { errors, warnings } = result;
  if (typeof errors !== 'number') return [];
  const note = [seg(`  ${errors} err`, failTone(errors))];
  if (typeof warnings !== 'number') return note;
  note.push(seg(`  ${warnings} warn`, warnings ? 'warn' : 'muted'));
  return note;
};

const durationCell = (run, ctx) => {
  const running = run.status === 'running';
  const end = running ? ctx.now : run.endedAt;
  if (!run.startedAt || !end) return blankCell();
  return cell(duration(end - run.startedAt), running ? 'warn' : 'muted', 'r');
};

const named = (icon, tone, name, nameTone) => ({
  segs: [seg(icon, tone, true), seg(' '), seg(name, nameTone)],
  align: 'l',
  flex: true,
  min: 6,
});

const runHeader = () => [
  cell(''),
  cell('done', 'muted', 'r'),
  cell('ok', 'muted', 'r'),
  cell('fail', 'muted', 'r'),
  cell('total', 'muted', 'r'),
  cell('duration', 'muted', 'r'),
];

const runRow = (run, ctx) => {
  const icon = runIcon(run, ctx);
  const tone = run.status === 'running' ? 'text' : 'muted';
  const label = named(icon[0], icon[1], run.name, tone);
  label.segs.push(...lintNote(run));
  return [label, ...runMetrics(run), durationCell(run, ctx)];
};

const runsBlock = (model, width, height, ctx, tile) => {
  const rows = [];
  if (model.busy) {
    rows.push([named(spinner(ctx.frame), 'warn', model.busy, 'warn')]);
  }
  for (const run of model.runs) rows.push(runRow(run, ctx));
  if (!rows.length) {
    const items = [
      stat('status', 'idle', 'muted'),
      stat('usage', 'reslop t -- <command>', 'muted'),
    ];
    return { badge: [], lines: tableLines(pairRows(items, 1), width) };
  }
  const shown = rows.slice(0, Math.max(1, height));
  const lines = tableLines([runHeader(), ...shown], width);
  return {
    titleLine: captionOver(tile, lines[0]),
    lines: lines.slice(1),
  };
};

module.exports = { commitsBlock, branchesBlock, runsBlock, runMetrics };
