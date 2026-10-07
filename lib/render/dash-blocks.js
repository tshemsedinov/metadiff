'use strict';

const { shortAge } = require('../files.js');
const { TOP_PACKAGES } = require('../dashboard/npm.js');
const { parseVersion, cmpVersion } = require('../utilities.js');
const { visibleWidth } = require('../ansi.js');
const { minuteOf } = require('../dashboard/model.js');
const { seg, barSegments, spinner } = require('./tiles.js');
const table = require('./dash-table.js');
const { num, size, delta, waiting, cell, cellSegs, flexCell } = table;
const { tableLines, pickGroups, labelOf, stat, pairRows } = table;
const { titleAside, captionOver } = table;

const BAR_W = 6;
const FOLDER = '📁';
const MARK_GAP = 1;
const ACTIVITY_LABEL = 'activity ';
const PULSE = '∙';
const TRACE = '─';
const ACTIVITY_MARK = [
  ['fail', 'x'],
  ['commit', '◉'],
  ['pass', '*'],
  ['abort', '!'],
  ['branch', '⎇'],
  ['rebase', '↻'],
  ['npm', '✦'],
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

const markGlyph = (marks) => {
  const list = marks ?? [];
  for (const [kind, glyph] of ACTIVITY_MARK) {
    if (list.includes(kind)) return glyph;
  }
  return '';
};

const diffGlyph = (bucket) => {
  if (!bucket) return '';
  const added = bucket.added || 0;
  const removed = bucket.removed || 0;
  if (removed > added) return '-';
  if (added > 0 || removed > 0 || bucket.level > 0) return '+';
  return '';
};

const pulseGlyph = (level) => {
  const index = heatIndex(level);
  if (index >= 4) return '█';
  if (index >= 3) return '•';
  return '◦';
};

const heatTone = (index) => {
  if (index === 4) return 'heat4';
  if (index === 3) return 'heat3';
  if (index === 2) return 'heat2';
  if (index === 1) return 'heat1';
  return 'muted';
};

const activityCell = (bucket, blink, pulse) => {
  const level = bucket ? bucket.level : 0;
  const glyph = markGlyph(bucket ? bucket.marks : null);
  const index = heatIndex(level);
  const mark = glyph || diffGlyph(bucket);
  const phase = blink ? pulseGlyph(level) : PULSE;
  const ch = pulse ? phase : mark || TRACE;
  const tone = blink ? 'blink' : heatTone(index);
  return seg(ch, tone, Boolean(glyph) && !pulse);
};

const activityCells = (activity, ctx, width) => {
  const minutes = activity && activity.minutes ? activity.minutes : [];
  const byAt = new Map();
  for (const row of minutes) {
    byAt.set(row.at, row);
  }
  const current = minuteOf(ctx.now);
  const flash = Boolean(activity && activity.live);
  const on = Math.abs(ctx.frame ?? 0) % 2 === 1;
  const body = Math.max(0, width - 2);
  const cells = [];
  for (let i = 0; i < body; i++) {
    const at = current - (body - 1 - i);
    const last = i === body - 1;
    const pulse = flash && last;
    const blink = pulse && on;
    cells.push(activityCell(byAt.get(at), blink, pulse));
  }
  return [seg(' ', 'muted'), ...cells, seg(' ', 'muted')];
};

const activityFooter = (data, width, ctx) => {
  const room = width - 1 - ACTIVITY_LABEL.length;
  if (room < 3) return null;
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
    footerFlush: true,
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

const npmStatus = (data) => {
  if (!data || !data.ready || !data.hasManifest) return '';
  const modules = data.modules || { count: 0, bytes: 0 };
  let text = `deps: ${data.deps}  dev: ${data.dev}`;
  text += `  all: ${modules.count} (${size(modules.bytes)})`;
  if (data.audit) text += `  🚨 ${data.audit}`;
  if (data.outdated) text += `  ⚠️ ${data.outdated}`;
  return text;
};

const cmpText = (left, right) => {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  return cmpVersion(a, b);
};

const boundHolds = (cmp, op) => {
  if (op === '<') return cmp < 0;
  if (op === '<=') return cmp <= 0;
  if (op === '>') return cmp > 0;
  return cmp >= 0;
};

const inClause = (version, clause) => {
  const ver = parseVersion(version);
  if (!ver) return false;
  const bounds = [...clause.matchAll(/(>=|<=|>|<)\s*(\d+\.\d+\.\d+)/g)];
  if (!bounds.length) return false;
  for (const match of bounds) {
    const bound = parseVersion(match[2]);
    if (!bound) return false;
    if (!boundHolds(cmpVersion(ver, bound), match[1])) return false;
  }
  return true;
};

const inRange = (version, range) =>
  `${range ?? ''}`.split('||').some((clause) => inClause(version, clause));

const hasRange = (range) => /[<>]=?\s*\d+\.\d+\.\d+/.test(`${range ?? ''}`);

const vulnTone = (text, pkg) => {
  if (!pkg.audit || !text || text === UNKNOWN) return '';
  const fix = pkg.fix || '';
  if (fix) {
    const cmp = cmpText(text, fix);
    if (cmp === null) return text === pkg.current ? 'error' : '';
    return cmp < 0 ? 'error' : 'add';
  }
  const range = pkg.range || '';
  if (hasRange(range)) {
    if (inRange(text, range)) return 'error';
    const cmp = cmpText(text, pkg.current);
    if (cmp !== null && cmp > 0) return 'add';
  }
  return text === pkg.current ? 'error' : '';
};

const isOutdated = (pkg) => {
  const current = pkg.current || '';
  const wanted = pkg.wanted || '';
  const latest = pkg.latest || '';
  if (!current || current === UNKNOWN) return false;
  if (wanted && wanted !== UNKNOWN && wanted !== current) return true;
  return Boolean(latest && latest !== UNKNOWN && latest !== current);
};

const fixesOutdated = (text, pkg) => {
  if (!isOutdated(pkg) || !text || text === UNKNOWN) return false;
  const current = pkg.current || '';
  const wanted = pkg.wanted || '';
  const latest = pkg.latest || '';
  if (text === wanted && wanted !== current) return true;
  return text === latest && latest !== current;
};

const versionTone = (text, pkg) => {
  const vuln = vulnTone(text, pkg);
  if (vuln) return vuln;
  if (fixesOutdated(text, pkg)) return 'add';
  if (text === pkg.current && isOutdated(pkg)) return 'warn';
  return 'muted';
};

const packageMark = (pkg, marks) => {
  if (!marks) return cell('');
  const segs = [];
  if (pkg.audit) segs.push(seg('🛑 vulnerability detected', 'error'));
  if (isOutdated(pkg)) {
    if (segs.length) segs.push(seg('  '));
    segs.push(seg('⚠️ outdated', 'warn'));
  }
  if (!segs.length) return cell('');
  return cellSegs(segs);
};

const nameTone = (pkg) => {
  if (pkg.transitive) return 'pkg';
  if (pkg.dev) return 'dev';
  return 'dep';
};

const packageName = (pkg) => {
  const segs = [seg(pkg.name, nameTone(pkg))];
  if (pkg.chain) segs.push(seg(` 🢒 ${pkg.chain}`, 'chain'));
  return {
    segs,
    align: 'l',
    flex: true,
    keep: true,
    measure: visibleWidth(pkg.name),
  };
};

const versionCell = (text, pkg) => cell(text, versionTone(text, pkg), 'r');

const packageHead = () => {
  const title = flexCell('');
  title.keep = true;
  return [
    title,
    cell(''),
    cell('current', 'muted', 'r'),
    cell('wanted', 'muted', 'r'),
    cell('latest', 'muted', 'r'),
    cell('size', 'muted', 'r'),
  ];
};

const packageRow = (pkg, marks) => {
  const current = pkg.current || UNKNOWN;
  const wanted = pkg.wanted || UNKNOWN;
  const latest = pkg.latest || UNKNOWN;
  return [
    packageName(pkg),
    packageMark(pkg, marks),
    versionCell(current, pkg),
    versionCell(wanted, pkg),
    versionCell(latest, pkg),
    cell(size(pkg.bytes), 'muted', 'r'),
  ];
};

const packageLines = (packages, width, limit) => {
  const all = limit === null;
  const headed = packages.length > 0 && (all || limit > 1);
  const room = all ? packages.length : Math.max(0, limit - (headed ? 1 : 0));
  const shown = packages.slice(0, room);
  const rows = shown.map((pkg) => packageRow(pkg, all));
  if (headed) rows.unshift(packageHead());
  return tableLines(rows, width);
};

const npmContent = (data, width, limit, ctx, tile) => {
  if (!data || !data.ready) return waiting('reading package.json…');
  if (!data.hasManifest) return waiting('no package.json');
  const badge = data.running ? [seg(spinner(ctx.frame), 'warn', true)] : [];
  const titleLine = titleAside(tile, npmAside(data), width, badge);
  const listed = data.modules && data.modules.packages;
  const packages = listed ? listed : [];
  const short = limit === null ? packages : packages.slice(0, TOP_PACKAGES);
  return { titleLine, lines: packageLines(short, width, limit) };
};

const npmBlock = (model, width, height, ctx, tile) =>
  npmContent(model.npm, width, height, ctx, tile);

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

module.exports = {
  filesBlock,
  diffsBlock,
  npmBlock,
  npmContent,
  npmStatus,
  tasksBlock,
};
