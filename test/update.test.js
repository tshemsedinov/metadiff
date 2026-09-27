'use strict';

const nodeTest = require('node:test');
const { test } = nodeTest;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const update = require('../lib/update.js');
const { parseVersion, cmpVersion, isNpmInstall, cacheFile } = update;
const { readCache, writeCache, isFresh, planUpdate } = update;
const { checkUpdate, markSkipped } = update;
const { CHECK_INTERVAL_MS } = update;
const helpers = require('./helpers.js');
const { tempDir } = helpers;

const cachePath = () => path.join(tempDir('reslop-cache-'), 'update.json');

test('parseVersion reads major minor patch', () => {
  assert.deepEqual(parseVersion('1.2.3'), {
    major: 1,
    minor: 2,
    patch: 3,
  });
  assert.deepEqual(parseVersion('0.1.5-prerelease'), {
    major: 0,
    minor: 1,
    patch: 5,
  });
  assert.equal(parseVersion('nope'), null);
});

test('cmpVersion orders by major then minor then patch', () => {
  const a = parseVersion('0.1.5');
  const b = parseVersion('0.1.6');
  const c = parseVersion('1.0.0');
  assert.ok(cmpVersion(b, a) > 0);
  assert.ok(cmpVersion(a, b) < 0);
  assert.ok(cmpVersion(c, a) > 0);
  assert.equal(cmpVersion(a, parseVersion('0.1.5')), 0);
});

test('isNpmInstall is true only under node_modules', () => {
  assert.equal(isNpmInstall('/usr/lib/node_modules/reslop'), true);
  assert.equal(isNpmInstall('/home/user/Tools/reslop'), false);
});

test('cacheFile uses XDG then platform cache dirs', () => {
  const xdg = cacheFile({ XDG_CACHE_HOME: '/tmp/xdg' });
  assert.equal(xdg, path.join('/tmp/xdg', 'reslop', 'update.json'));
  if (process.platform === 'win32') {
    const win = cacheFile({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' });
    assert.equal(
      win,
      path.join('C:\\Users\\me\\AppData\\Local', 'reslop', 'update.json'),
    );
  } else {
    const unix = cacheFile({});
    assert.equal(
      unix,
      path.join(os.homedir(), '.cache', 'reslop', 'update.json'),
    );
  }
});

test('readCache returns empty data when the file is missing', () => {
  const cache = readCache(path.join(tempDir('reslop-cache-'), 'missing.json'));
  assert.deepEqual(cache, {
    checkedAt: 0,
    compatible: '',
    major: '',
    skipped: '',
  });
});

test('writeCache and readCache round-trip', () => {
  const file = cachePath();
  writeCache(file, {
    checkedAt: 9,
    compatible: '0.1.6',
    major: '1.0.0',
    skipped: '1.0.0',
  });
  assert.deepEqual(readCache(file), {
    checkedAt: 9,
    compatible: '0.1.6',
    major: '1.0.0',
    skipped: '1.0.0',
  });
});

test('isFresh is true inside the check interval', () => {
  const cache = {
    checkedAt: 1000,
    compatible: '0.1.6',
    major: '',
    skipped: '',
  };
  assert.equal(isFresh(cache, 1000), true);
  assert.equal(isFresh(cache, 1000 + CHECK_INTERVAL_MS - 1), true);
  assert.equal(isFresh(cache, 1000 + CHECK_INTERVAL_MS), false);
  assert.equal(
    isFresh({ checkedAt: 0, compatible: '', major: '', skipped: '' }, 1),
    false,
  );
});

test('planUpdate installs patch and minor and confirms major', () => {
  assert.deepEqual(planUpdate('0.1.5', { latest: '0.1.5' }), {
    action: 'none',
  });
  assert.deepEqual(planUpdate('0.1.5', { latest: '0.1.6' }), {
    action: 'install',
    current: '0.1.5',
    latest: '0.1.6',
  });
  assert.deepEqual(planUpdate('0.1.5', { latest: '0.2.0' }), {
    action: 'install',
    current: '0.1.5',
    latest: '0.2.0',
  });
  assert.deepEqual(planUpdate('0.1.5', { latest: '1.0.0' }), {
    action: 'confirm',
    current: '0.1.5',
    latest: '1.0.0',
  });
  assert.deepEqual(planUpdate('0.1.5', { latest: '1.0.0', skipped: '1.0.0' }), {
    action: 'none',
  });
});

test('declined major still auto-installs later patch and minor', () => {
  const skipped = { skipped: '1.0.0', major: '1.0.0' };
  assert.deepEqual(planUpdate('0.1.5', { ...skipped, compatible: '0.1.6' }), {
    action: 'install',
    current: '0.1.5',
    latest: '0.1.6',
  });
  assert.deepEqual(planUpdate('0.1.5', { ...skipped, compatible: '0.2.0' }), {
    action: 'install',
    current: '0.1.5',
    latest: '0.2.0',
  });
});

test('declined major asks again when a newer major appears', () => {
  const skipped = { skipped: '1.0.0' };
  assert.deepEqual(planUpdate('0.1.5', { ...skipped, major: '1.0.0' }), {
    action: 'none',
  });
  assert.deepEqual(planUpdate('0.1.5', { ...skipped, major: '1.0.1' }), {
    action: 'confirm',
    current: '0.1.5',
    latest: '1.0.1',
  });
  assert.deepEqual(planUpdate('0.1.5', { ...skipped, major: '1.1.0' }), {
    action: 'confirm',
    current: '0.1.5',
    latest: '1.1.0',
  });
});

test('checkUpdate skips a source checkout', async () => {
  let fetched = 0;
  const plan = await checkUpdate({
    pkgDir: '/home/user/Tools/reslop',
    fetch: async () => {
      fetched += 1;
      return { ok: true, json: async () => ({ version: '1.0.0' }) };
    },
  });
  assert.equal(plan.action, 'skip');
  assert.equal(fetched, 0);
});

test('checkUpdate fetches when the cache is stale', async () => {
  const file = cachePath();
  let fetched = 0;
  const before = Date.now();
  const plan = await checkUpdate({
    enabled: true,
    current: '0.1.5',
    cacheFile: file,
    fetch: async () => {
      fetched += 1;
      return { ok: true, json: async () => ({ version: '0.1.6' }) };
    },
  });
  assert.equal(plan.action, 'install');
  assert.equal(plan.latest, '0.1.6');
  assert.equal(fetched, 1);
  const cache = readCache(file);
  assert.ok(cache.checkedAt >= before);
  assert.equal(cache.compatible, '0.1.6');
});

test('checkUpdate does not fetch again while the cache is fresh', async () => {
  const file = cachePath();
  writeCache(file, { checkedAt: Date.now(), compatible: '0.1.6' });
  let fetched = 0;
  const plan = await checkUpdate({
    enabled: true,
    current: '0.1.5',
    cacheFile: file,
    fetch: async () => {
      fetched += 1;
      return { ok: true, json: async () => ({ version: '9.9.9' }) };
    },
  });
  assert.equal(plan.action, 'none');
  assert.equal(fetched, 0);
});

test('readCache maps old latest and handled fields', () => {
  const file = cachePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ checkedAt: 9, latest: '1.0.0', handled: '1.0.0' }),
  );
  const cache = readCache(file);
  assert.equal(cache.major, '1.0.0');
  assert.equal(cache.skipped, '1.0.0');
});

test('checkUpdate still confirms a major from a fresh cache', async () => {
  const file = cachePath();
  writeCache(file, { checkedAt: Date.now(), major: '1.0.0' });
  let fetched = 0;
  const plan = await checkUpdate({
    enabled: true,
    current: '0.1.5',
    cacheFile: file,
    fetch: async () => {
      fetched += 1;
      return { ok: true, json: async () => ({ version: '1.0.0' }) };
    },
  });
  assert.equal(plan.action, 'confirm');
  assert.equal(plan.latest, '1.0.0');
  assert.equal(fetched, 0);
});

test('checkUpdate writes the check time when fetch fails', async () => {
  const file = cachePath();
  const before = Date.now();
  const plan = await checkUpdate({
    enabled: true,
    current: '0.1.5',
    cacheFile: file,
    fetch: async () => {
      throw new Error('offline');
    },
  });
  assert.equal(plan.action, 'none');
  const cache = readCache(file);
  assert.ok(cache.checkedAt >= before);
});

test('markSkipped stops a later confirm for the same major', async () => {
  const file = cachePath();
  writeCache(file, { checkedAt: Date.now(), major: '1.0.0', skipped: '' });
  markSkipped('1.0.0', { cacheFile: file });
  const plan = await checkUpdate({
    enabled: true,
    current: '0.1.5',
    cacheFile: file,
    fetch: async () => ({ ok: true, json: async () => ({ version: '2.0.0' }) }),
  });
  assert.equal(plan.action, 'none');
});

test('skipped major still installs a later compatible release', async () => {
  const file = cachePath();
  writeCache(file, {
    checkedAt: Date.now(),
    major: '1.0.0',
    skipped: '1.0.0',
  });
  const plan = await checkUpdate({
    enabled: true,
    current: '0.1.5',
    cacheFile: file,
    interval: 0,
    fetch: async () => ({
      ok: true,
      json: async () => ({
        versions: {
          '0.1.5': {},
          '0.1.6': {},
          '0.2.0': {},
          '1.0.0': {},
        },
      }),
    }),
  });
  assert.equal(plan.action, 'install');
  assert.equal(plan.latest, '0.2.0');
});

test('checkUpdate confirms a newer major after a skipped major', async () => {
  const file = cachePath();
  writeCache(file, {
    checkedAt: Date.now(),
    major: '1.0.0',
    skipped: '1.0.0',
  });
  const plan = await checkUpdate({
    enabled: true,
    current: '0.1.5',
    cacheFile: file,
    interval: 0,
    fetch: async () => ({
      ok: true,
      json: async () => ({
        versions: { '0.1.5': {}, '1.0.0': {}, '1.0.1': {}, '1.1.0': {} },
      }),
    }),
  });
  assert.equal(plan.action, 'confirm');
  assert.equal(plan.latest, '1.1.0');
});
