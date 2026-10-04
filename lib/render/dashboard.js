'use strict';

const primitives = require('./primitives.js');
const { paintBodyFill, paneResult } = primitives;
const tiles = require('./tiles.js');
const { layoutTiles, paintTile, composeBands, tileHits, pageFill } = tiles;
const blocks = require('./dash-blocks.js');
const { filesBlock, diffsBlock, npmBlock, tasksBlock } = blocks;
const activity = require('./dash-activity.js');
const { commitsBlock, branchesBlock, runsBlock } = activity;
const agentsView = require('./agents.js');
const { agentsBlock } = agentsView;

const TILES = [
  {
    id: 'files',
    key: 'f',
    title: 'files',
    rank: 3,
    size: 'normal',
    build: filesBlock,
  },
  {
    id: 'diffs',
    key: 'd',
    title: 'diffs',
    rank: 0,
    size: 'normal',
    build: diffsBlock,
  },
  {
    id: 'tasks',
    key: 't',
    title: 'tasks',
    rank: 4,
    size: 'normal',
    build: tasksBlock,
  },
  {
    id: 'branches',
    key: 'b',
    title: 'branches',
    rank: 5,
    size: 'wide',
    build: branchesBlock,
  },
  {
    id: 'commits',
    key: 'c',
    title: 'commits',
    rank: 2,
    size: 'wide',
    build: commitsBlock,
  },
  {
    id: 'run',
    key: 'r',
    title: 'run',
    rank: 1,
    size: 'normal',
    build: runsBlock,
  },
  {
    id: 'npm',
    key: 'n',
    title: 'npm',
    rank: 6,
    size: 'normal',
    build: npmBlock,
  },
  {
    id: 'agents',
    key: 'a',
    title: 'agents',
    rank: 7,
    size: 'normal',
    build: agentsBlock,
  },
];
const TILE_BY_ID = new Map(TILES.map((tile) => [tile.id, tile]));
const MARGIN_MIN_H = 12;

const paintTiles = (model, bands, color) => {
  const painted = new Map();
  const ctx = { now: model.now, frame: model.frame };
  for (const band of bands) {
    for (const place of band.tiles) {
      const tile = TILE_BY_ID.get(place.id);
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
  const pad = new Array(margin).fill(pageFill(width, color));
  const body = [...pad, ...rows, ...pad];
  const fileHits = tileHits(bands, headerLines + margin);
  return paneResult({ body, fileHits });
};

module.exports = { TILES, paintBodyDashboard };
