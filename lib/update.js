'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const metautil = require('metautil');
const { jsonParse, isHashObject } = metautil;
const utilities = require('./utilities.js');
const { parseVersion, cmpVersion, npmBin } = utilities;
const { npmOpts, runProc, oneLine } = utilities;

const PKG = require('../package.json');

const PKG_NAME = PKG.name;
const PKG_VERSION = PKG.version;
const PKG_DIR = path.resolve(__dirname, '..');
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
const FETCH_MS = 8000;
const INSTALL_MS = 120000;
const REGISTRY = 'https://registry.npmjs.org';

const RELEASE = /^\d+\.\d+\.\d+$/;
const emptyCache = () => ({
  checkedAt: 0,
  compatible: '',
  major: '',
  skipped: '',
});

const asText = (value) => (typeof value === 'string' ? value : '');

const toInt = (text) => parseInt(text, 10);

const isNpmInstall = (pkgDir) => {
  const parent = path.basename(path.dirname(pkgDir));
  return parent === 'node_modules';
};

const cacheFile = (env = process.env) => {
  if (env.XDG_CACHE_HOME) {
    return path.join(env.XDG_CACHE_HOME, 'reslop', 'update.json');
  }
  if (process.platform === 'win32') {
    const local =
      env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'reslop', 'update.json');
  }
  return path.join(os.homedir(), '.cache', 'reslop', 'update.json');
};

const readCache = (file) => {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const data = jsonParse(text);
    if (!isHashObject(data)) {
      return emptyCache();
    }
    const checkedAt = toInt(data.checkedAt) || 0;
    const compatible = asText(data.compatible);
    const major = asText(data.major) || asText(data.latest);
    const skipped = asText(data.skipped) || asText(data.handled);
    return { checkedAt, compatible, major, skipped };
  } catch {
    return emptyCache();
  }
};

const writeCache = (file, data) => {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const checkedAt = data.checkedAt ?? 0;
    const compatible = data.compatible ?? '';
    const major = data.major ?? '';
    const skipped = data.skipped ?? '';
    const body = JSON.stringify({ checkedAt, compatible, major, skipped });
    fs.writeFileSync(file, `${body}\n`);
  } catch {
    // ignore cache write errors
  }
};

const isFresh = (cache, now, interval = CHECK_INTERVAL_MS) => {
  if (!cache || !cache.checkedAt) return false;
  if (now < cache.checkedAt) return false;
  return now - cache.checkedAt < interval;
};

const listVersions = (data) => {
  if (!data || typeof data !== 'object') return [];
  const names = [];
  const map = data.versions;
  if (isHashObject(map)) {
    for (const name of Object.keys(map)) names.push(name);
  }
  const tags = data['dist-tags'];
  if (tags && typeof tags.latest === 'string') names.push(tags.latest);
  if (typeof data.version === 'string') names.push(data.version);
  const listed = [];
  for (const name of names) {
    if (!RELEASE.test(name)) continue;
    if (listed.includes(name)) continue;
    listed.push(name);
  }
  return listed;
};

const pickNewerName = (best, name, ver) => {
  if (!best) return name;
  const prev = parseVersion(best);
  if (!prev || cmpVersion(ver, prev) > 0) return name;
  return best;
};

const pickTargets = (current, names) => {
  const from = parseVersion(current);
  if (!from) return { compatible: '', major: '' };
  let compatible = '';
  let major = '';
  for (const name of names) {
    const ver = parseVersion(name);
    if (!ver) continue;
    if (cmpVersion(ver, from) <= 0) continue;
    if (ver.major === from.major) {
      compatible = pickNewerName(compatible, name, ver);
      continue;
    }
    if (ver.major > from.major) major = pickNewerName(major, name, ver);
  }
  return { compatible, major };
};

const classifyLatest = (current, latest) => {
  const from = parseVersion(current);
  const to = parseVersion(latest);
  if (!from || !to || cmpVersion(to, from) <= 0) {
    return { compatible: '', major: '' };
  }
  if (to.major > from.major) return { compatible: '', major: latest };
  return { compatible: latest, major: '' };
};

const planUpdate = (current, extra = {}) => {
  const from = parseVersion(current);
  if (!from) return { action: 'none' };
  let compatible = extra.compatible ?? '';
  let major = extra.major ?? '';
  const skipped = extra.skipped ?? extra.handled ?? '';
  if (!compatible && !major && extra.latest) {
    const classified = classifyLatest(current, extra.latest);
    compatible = classified.compatible;
    major = classified.major;
  }
  const compatVer = parseVersion(compatible);
  if (compatVer && compatVer.major === from.major) {
    if (cmpVersion(compatVer, from) > 0) {
      return { action: 'install', current, latest: compatible };
    }
  }
  const majorVer = parseVersion(major);
  if (!majorVer || majorVer.major <= from.major) return { action: 'none' };
  const skipVer = parseVersion(skipped);
  if (skipVer && cmpVersion(majorVer, skipVer) <= 0) return { action: 'none' };
  return { action: 'confirm', current, latest: major };
};

const isEnabled = (options = {}) => {
  if (options.enabled === false) return false;
  if (options.enabled === true) return true;
  const pkgDir = options.pkgDir ?? PKG_DIR;
  return isNpmInstall(pkgDir);
};

const fetchTargets = async (current, options = {}) => {
  const empty = { compatible: '', major: '' };
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return empty;
  const encoded = encodeURIComponent(PKG_NAME);
  const url = `${REGISTRY}/${encoded}`;
  const headers = { accept: 'application/json' };
  const signal = options.signal ?? AbortSignal.timeout(FETCH_MS);
  const response = await fetchImpl(url, { headers, signal });
  if (!response || !response.ok) return empty;
  const data = await response.json();
  return pickTargets(current, listVersions(data));
};

const npmInstall = async (spec, extra = {}) => {
  const timeout = extra.timeout ?? INSTALL_MS;
  const result = await runProc(
    npmBin(),
    ['install', '-g', spec],
    npmOpts({ timeout }),
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(oneLine(result.stderr, 'npm install failed'));
  }
};

const installUpdate = async (version, options = {}) => {
  if (typeof options.install === 'function') {
    await options.install(version);
    return;
  }
  const spec = `${PKG_NAME}@${version}`;
  await npmInstall(spec, options);
};

const markSkipped = (version, options = {}) => {
  const file = options.cacheFile ?? cacheFile(options.env);
  const cache = readCache(file);
  writeCache(file, { ...cache, skipped: version });
};

const checkUpdate = async (options = {}) => {
  if (!isEnabled(options)) return { action: 'skip' };
  const now = Date.now();
  const current = options.current ?? PKG_VERSION;
  const file = options.cacheFile ?? cacheFile(options.env);
  const interval = options.interval ?? CHECK_INTERVAL_MS;
  const cache = readCache(file);
  if (isFresh(cache, now, interval)) {
    const plan = planUpdate(current, cache);
    if (plan.action === 'install') return { action: 'none' };
    return plan;
  }
  let targets = { compatible: '', major: '' };
  try {
    targets = await fetchTargets(current, options);
  } catch {
    // ignore registry errors
  }
  const next = {
    ...cache,
    checkedAt: now,
    compatible: targets.compatible,
    major: targets.major,
  };
  if (!targets.compatible && !targets.major) {
    writeCache(file, { ...cache, checkedAt: now });
    return { action: 'none' };
  }
  writeCache(file, next);
  return planUpdate(current, next);
};

module.exports = {
  CHECK_INTERVAL_MS,
  PKG_NAME,
  PKG_VERSION,
  parseVersion,
  cmpVersion,
  isNpmInstall,
  cacheFile,
  readCache,
  writeCache,
  isFresh,
  planUpdate,
  checkUpdate,
  installUpdate,
  markSkipped,
};
