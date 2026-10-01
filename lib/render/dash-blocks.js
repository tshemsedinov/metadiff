'use strict';

const files = require('../files.js');
const { shortAge } = files;
const tiles = require('./tiles.js');
const { seg, barSegments, sparkline, spinner } = tiles;
const table = require('./dash-table.js');
const { num, size, delta, cell, cellSegs, tableLines } = table;
const { pickGroups, labelOf, stat, pairRows, flexCell } = table;
const { titleAside, captionOver, layoutRows } = table;

const BAR_W = 6;

const waiting = (text) => ({
  badge: [],
  lines: [[seg(text, 'muted')]],
});

const FOLDER = '📁';
const MARK_GAP = 1;

const markCell = (isDir) => cell(isDir ? FOLDER : '');

const nameCell = (key, isDir, hot = false) => {
  const tone = hot ? 'warn' : 'sha';
  const name = cell(labelOf(key, isDir), tone, 'l', hot);
  name.gap = MARK_GAP;
  return name;
};

const fileName = (key, isDir, hot = false) => {
  const name = nameCell(key, isDir, hot);
  name.flex = true;
  name.keep = true;
  return name;
};

const share = (value, total) => (total > 0 ? value / total : 0);

const fileRow = (group, isDir, data) => {
  const hot = (isDir ? data.hot.dirs : data.hot.exts).has(group.key);
  const ratio = share(group.bytes, data.total.bytes);
  return [
    markCell(isDir),
    fileName(group.key, isDir, hot),
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
  name.gap = MARK_GAP;
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
  const labels = [cell(''), cell(''), ...fileHeaders()];
  const laid = layoutRows([labels, ...all], width);
  return {
    badge: [],
    titleLine: captionOver(tile, laid.lines[0]),
    lines: laid.lines.slice(1, -1),
    footer: laid.lines.at(-1),
  };
};

const ratio = (sign, part, total) => `${sign}${part ?? 0}/${total ?? 0}`;

const changeCells = (group) => [
  cell(ratio('+', group.stagedAdded, group.added), 'add', 'r'),
  cell(ratio('-', group.stagedRemoved, group.removed), 'del', 'r'),
  cell(`${group.staged ?? 0}/${group.remaining ?? 0}`, 'text', 'r'),
  cell(shortAge(group.date), 'muted', 'r'),
];

const diffRow = (group, isDir) => [
  markCell(isDir),
  nameCell(group.key, isDir),
  ...changeCells(group),
];

const diffsHeader = (data, ctx) => {
  const { totals } = data;
  const name = cell('');
  name.gap = MARK_GAP;
  const summary = {
    added: totals.added ?? 0,
    removed: totals.removed ?? 0,
    stagedAdded: totals.stagedAdded ?? 0,
    stagedRemoved: totals.stagedRemoved ?? 0,
    staged: totals.staged ?? 0,
    remaining: totals.remaining ?? 0,
    date: '',
  };
  const row = [cell(''), name, ...changeCells(summary)];
  for (const cellItem of row.slice(2, 5)) cellItem.segs[0].bold = true;
  const moved = data.delta ? data.delta.added + data.delta.removed : 0;
  const change = delta(moved, ctx.now, data.delta?.at);
  if (change) row[row.length - 1] = cellSegs([change], 'r');
  return row;
};

const TREND_LABEL = 'trend  ';

const trendFooter = (data, width) => {
  if (data.samples.length < 2) return null;
  const room = width - TREND_LABEL.length;
  if (room < 2) return null;
  const trend = sparkline(data.samples, room);
  if (!trend) return null;
  return [seg(TREND_LABEL, 'muted'), seg(trend, 'trend')];
};

const diffsBlock = (model, width, height, ctx, tile) => {
  const data = model.diffs;
  if (!data.files) {
    const rows = pairRows([stat('changes', 'working tree clean', 'muted')], 1);
    return { badge: [], lines: tableLines(rows, width) };
  }
  const footer = trendFooter(data, width);
  const foot = footer ? 1 : 0;
  const room = Math.max(0, height - foot);
  const picked = pickGroups(data.dirs, data.exts, room);
  const rows = [diffsHeader(data, ctx)];
  for (const group of picked.dirs) rows.push(diffRow(group, true));
  for (const group of picked.exts) rows.push(diffRow(group, false));
  const laid = layoutRows(rows, width, 2, true);
  return {
    badge: [],
    titleLine: captionOver(tile, laid.lines[0]),
    lines: laid.lines.slice(1),
    footer,
  };
};

const countText = (value) =>
  value === null || value === undefined ? '…' : `${value}`;

const countSegs = (label, value) => [
  seg(`${label}: `, 'muted'),
  seg(countText(value), 'text'),
];

const markSegs = (value, tone, mark) => {
  if (!value) return [];
  return [seg(mark), seg(`${value}`, tone, true)];
};

const allSegs = (modules) => {
  const segs = countSegs('all', modules ? modules.count : null);
  const disk = modules ? size(modules.bytes) : '…';
  segs.push(seg(' (', 'muted'), seg(disk, 'text'), seg(')', 'muted'));
  return segs;
};

const npmAside = (data) => {
  const segs = [
    ...countSegs('deps', data.deps),
    seg('  '),
    ...countSegs('dev', data.dev),
    seg('  '),
    ...allSegs(data.modules),
  ];
  const audit = markSegs(data.audit, 'error', '🚨 ');
  const outdated = markSegs(data.outdated, 'warn', '⚠️ ');
  if (audit.length) segs.push(seg('  '), ...audit);
  if (outdated.length) segs.push(seg('  '), ...outdated);
  return segs;
};

const hasVersionFields = (pkg) =>
  Object.hasOwn(pkg, 'current') ||
  Object.hasOwn(pkg, 'wanted') ||
  Object.hasOwn(pkg, 'latest');

const versionText = (present, value) => (present && value ? value : '…');

const differs = (left, right) =>
  left !== '…' && right !== '…' && left !== right;

const versionTone = (text, base, audited) =>
  audited && text !== '…' ? 'error' : base;

const nameTone = (dev) => (dev ? 'sha' : 'add');

const packageName = (text, dev = false) => {
  const name = flexCell(text, nameTone(dev));
  name.keep = true;
  return name;
};

const nameTitle = () => {
  const title = flexCell('');
  title.keep = true;
  return title;
};

const packageHead = (versions) => {
  const row = [nameTitle()];
  if (versions) {
    row.push(cell('current', 'muted', 'r'));
    row.push(cell('wanted', 'muted', 'r'));
    row.push(cell('latest', 'muted', 'r'));
  }
  row.push(cell('size', 'muted', 'r'));
  return row;
};

const versionRows = (list, headed) => {
  const rows = headed ? [packageHead(true)] : [];
  for (const pkg of list) {
    const current = versionText(Object.hasOwn(pkg, 'current'), pkg.current);
    const wanted = versionText(Object.hasOwn(pkg, 'wanted'), pkg.wanted);
    const latest = versionText(Object.hasOwn(pkg, 'latest'), pkg.latest);
    const audited = pkg.audit === true;
    const currentTone = differs(current, wanted) ? 'warn' : 'muted';
    const wantedTone = differs(wanted, current) ? 'warn' : 'muted';
    const latestTone = differs(latest, wanted) ? 'warn' : 'muted';
    rows.push([
      packageName(pkg.name, pkg.dev),
      cell(current, versionTone(current, currentTone, audited), 'r'),
      cell(wanted, versionTone(wanted, wantedTone, audited), 'r'),
      cell(latest, versionTone(latest, latestTone, audited), 'r'),
      cell(size(pkg.bytes), 'muted', 'r'),
    ]);
  }
  return rows;
};

const packageRows = (list, headed) => {
  if (!list.some(hasVersionFields)) {
    const rows = headed ? [packageHead(false)] : [];
    for (const pkg of list) {
      rows.push([
        packageName(pkg.name, pkg.dev),
        cell(size(pkg.bytes), 'muted', 'r'),
      ]);
    }
    return rows;
  }
  return versionRows(list, headed);
};

const npmBlock = (model, width, height, ctx, tile) => {
  const data = model.npm;
  if (!data.ready) return waiting('reading package.json…');
  if (!data.hasManifest) return waiting('no package.json');
  const badge = [];
  if (data.running) badge.push(seg(spinner(ctx.frame), 'warn', true));
  const titleLine = titleAside(tile, npmAside(data), width, badge);
  const modules = data.modules;
  const packages = modules && modules.packages ? modules.packages : [];
  const headed = packages.length > 0 && height > 1;
  const shown = packages.slice(0, Math.max(0, height - (headed ? 1 : 0)));
  const lines = tableLines(packageRows(shown, headed), width);
  return { badge: [], titleLine, lines: lines.slice(0, Math.max(0, height)) };
};

const openRows = (texts) =>
  texts.map((text) => [cell('[ ]', 'muted'), flexCell(text, 'text')]);

const tasksBlock = (model, width, height, ctx, tile) => {
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
  const count = `${data.done}/${data.total}`;
  const titleLine = titleAside(tile, [seg(count, 'muted')], width);
  return { badge: [], titleLine, lines };
};

module.exports = {
  filesBlock,
  diffsBlock,
  npmBlock,
  tasksBlock,
};
