'use strict';

const { paintBodyFill, paneResult } = require('../primitives.js');
const tiles = require('../tiles.js');
const { layoutTiles, paintTile, composeBands, tileHits, pageFill } = tiles;
const blocks = require('./blocks.js');
const { filesBlock, diffsBlock, npmBlock, tasksBlock } = blocks;
const activity = require('./activity.js');
const { commitsBlock, branchesBlock, runsBlock } = activity;
const { agentsBlock } = require('../agents.js');
const { DASH_TILES } = require('../../input/actions.js');

const TILE_VIEW = {
  files: { rank: 3, size: 'normal', build: filesBlock },
  diffs: { rank: 0, size: 'normal', build: diffsBlock },
  tasks: { rank: 4, size: 'normal', build: tasksBlock },
  branches: { rank: 5, size: 'wide', build: branchesBlock },
  commits: { rank: 2, size: 'wide', build: commitsBlock },
  run: { rank: 1, size: 'normal', build: runsBlock },
  npm: { rank: 6, size: 'normal', build: npmBlock },
  agents: { rank: 7, size: 'normal', build: agentsBlock },
};

const TILES = DASH_TILES.map(({ id, key }) => ({
  id,
  key,
  title: id,
  ...TILE_VIEW[id],
}));

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
