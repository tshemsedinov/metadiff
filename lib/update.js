'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { jsonParse, isHashObject } = require('metautil');
const utilities = require('./utilities.js');
const { parseVersion, cmpVersion, npmBin } = utilities;
const { npmOpts, runProc, oneLine, asText } = utilities;

const PKG = require('../package.json');

const PKG_NAME = PKG.name;
const PKG_VERSION = PKG.version;
const PKG_DIR = path.resolve(__dirname, '..');
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
const FETCH_MS = 8000;
const INSTALL_MS = 120000;
const REGISTRY = 'https://registry.npmjs.org';

const RELEASE = /^\d+\.\d+\.\d+$/;
const NO_TARGETS = { compatible: '', major: '' };

const isNpmInstall = (pkgDir) =>
  path.basename(path.dirname(pkgDir)) === 'node_modules';

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
    const data = jsonParse(fs.readFileSync(file, 'utf8'));
    if (isHashObject(data)) {
      return {
        checkedAt: parseInt(data.checkedAt, 10) || 0,
        compatible: asText(data.compatible),
        major: asText(data.major) || asText(data.latest),
        skipped: asText(data.skipped) || asText(data.handled),
      };
    }
  } catch {
    // missing or unreadable cache
  }
  return { checkedAt: 0, compatible: '', major: '', skipped: '' };
};

const writeCache = (file, data) => {
  const { checkedAt, compatible, major, skipped } = data;
  const body = JSON.stringify({ checkedAt, compatible, major, skipped });
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${body}\n`);
  } catch {
    // ignore cache write errors
  }
};

const isFresh = (cache, now, interval = CHECK_INTERVAL_MS) => {
  if (!cache.checkedAt || now < cache.checkedAt) return false;
  return now - cache.checkedAt < interval;
};

const listVersions = (data) => {
  if (!data || typeof data !== 'object') return [];
  const names = [];
  if (isHashObject(data.versions)) names.push(...Object.keys(data.versions));
  const tags = data['dist-tags'];
  if (tags && typeof tags.latest === 'string') names.push(tags.latest);
  if (typeof data.version === 'string') names.push(data.version);
  return [...new Set(names)].filter((name) => RELEASE.test(name));
};

const newer = (best, name) => {
  if (!best) return name;
  return cmpVersion(parseVersion(name), parseVersion(best)) > 0 ? name : best;
};

const pickTargets = (current, names) => {
  const from = parseVersion(current);
  if (!from) return NO_TARGETS;
  let compatible = '';
  let major = '';
  for (const name of names) {
    const ver = parseVersion(name);
    if (cmpVersion(ver, from) <= 0) continue;
    if (ver.major === from.major) compatible = newer(compatible, name);
    else if (ver.major > from.major) major = newer(major, name);
  }
  return { compatible, major };
};

const planUpdate = (current, targets) => {
  const from = parseVersion(current);
  if (!from) return { action: 'none' };
  const { compatible, major, skipped } = targets;
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

const isEnabled = (options) => {
  if (typeof options.enabled === 'boolean') return options.enabled;
  return isNpmInstall(options.pkgDir ?? PKG_DIR);
};

const fetchTargets = async (current, options) => {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return NO_TARGETS;
  const url = `${REGISTRY}/${encodeURIComponent(PKG_NAME)}`;
  const headers = { accept: 'application/json' };
  const signal = options.signal ?? AbortSignal.timeout(FETCH_MS);
  const response = await fetchImpl(url, { headers, signal });
  if (!response || !response.ok) return NO_TARGETS;
  const data = await response.json();
  return pickTargets(current, listVersions(data));
};

const installUpdate = async (version, options = {}) => {
  if (typeof options.install === 'function') {
    await options.install(version);
    return;
  }
  const timeout = options.timeout ?? INSTALL_MS;
  const args = ['install', '-g', `${PKG_NAME}@${version}`];
  const result = await runProc(npmBin(), args, npmOpts({ timeout }));
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(oneLine(result.stderr, 'npm install failed'));
  }
};

const markSkipped = (version, options = {}) => {
  const file = options.cacheFile ?? cacheFile(options.env);
  writeCache(file, { ...readCache(file), skipped: version });
};

const checkUpdate = async (options = {}) => {
  if (!isEnabled(options)) return { action: 'skip' };
  const now = Date.now();
  const current = options.current ?? PKG_VERSION;
  const file = options.cacheFile ?? cacheFile(options.env);
  const cache = readCache(file);
  if (isFresh(cache, now, options.interval)) {
    const plan = planUpdate(current, cache);
    return plan.action === 'install' ? { action: 'none' } : plan;
  }
  let targets = NO_TARGETS;
  try {
    targets = await fetchTargets(current, options);
  } catch {
    // ignore registry errors
  }
  if (!targets.compatible && !targets.major) {
    writeCache(file, { ...cache, checkedAt: now });
    return { action: 'none' };
  }
  const next = { ...cache, checkedAt: now, ...targets };
  writeCache(file, next);
  return planUpdate(current, next);
};

module.exports = {
  CHECK_INTERVAL_MS,
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
