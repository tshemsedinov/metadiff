'use strict';

const tiles = require('./tiles.js');
const { seg, barSegments, sparkline, spinner } = tiles;
const table = require('./dash-table.js');
const { num, size, delta, cell, cellSegs, tableLines } = table;
const { pickGroups, labelOf, isHot, stat, pairRows, flexCell } = table;
const { withTitle, titleAside } = table;

const BAR_W = 6;

const waiting = (text) => ({
  badge: [],
  lines: [[seg(text, 'muted')]],
});

const FOLDER = '📁';

const groupName = (key, isDir, hot = false) => {
  const tone = hot ? 'warn' : 'sha';
  const label = seg(labelOf(key, isDir), tone, hot);
  const segs = isDir ? [seg(FOLDER), seg(' '), label] : [label];
  return cellSegs(segs);
};

const markCell = (isDir) => cell(isDir ? FOLDER : '');

const nameCell = (key, isDir, hot = false) => {
  const tone = hot ? 'warn' : 'sha';
  const name = cell(labelOf(key, isDir), tone, 'l', hot);
  name.flex = true;
  return name;
};

const share = (value, total) => (total > 0 ? value / total : 0);

const totalLabel = () => cell('total', 'text', 'l', true);

const fileRow = (group, isDir, data) => {
  const hot = (isDir ? data.hot.dirs : data.hot.exts).has(group.key);
  const ratio = share(group.bytes, data.total.bytes);
  return [
    markCell(isDir),
    nameCell(group.key, isDir, hot),
    cell(`${group.files}`, 'muted', 'r'),
    cell(size(group.bytes), 'text', 'r'),
    cell(num(group.lines), 'muted', 'r'),
    cellSegs(barSegments(ratio, BAR_W, 'sha')),
  ];
};

const filesTotal = (data, ctx) => {
  const { total } = data;
  const name = cell('');
  name.flex = true;
  const row = [
    cell(''),
    name,
    cell(`${total.files}`, 'text', 'r', true),
    cell(size(total.bytes), 'text', 'r', true),
    cell(num(total.lines), 'text', 'r', true),
    cell(''),
  ];
  const moved = data.delta ? data.delta.lines : 0;
  const change = delta(moved, ctx.now, data.delta?.at);
  if (change) row.push(cellSegs([change]));
  return row;
};

const fileHeaders = () => [
  cell('files', 'muted', 'r'),
  cell('size', 'muted', 'r'),
  cell('lines', 'muted', 'r'),
  cell(''),
];

const filesBlock = (model, width, height, ctx, tile) => {
  const data = model.files;
  if (!data.ready) return waiting('scanning…');
  const room = Math.max(0, height - 1);
  const picked = pickGroups(data.dirs, data.exts, room);
  const rows = [];
  for (const group of picked.dirs) rows.push(fileRow(group, true, data));
  for (const group of picked.exts) rows.push(fileRow(group, false, data));
  const all = [...rows, filesTotal(data, ctx)];
  const block = withTitle(tile, fileHeaders(), all, width, [], 1);
  return {
    badge: [],
    titleLine: block.titleLine,
    lines: block.lines.slice(0, -1),
    footer: block.lines.at(-1),
  };
};

const changeCells = (group) => [
  cell(`${group.files}`, 'muted', 'r'),
  cell(`+${group.stagedAdded}/${group.added}`, 'add', 'r'),
  cell(`-${group.stagedRemoved}/${group.removed}`, 'del', 'r'),
  cell(size(group.bytes), 'muted', 'r'),
];

const diffRow = (group, isDir) => [
  groupName(group.key, isDir),
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

const stagedAside = (data) => {
  const { totals } = data;
  const text = `staged ${totals.staged}/${totals.remaining}`;
  return [seg(text, 'muted')];
};

const trendFooter = (data, width) => {
  if (data.samples.length < 2) return null;
  const room = Math.max(0, width - 8);
  if (room < 2) return null;
  const trend = sparkline(data.samples, Math.min(room, 24));
  if (!trend) return null;
  return [seg('trend', 'muted'), seg('  '), seg(trend, 'sha')];
};

const diffsBlock = (model, width, height, ctx, tile) => {
  const data = model.diffs;
  if (!data.files) {
    const rows = pairRows([stat('changes', 'working tree clean', 'muted')], 1);
    return { badge: [], lines: tableLines(rows, width) };
  }
  const footer = trendFooter(data, width);
  const foot = footer ? 1 : 0;
  const room = Math.max(0, height - 1 - foot);
  const picked = pickGroups(data.dirs, data.exts, room);
  const rows = [diffsTotal(data, ctx)];
  for (const group of picked.dirs) rows.push(diffRow(group, true));
  for (const group of picked.exts) rows.push(diffRow(group, false));
  return {
    badge: [],
    titleLine: titleAside(tile, stagedAside(data), width),
    lines: tableLines(rows, width),
    footer,
  };
};

const auditTone = (value, tone) => (value ? tone : 'muted');

const known = (value) => (value === null ? '…' : `${value}`);

const warnMark = (value, tone) => {
  const text = known(value);
  if (!value) return [seg(text, 'muted')];
  return [seg('⚠️ '), seg(text, tone, true)];
};

const npmStats = (data) => {
  const modules = data.modules;
  const items = [
    stat('deps', `${data.deps}`, 'text', true),
    stat('dev', `${data.dev}`),
  ];
  if (data.optional) items.push(stat('optional', `${data.optional}`, 'muted'));
  items.push(
    stat('installed', modules ? `${modules.count}` : '…', 'muted'),
    stat('audit', warnMark(data.audit, 'error')),
    stat('outdated', warnMark(data.outdated, 'warn')),
    stat('proposals', `${data.proposals}`, auditTone(data.proposals, 'warn')),
  );
  return items;
};

const packageRows = (modules) => {
  const list = modules && modules.packages ? modules.packages : [];
  return list.map((pkg) => [
    flexCell(pkg.name, 'text'),
    cell(size(pkg.bytes), 'muted', 'r'),
  ]);
};

const npmBlock = (model, width, height, ctx, tile) => {
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
  const modules = data.modules;
  const disk = modules ? size(modules.bytes) : '…';
  const titleLine = titleAside(tile, [seg(disk, 'text', true)], width, badge);
  const stats = tableLines(pairRows(items, 2), width);
  const room = Math.max(0, height - stats.length);
  const listed = packageRows(modules).slice(0, room);
  const lines = [...stats, ...tableLines(listed, width)];
  return { badge: [], titleLine, lines: lines.slice(0, Math.max(0, height)) };
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
};
