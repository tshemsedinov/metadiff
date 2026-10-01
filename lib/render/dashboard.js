'use strict';

const primitives = require('./primitives.js');
const { paintBodyFill, paneResult } = primitives;
const tiles = require('./tiles.js');
const { layoutTiles, paintTile, composeBands, tileHits } = tiles;
const { pageFill } = tiles;
const blocks = require('./dash-blocks.js');
const { filesBlock, diffsBlock, npmBlock, tasksBlock } = blocks;
const activity = require('./dash-activity.js');
const { commitsBlock, branchesBlock, runsBlock } = activity;

const TILES = [
  { id: 'files', key: 'f', title: 'files', rank: 3, build: filesBlock },
  { id: 'diffs', key: 'd', title: 'diffs', rank: 0, build: diffsBlock },
  { id: 'commits', key: 'c', title: 'commits', rank: 2, build: commitsBlock },
  {
    id: 'branches',
    key: 'b',
    title: 'branches',
    rank: 5,
    build: branchesBlock,
  },
  { id: 'npm', key: 'n', title: 'npm', rank: 6, build: npmBlock },
  { id: 'run', key: 'r', title: 'run', rank: 1, build: runsBlock },
  { id: 'tasks', key: 't', title: 'tasks', rank: 4, build: tasksBlock },
];

const MARGIN_MIN_H = 12;

const TILE_IDS = TILES.map((tile) => tile.id);

const paintTiles = (model, bands, color) => {
  const painted = new Map();
  const ctx = { now: model.now, frame: model.frame };
  for (const band of bands) {
    for (const place of band.tiles) {
      const tile = TILES.find((entry) => entry.id === place.id);
      const inner = Math.max(0, place.w - 2);
      const room = Math.max(0, band.h - 1);
      const content = tile.build(model, inner, room, ctx, tile);
      painted.set(place.id, paintTile(tile, content, place.w, band.h, color));
    }
  }
  return painted;
};

const paintBodyDashboard = (view, width, color, bodyH, headerLines) => {
  const model = view.dashboard;
  if (!model) {
    const blank = paintBodyFill(width, color, 'files');
    return paneResult({ body: new Array(bodyH).fill(blank) });
  }
  const margin = bodyH >= MARGIN_MIN_H ? 1 : 0;
  const height = bodyH - margin * 2;
  const bands = layoutTiles(width, height, TILES);
  const painted = paintTiles(model, bands, color);
  const rows = composeBands(bands, painted, width, height, color);
  const blank = pageFill(width, color);
  const pad = new Array(margin).fill(blank);
  const body = [...pad, ...rows, ...pad];
  const fileHits = tileHits(bands, headerLines + margin);
  return paneResult({ body, fileHits });
};

module.exports = { TILES, TILE_IDS, paintBodyDashboard };
