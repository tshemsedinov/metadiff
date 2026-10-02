'use strict';

const files = require('../files.js');
const { shortAge } = files;
const ansi = require('../ansi.js');
const { THEME } = ansi;
const { minuteOf } = require('../dashboard/model.js');
const tiles = require('./tiles.js');
const { seg, barSegments, spinner } = tiles;
const table = require('./dash-table.js');
const { num, size, delta, waiting, cell, cellSegs, flexCell } = table;
const { tableLines, pickGroups, labelOf, stat, pairRows } = table;
const { titleAside, captionOver } = table;

const BAR_W = 6;
const FOLDER = '📁';
const MARK_GAP = 1;
const ACTIVITY_LABEL = 'activity ';
const ACTIVITY_MARK = [
  ['fail', '✖'],
  ['commit', '●'],
  ['pass', '✔'],
  ['abort', '⊘'],
  ['branch', '⇄'],
  ['rebase', '⟳'],
  ['npm', '◆'],
];
const UNKNOWN = '…';

const share = (value, total) => (total > 0 ? value / total : 0);

const markCell = (isDir) => cell(isDir ? FOLDER : '');

const nameCell = (key, isDir, hot = false) => {
  const name = cell(labelOf(key, isDir), hot ? 'warn' : 'sha', 'l', hot);
  name.gap = MARK_GAP;
  return name;
};

const fileName = (key, isDir, hot) => {
  const name = nameCell(key, isDir, hot);
  name.flex = true;
  name.keep = true;
  return name;
};

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

const filesBlock = (model, width, height, ctx, tile) => {
  const data = model.files;
  if (!data.ready) return waiting('scanning…');
  const picked = pickGroups(data.dirs, data.exts, height - 1);
  const labels = [
    cell(''),
    cell(''),
    cell('files', 'muted', 'r'),
    cell('size', 'muted', 'r'),
    cell('lines', 'muted', 'r'),
    cell(''),
  ];
  const rows = [labels];
  for (const group of picked.dirs) rows.push(fileRow(group, true, data));
  for (const group of picked.exts) rows.push(fileRow(group, false, data));
  rows.push(filesTotal(data, ctx));
  const lines = tableLines(rows, width);
  return {
    titleLine: captionOver(tile, lines[0]),
    lines: lines.slice(1, -1),
    footer: lines.at(-1),
  };
};

const ratio = (sign, part, total) => `${sign}${part}/${total}`;

const changeCells = (group, bold = false) => [
  cell(ratio('+', group.stagedAdded, group.added), 'add', 'r', bold),
  cell(ratio('-', group.stagedRemoved, group.removed), 'del', 'r', bold),
  cell(`${group.staged}/${group.remaining}`, 'text', 'r', bold),
  cell(shortAge(group.date), 'muted', 'r'),
];

const diffRow = (group, isDir) => [
  markCell(isDir),
  nameCell(group.key, isDir),
  ...changeCells(group),
];

const diffsHeader = (data, ctx) => {
  const name = cell('');
  name.gap = MARK_GAP;
  const row = [cell(''), name, ...changeCells(data.totals, true)];
  const moved = data.delta ? data.delta.added + data.delta.removed : 0;
  const change = delta(moved, ctx.now, data.delta?.at);
  if (change) row[row.length - 1] = cellSegs([change], 'r');
  return row;
};

const heatIndex = (level) => {
  if (level >= 301) return 4;
  if (level >= 81) return 3;
  if (level >= 16) return 2;
  if (level >= 1) return 1;
  return 0;
};

const heatColor = (index) => {
  if (index === 1) return THEME.heat1;
  if (index === 2) return THEME.heat2;
  if (index === 3) return THEME.heat3;
  if (index === 4) return THEME.heat4;
  return null;
};

const markGlyph = (marks) => {
  const list = marks ?? [];
  for (const [kind, glyph] of ACTIVITY_MARK) {
    if (list.includes(kind)) return glyph;
  }
  return '';
};

const activityCell = (bucket, blink) => {
  const level = bucket ? bucket.level : 0;
  const glyph = markGlyph(bucket ? bucket.marks : null);
  const index = heatIndex(level);
  const ch = glyph || (index ? '·' : ' ');
  const item = seg(ch, blink ? 'blink' : 'heat', Boolean(glyph));
  item.bg = blink ? THEME.heatBlink : heatColor(index);
  return item;
};

const activityCells = (activity, ctx, width) => {
  const minutes = activity && activity.minutes ? activity.minutes : [];
  const byAt = new Map();
  for (const row of minutes) byAt.set(row.at, row);
  const current = minuteOf(ctx.now);
  const flash = Boolean(activity && activity.live);
  const on = Math.abs(ctx.frame ?? 0) % 2 === 1;
  const cells = [];
  for (let i = 0; i < width; i++) {
    const at = current - (width - 1 - i);
    const blink = flash && on && i === width - 1;
    cells.push(activityCell(byAt.get(at), blink));
  }
  return cells;
};

const activityFooter = (data, width, ctx) => {
  const room = width - ACTIVITY_LABEL.length;
  if (room < 2) return null;
  const cells = activityCells(data.activity, ctx, room);
  return [seg(ACTIVITY_LABEL, 'muted'), ...cells];
};

const diffsBlock = (model, width, height, ctx, tile) => {
  const data = model.diffs;
  if (!data.files) {
    const rows = pairRows([stat('changes', 'working tree clean', 'muted')], 1);
    return { badge: [], lines: tableLines(rows, width) };
  }
  const footer = activityFooter(data, width, ctx);
  const room = footer ? height - 1 : height;
  const picked = pickGroups(data.dirs, data.exts, room);
  const rows = [diffsHeader(data, ctx)];
  for (const group of picked.dirs) rows.push(diffRow(group, true));
  for (const group of picked.exts) rows.push(diffRow(group, false));
  const lines = tableLines(rows, width, 2, true);
  return {
    titleLine: captionOver(tile, lines[0]),
    lines: lines.slice(1),
    footer,
  };
};

const countSegs = (label, value) => [
  seg(`${label}: `, 'muted'),
  seg(`${value}`, 'text'),
];

const markSegs = (value, tone, mark) => {
  if (!value) return [];
  return [seg('  '), seg(mark), seg(`${value}`, tone, true)];
};

const npmAside = (data) => {
  const modules = data.modules;
  return [
    ...countSegs('deps', data.deps),
    seg('  '),
    ...countSegs('dev', data.dev),
    seg('  '),
    ...countSegs('all', modules.count),
    seg(' (', 'muted'),
    seg(size(modules.bytes), 'text'),
    seg(')', 'muted'),
    ...markSegs(data.audit, 'error', '🚨 '),
    ...markSegs(data.outdated, 'warn', '⚠️ '),
  ];
};

const differs = (left, right) =>
  left !== UNKNOWN && right !== UNKNOWN && left !== right;

const versionCell = (text, changed, audited) => {
  const base = changed ? 'warn' : 'muted';
  const tone = audited && text !== UNKNOWN ? 'error' : base;
  return cell(text, tone, 'r');
};

const packageHead = () => {
  const title = flexCell('');
  title.keep = true;
  return [
    title,
    cell('current', 'muted', 'r'),
    cell('wanted', 'muted', 'r'),
    cell('latest', 'muted', 'r'),
    cell('size', 'muted', 'r'),
  ];
};

const packageRow = (pkg) => {
  const name = flexCell(pkg.name, pkg.dev ? 'sha' : 'add');
  name.keep = true;
  const current = pkg.current || UNKNOWN;
  const wanted = pkg.wanted || UNKNOWN;
  const latest = pkg.latest || UNKNOWN;
  return [
    name,
    versionCell(current, differs(current, wanted), pkg.audit),
    versionCell(wanted, differs(wanted, current), pkg.audit),
    versionCell(latest, differs(latest, wanted), pkg.audit),
    cell(size(pkg.bytes), 'muted', 'r'),
  ];
};

const npmBlock = (model, width, height, ctx, tile) => {
  const data = model.npm;
  if (!data.ready) return waiting('reading package.json…');
  if (!data.hasManifest) return waiting('no package.json');
  const badge = data.running ? [seg(spinner(ctx.frame), 'warn', true)] : [];
  const titleLine = titleAside(tile, npmAside(data), width, badge);
  const packages = data.modules.packages;
  const headed = packages.length > 0 && height > 1;
  const shown = packages.slice(0, Math.max(0, height - (headed ? 1 : 0)));
  const rows = shown.map(packageRow);
  if (headed) rows.unshift(packageHead());
  return { titleLine, lines: tableLines(rows, width) };
};

const TASK_GAP = 2;

const ratioLabel = (done, total) => `${done}/${total}`;

const taskSpecs = (data) => {
  const rows = [{ title: '', done: data.done, total: data.total, bold: true }];
  for (const kind of data.kinds) {
    rows.push({
      title: kind.title,
      done: kind.done,
      total: kind.total,
      bold: false,
    });
  }
  return rows;
};

const widest = (rows, read) => {
  let width = 0;
  for (const row of rows) {
    const size = read(row).length;
    if (size > width) width = size;
  }
  return width;
};

const taskBarWidth = (width, nameW, ratioW) => {
  const room = width - nameW - ratioW - TASK_GAP * 2;
  return room > 0 ? room : 0;
};

const taskLine = (row, barW) => {
  const tone = row.bold ? 'text' : 'muted';
  const line = [cell(row.title, 'text', 'l', row.bold)];
  if (barW > 0) {
    line.push(cellSegs(barSegments(share(row.done, row.total), barW)));
  }
  line.push(cell(ratioLabel(row.done, row.total), tone, 'r', row.bold));
  return line;
};

const tasksBlock = (model, width, height, ctx, tile) => {
  const specs = taskSpecs(model.tasks);
  const nameW = widest(specs, (row) => row.title);
  const ratioW = widest(specs, (row) => ratioLabel(row.done, row.total));
  const barW = taskBarWidth(width, nameW, ratioW);
  const rows = specs.map((row) => taskLine(row, barW));
  const lines = tableLines(rows, width, TASK_GAP);
  const shown = Math.max(0, height);
  return {
    titleLine: captionOver(tile, lines[0]),
    lines: lines.slice(1, 1 + shown),
  };
};

module.exports = { filesBlock, diffsBlock, npmBlock, tasksBlock };
