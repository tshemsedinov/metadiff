'use strict';

const ansi = require('../ansi.js');
const { THEME } = ansi;
const primitives = require('./primitives.js');
const { paintBodyFill, paneResult } = primitives;
const tiles = require('./tiles.js');
const { seg, spinner, equalGrid, pageWindow, placeEqualTiles } = tiles;
const { paintTile, composeBands, tileHits, pageFill } = tiles;
const { segmentsWidth, clipSegments } = tiles;
const table = require('./dash-table.js');
const { size, isHot } = table;

const REPO_MIN_H = 6;
const MARGIN_MIN_H = 12;
const EXT_LIMIT = 3;
const DIM_BACKS = {
  head: THEME.dashDimHeadBg,
  tile: THEME.dashDimTileBg,
  row: THEME.dashDimRowBg,
};
const RUN_ICON = {
  passed: ['✔', 'add'],
  failed: ['✖', 'error'],
  aborted: ['⊘', 'muted'],
};

const extName = (key) => {
  const text = `${key ?? ''}`;
  if (!text || text === '(none)') return 'none';
  return text.startsWith('.') ? text.slice(1) : text;
};

const blinkTone = (frame) => (Math.abs(frame) % 2 ? 'hot' : 'warn');

const spin = (frame) => seg(spinner(frame), 'warn', true);

const rowPending = (row) =>
  !row.filesReady ||
  !row.commitsReady ||
  !row.diffReady ||
  !row.tasksReady ||
  !row.runsReady;

const fitAside = (left, right, width) => {
  const rightW = segmentsWidth(right);
  const room = Math.max(0, width - rightW - 1);
  const clipped = clipSegments(left, room);
  const gap = Math.max(1, width - segmentsWidth(clipped) - rightW);
  return [...clipped, seg(' '.repeat(gap)), ...right];
};

const titleLine = (row, ctx, selected, width) => {
  const hot = isHot(row.activityAt, ctx.now);
  const tone = hot ? blinkTone(ctx.frame) : 'text';
  const left = [seg(row.name, tone, selected || hot)];
  if (hot) left.push(seg(' ●', tone, true));
  const right = [];
  if (rowPending(row)) right.push(spin(ctx.frame), seg(' '));
  const label = row.filesReady ? size(row.bytes) : '…';
  const sizeTone = row.filesReady ? 'text' : 'muted';
  right.push(seg(label, sizeTone, row.filesReady));
  return fitAside(left, right, width);
};

const extLine = (row, ctx) => {
  if (!row.filesReady) return [spin(ctx.frame)];
  const exts = row.exts.slice(0, EXT_LIMIT);
  if (!exts.length) return [seg('no files', 'muted')];
  const segs = [];
  for (let i = 0; i < exts.length; i++) {
    if (i) segs.push(seg('  '));
    segs.push(seg(extName(exts[i].key), 'sha'));
    segs.push(seg(` ${size(exts[i].bytes)}`, 'text'));
  }
  return segs;
};

const countValue = (ready, text, frame) =>
  ready ? seg(text, 'text', true) : spin(frame);

const countLine = (row, ctx) => [
  seg('tasks: ', 'muted'),
  countValue(row.tasksReady, `${row.tasksDone}/${row.tasks}`, ctx.frame),
  seg('   commits: ', 'muted'),
  countValue(row.commitsReady, `${row.commits}`, ctx.frame),
];

const resultNote = (run) => {
  const result = run.result;
  if (!result) return [];
  if (typeof result.tests === 'number') {
    const note = [seg(` ${result.tests}`, 'muted')];
    if (result.failed) note.push(seg(` ${result.failed} fail`, 'error'));
    return note;
  }
  if (typeof result.errors === 'number') {
    return [seg(` ${result.errors} err`, result.errors ? 'error' : 'muted')];
  }
  return [];
};

const runLine = (row, ctx) => {
  if (!row.runsReady) return [seg('run: ', 'muted'), spin(ctx.frame)];
  const run = row.run;
  if (!run) return [seg('run: ', 'muted'), seg('idle', 'muted')];
  if (run.status === 'running') {
    const seen = run.done + run.failed;
    const total = run.expected > 0 ? `/${run.expected}` : '';
    const fail = run.failed ? ` ${run.failed} fail` : '';
    return [
      seg(`${spinner(ctx.frame)} `, 'warn', true),
      seg(run.name || 'run', 'text'),
      seg(` ${seen}${total}${fail}`, 'warn'),
    ];
  }
  const icon = RUN_ICON[run.status] ?? ['?', 'muted'];
  return [
    seg(`${icon[0]} `, icon[1], true),
    seg(run.name || 'run', 'text'),
    seg(` ${run.status}`, icon[1]),
    ...resultNote(run),
  ];
};

const diffLine = (row, ctx) => {
  if (!row.diffReady) return [seg('diff: ', 'muted'), spin(ctx.frame)];
  const diff = row.diff;
  const added = diff.stagedAdded + diff.unstagedAdded;
  const removed = diff.stagedRemoved + diff.unstagedRemoved;
  return [
    seg('diff: ', 'muted'),
    seg(`+${diff.stagedAdded}/${added}`, 'add'),
    seg('  '),
    seg(`-${diff.stagedRemoved}/${removed}`, 'del'),
  ];
};

const repoContent = (row, ctx, selected, width) => ({
  titleLine: titleLine(row, ctx, selected, width),
  lines: [
    extLine(row, ctx),
    countLine(row, ctx),
    runLine(row, ctx),
    diffLine(row, ctx),
  ],
});

const paintRepos = (model, bands, color) => {
  const painted = new Map();
  const ctx = { now: model.now, frame: model.frame };
  const selected = model.tiles[model.cursor];
  const selectedId = selected ? selected.id : '';
  for (const band of bands) {
    for (const place of band.tiles) {
      const row = model.tiles.find((tile) => tile.id === place.id);
      if (!row) continue;
      const tile = { id: row.id, key: '', title: row.name };
      const inner = Math.max(0, place.w - 2);
      const picked = row.id === selectedId;
      const content = repoContent(row, ctx, picked, inner);
      const backs = picked ? null : DIM_BACKS;
      const rows = paintTile(tile, content, place.w, band.h, color, backs);
      painted.set(place.id, rows);
    }
  }
  return painted;
};

const paintBodyRepos = (view, width, color, bodyH, headerLines) => {
  const model = view.repos;
  if (!model || !model.tiles.length) {
    const blank = paintBodyFill(width, color, 'files');
    return paneResult({ body: new Array(bodyH).fill(blank) });
  }
  const margin = bodyH >= MARGIN_MIN_H ? 1 : 0;
  const height = Math.max(1, bodyH - margin * 2);
  const grid = equalGrid(width, height, model.tiles.length, 34, REPO_MIN_H);
  const page = pageWindow(model.tiles.length, model.cursor, grid.cap);
  const shown = model.tiles.slice(page.start, page.end);
  const bands = placeEqualTiles(shown, grid);
  model.cols = grid.cols;
  const painted = paintRepos(model, bands, color);
  const rows = composeBands(bands, painted, width, height, color);
  const pad = new Array(margin).fill(pageFill(width, color));
  const body = [...pad, ...rows, ...pad];
  const fileHits = tileHits(bands, headerLines + margin);
  return paneResult({ body, fileHits });
};

module.exports = { REPO_MIN_H, extName, paintBodyRepos };
