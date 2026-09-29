'use strict';

const tiles = require('./tiles.js');
const { seg, barSegments, sparkline, spinner } = tiles;
const table = require('./dash-table.js');
const { num, size, delta, cell, cellSegs, tableLines } = table;
const { pickGroups, labelOf, isHot, stat, pairRows, flexCell } = table;

const BAR_W = 6;
const LABEL_W = 8;
const BAR_MIN_INNER = 44;

const waiting = (text) => ({
  badge: [],
  lines: [[seg(text, 'muted')]],
});

const hotLabel = (label, hot) => {
  const tone = hot ? 'warn' : 'text';
  return cellSegs([seg(hot ? '•' : ' ', 'warn', true), seg(label, tone, hot)]);
};

const share = (value, total) => (total > 0 ? value / total : 0);

const totalLabel = () => cellSegs([seg(' '), seg('total', 'text', true)]);

const fileRow = (group, isDir, data, wide) => {
  const hot = (isDir ? data.hot.dirs : data.hot.exts).has(group.key);
  const cells = [
    hotLabel(labelOf(group.key, isDir), hot),
    cell(`${group.files}`, 'muted', 'r'),
    cell(size(group.bytes), 'text', 'r'),
    cell(num(group.lines), 'muted', 'r'),
  ];
  if (!wide) return cells;
  const ratio = share(group.bytes, data.total.bytes);
  cells.push(cellSegs(barSegments(ratio, BAR_W, 'sha')));
  return cells;
};

const filesTotal = (data, ctx) => {
  const { total } = data;
  const row = [
    totalLabel(),
    cell(`${total.files}`, 'text', 'r', true),
    cell(size(total.bytes), 'text', 'r', true),
    cell(num(total.lines), 'text', 'r', true),
  ];
  const moved = data.delta ? data.delta.lines : 0;
  const change = delta(moved, ctx.now, data.delta?.at);
  if (change) row.push(cellSegs([change]));
  return row;
};

const filesBlock = (model, width, height, ctx) => {
  const data = model.files;
  if (!data.ready) return waiting('scanning…');
  const picked = pickGroups(data.dirs, data.exts, Math.max(0, height - 1));
  const wide = width >= BAR_MIN_INNER;
  const rows = [filesTotal(data, ctx)];
  for (const group of picked.dirs) rows.push(fileRow(group, true, data, wide));
  for (const group of picked.exts) rows.push(fileRow(group, false, data, wide));
  return { badge: [], lines: tableLines(rows, width) };
};

const changeCells = (group) => [
  cell(`${group.files}`, 'muted', 'r'),
  cell(`+${group.stagedAdded}/${group.added}`, 'add', 'r'),
  cell(`-${group.stagedRemoved}/${group.removed}`, 'del', 'r'),
  cell(size(group.bytes), 'muted', 'r'),
];

const diffRow = (group, isDir) => [
  cellSegs([seg(' '), seg(labelOf(group.key, isDir))]),
  ...changeCells(group),
];

const diffsTotal = (data, ctx) => {
  const { totals } = data;
  const bytes = data.dirs.reduce((sum, group) => sum + group.bytes, 0);
  const all = { ...totals, files: data.files, bytes };
  const row = [totalLabel(), ...changeCells(all)];
  for (const cellItem of row.slice(1, 4)) cellItem.segs[0].bold = true;
  const at = data.delta ? data.delta.at : 0;
  const moved = data.delta ? data.delta.added + data.delta.removed : 0;
  const change = delta(moved, ctx.now, at);
  if (change) row.push(cellSegs([change]));
  return row;
};

const diffsStats = (data, width) => {
  const { totals } = data;
  const changed = totals.added + totals.removed;
  const staged = totals.stagedAdded + totals.stagedRemoved;
  const room = Math.max(0, width - 16);
  const line = [seg(`${totals.staged}/${totals.remaining}  `)];
  line.push(...barSegments(share(staged, changed), BAR_W));
  const stats = [stat('staged', line)];
  const trend = sparkline(data.samples, Math.min(room, 24));
  if (data.samples.length > 1 && trend) {
    stats.push(stat('trend', [seg(trend, 'sha')]));
  }
  return stats;
};

const diffsBlock = (model, width, height, ctx) => {
  const data = model.diffs;
  if (!data.files) {
    const rows = pairRows([stat('changes', 'working tree clean', 'muted')], 1);
    return { badge: [], lines: tableLines(rows, width) };
  }
  const stats = diffsStats(data, width);
  const extra = stats.slice(0, Math.max(0, Math.min(stats.length, height - 3)));
  const room = Math.max(0, height - 1 - extra.length);
  const picked = pickGroups(data.dirs, data.exts, room);
  const rows = [diffsTotal(data, ctx)];
  for (const group of picked.dirs) rows.push(diffRow(group, true));
  for (const group of picked.exts) rows.push(diffRow(group, false));
  const lines = tableLines(rows, width);
  lines.push(...tableLines(pairRows(extra, 1), width));
  return { badge: [], lines };
};

const scriptLines = (scripts, width, room) => {
  const lines = [];
  let current = [];
  let used = 0;
  let shown = 0;
  for (const name of scripts) {
    const need = name.length + (current.length ? 2 : 0);
    if (used + need > width) {
      if (lines.length + 1 >= room) break;
      lines.push(current);
      current = [];
      used = 0;
    }
    if (current.length) current.push(seg('  '));
    current.push(seg(name, 'text'));
    used += need;
    shown += 1;
  }
  if (current.length) lines.push(current);
  const rest = scripts.length - shown;
  if (rest > 0 && lines.length) lines.at(-1).push(seg(`  +${rest}`, 'muted'));
  return lines;
};

const auditTone = (value, tone) => (value ? tone : 'muted');

const known = (value) => (value === null ? '…' : `${value}`);

const npmStats = (data) => {
  const modules = data.modules;
  const items = [
    stat('deps', `${data.deps}`, 'text', true),
    stat('dev', `${data.dev}`),
  ];
  if (data.optional) items.push(stat('optional', `${data.optional}`, 'muted'));
  items.push(
    stat('modules', modules ? size(modules.bytes) : '…'),
    stat('installed', modules ? `${modules.count}` : '…', 'muted'),
    stat('audit', known(data.audit), auditTone(data.audit, 'error')),
    stat('outdated', known(data.outdated), auditTone(data.outdated, 'warn')),
    stat('proposals', `${data.proposals}`, auditTone(data.proposals, 'warn')),
  );
  return items;
};

const scriptRows = (scripts, width, room) => {
  const names = scriptLines(scripts, Math.max(1, width - LABEL_W), room);
  return names.map((line, i) => [
    cell(i ? '' : 'scripts', 'muted'),
    cellSegs(line),
  ]);
};

const npmBlock = (model, width, height, ctx) => {
  const data = model.npm;
  if (!data.ready) return waiting('reading package.json…');
  if (!data.hasManifest) return waiting('no package.json');
  const items = npmStats(data);
  const badge = [];
  if (data.running) {
    badge.push(seg(spinner(ctx.frame), 'warn', true));
    items.push(stat('running', `${data.running}`, 'warn'));
  }
  if (isHot(data.changedAt, ctx.now)) {
    items.push(stat('updated', 'now', 'warn'));
  }
  const lines = tableLines(pairRows(items, 2), width);
  const room = Math.max(0, height - lines.length);
  if (room > 0 && data.scripts.length) {
    lines.push(...tableLines(scriptRows(data.scripts, width, room), width));
  }
  return { badge, lines };
};

const openRows = (texts) =>
  texts.map((text) => [cell('[ ]', 'muted'), flexCell(text, 'text')]);

const tasksBlock = (model, width, height) => {
  const data = model.tasks;
  const ratio = share(data.done, data.total);
  const items = [
    stat('done', `${data.done}/${data.total}`, 'text', true),
    stat('feedback', `${data.feedback}`),
    stat('progress', barSegments(ratio, BAR_W)),
    stat('code', `${data.code}`, 'muted'),
  ];
  const lines = tableLines(pairRows(items, 2), width);
  const room = Math.max(0, height - lines.length);
  lines.push(...tableLines(openRows(data.open.slice(0, room)), width));
  return { badge: [], lines };
};

module.exports = {
  filesBlock,
  diffsBlock,
  npmBlock,
  tasksBlock,
  scriptLines,
};
