'use strict';

const watch = require('./watch.js');
const runs = require('../runs.js');
const { UNKNOWN_PATH, MODULES_STAMP } = watch;
const { isRunsRel } = runs;

const TICK_ID = 'dashboard';
const HEAT_TIMER = 'dashboard-heat';
const AGE_TIMER = 'dashboard-age';
const SAMPLES = 40;
const SWITCHES = 4;
const GIT_NAMES = new Set([
  'HEAD',
  'packed-refs',
  'FETCH_HEAD',
  'ORIG_HEAD',
  'refs',
  'logs',
  'rebase-merge',
  'rebase-apply',
]);
const NPM_FILES = new Set(['package.json', 'package-lock.json', MODULES_STAMP]);
const AGE_FAST_MS = 1000;
const AGE_MID_MS = 30000;
const AGE_SLOW_MS = 600000;

class Coalesced {
  constructor(run, onDone) {
    this.run = run;
    this.onDone = onDone;
    this.running = false;
    this.dirty = false;
  }

  request() {
    this.dirty = true;
    if (!this.running) void this.pump();
  }

  async pump() {
    this.running = true;
    while (this.dirty) {
      this.dirty = false;
      try {
        await this.run();
      } catch {
        // keep the previous data until the next event
      }
    }
    this.running = false;
    this.onDone();
  }
}

const totalsKey = (totals) =>
  [
    totals.stagedAdded,
    totals.unstagedAdded,
    totals.stagedRemoved,
    totals.unstagedRemoved,
    totals.remaining,
  ].join(':');

const classify = (paths) => {
  const found = { files: [], git: false, npm: false, runs: false, all: false };
  for (const rel of paths) {
    if (rel === UNKNOWN_PATH) {
      found.all = true;
      continue;
    }
    if (rel.startsWith('.git/')) {
      if (GIT_NAMES.has(rel.split('/')[1])) found.git = true;
      continue;
    }
    if (isRunsRel(rel)) {
      found.runs = true;
      continue;
    }
    if (NPM_FILES.has(rel)) found.npm = true;
    found.files.push(rel);
  }
  return found;
};

const ageDelay = (ageMs) => {
  if (ageMs < 90000) return AGE_FAST_MS;
  if (ageMs < 5400000) return AGE_MID_MS;
  return AGE_SLOW_MS;
};

module.exports = {
  TICK_ID,
  HEAT_TIMER,
  AGE_TIMER,
  SAMPLES,
  SWITCHES,
  AGE_SLOW_MS,
  Coalesced,
  totalsKey,
  classify,
  ageDelay,
};
