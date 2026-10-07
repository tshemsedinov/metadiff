'use strict';

const path = require('node:path');
const { isHashObject, jsonParse } = require('metautil');
const { parseVersion, cmpVersion } = require('./utilities.js');

const MANIFEST = 'package.json';
const LOCKFILE = 'package-lock.json';
const DEP_KIND = { [MANIFEST]: 'manifest', [LOCKFILE]: 'lockfile' };
const SECTION_KEYS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];
const LOCK_PREFIX = 'node_modules/';

const isObject = (value) => !!value && typeof value === 'object';

const posixRel = (rel) => `${rel ?? ''}`.replaceAll('\\', '/');

const depFileMeta = (rel) => {
  const normalized = posixRel(rel);
  const kind = DEP_KIND[path.posix.basename(normalized)];
  if (!normalized || !kind) return null;
  return { kind, dir: path.posix.dirname(normalized) };
};

const relOf = (dir, name) => (dir === '.' ? name : `${dir}/${name}`);

const listFilePath = (rel) => {
  const meta = depFileMeta(rel);
  if (meta && meta.kind === 'lockfile') return relOf(meta.dir, MANIFEST);
  return posixRel(rel);
};

const readSectionMap = (pkg, key) => {
  const map = new Map();
  const raw = pkg ? pkg[key] : null;
  if (!isHashObject(raw)) return map;
  for (const name of Object.keys(raw)) {
    const version = raw[name];
    if (typeof version === 'string') map.set(name, version);
  }
  return map;
};

const readSections = (pkg) =>
  Object.fromEntries(
    SECTION_KEYS.map((key) => [key, readSectionMap(pkg, key)]),
  );

const emptySectionMaps = () => readSections(null);

const lockRootSections = (lock) => {
  if (!lock) return emptySectionMaps();
  const root = isObject(lock.packages) ? lock.packages[''] : null;
  return readSections(isObject(root) ? root : lock);
};

const lockEntries = (lock) => {
  const versions = new Map();
  if (!lock) return versions;
  const packages = isObject(lock.packages) ? lock.packages : {};
  for (const key of Object.keys(packages)) {
    const entry = packages[key];
    if (!key.startsWith(LOCK_PREFIX)) continue;
    if (key.includes('/node_modules/')) continue;
    if (!entry || typeof entry.version !== 'string') continue;
    versions.set(key.slice(LOCK_PREFIX.length), entry.version);
  }
  const deps = isObject(lock.dependencies) ? lock.dependencies : {};
  for (const name of Object.keys(deps)) {
    const entry = deps[name];
    if (versions.has(name)) continue;
    if (!entry || typeof entry.version !== 'string') continue;
    versions.set(name, entry.version);
  }
  return versions;
};

const lockPackageCount = (lock) => {
  if (!lock) return 0;
  if (isObject(lock.packages)) {
    return Object.keys(lock.packages).filter((key) => key !== '').length;
  }
  if (!isObject(lock.dependencies)) return 0;
  return Object.keys(lock.dependencies).length;
};

const cloneJson = (value) => JSON.parse(JSON.stringify(value ?? null));

const stringifyJson = (value, original) => {
  const match = /\n([ \t]+)"/.exec(original);
  const indent = match ? match[1] : 2;
  return `${JSON.stringify(value, null, indent)}\n`;
};

const setSectionEntry = (pkg, section, name, version) => {
  const map = pkg[section];
  if (version) {
    if (!isObject(map)) pkg[section] = {};
    pkg[section][name] = version;
    return;
  }
  if (!isObject(map)) return;
  delete map[name];
  if (!Object.keys(map).length) delete pkg[section];
};

const dropsEntry = (change, side) => {
  if (side === 'new') return change.action === 'removed';
  return change.action === 'added';
};

const applyManifestChange = (pkg, change, side) => {
  if (change.section === 'resolved') return;
  const value = side === 'new' ? change.to : change.from;
  const version = dropsEntry(change, side) ? '' : value;
  setSectionEntry(pkg, change.section, change.name, version);
};

const lockRoot = (lock) => {
  if (!isObject(lock.packages)) lock.packages = {};
  if (!isObject(lock.packages[''])) lock.packages[''] = {};
  return lock.packages[''];
};

const copyLockEntry = (target, source, key, drop) => {
  if (!isObject(target)) return;
  if (drop) return void delete target[key];
  const entry = isObject(source) ? source[key] : null;
  if (entry) target[key] = cloneJson(entry);
};

const applyLockChange = (lock, change, side, oldLock, newLock) => {
  const src = (side === 'new' ? newLock : oldLock) ?? {};
  const drop = dropsEntry(change, side);
  if (change.section !== 'resolved') {
    applyManifestChange(lockRoot(lock), change, side);
    copyLockEntry(lock.dependencies, src.dependencies, change.name, drop);
  }
  const key = `${LOCK_PREFIX}${change.name}`;
  copyLockEntry(lock.packages, src.packages, key, drop);
};

const seedManifest = (oldObj, newObj) => {
  const base = cloneJson(oldObj) || {};
  for (const key of Object.keys(newObj ?? {})) {
    if (SECTION_KEYS.includes(key) || Object.hasOwn(base, key)) continue;
    base[key] = cloneJson(newObj[key]);
  }
  return base;
};

const mergeDepFile = (baseText, oldText, newText, change, side, kind) => {
  const oldObj = jsonParse(oldText ?? '');
  const newObj = jsonParse(newText ?? '');
  const parsedBase = jsonParse(baseText ?? '');
  let base;
  if (parsedBase) base = cloneJson(parsedBase);
  else if (kind === 'manifest') base = seedManifest(oldObj, newObj);
  else base = cloneJson(oldObj) || {};
  if (kind === 'lockfile') applyLockChange(base, change, side, oldObj, newObj);
  else applyManifestChange(base, change, side);
  return stringifyJson(base, baseText || newText || oldText || '');
};

const applyWantedRange = (declared, wanted) => {
  if (!wanted) return declared ?? '';
  if (!declared) return wanted;
  if (/^(file:|git[+@:]|workspace:|https?:|npm:)/.test(declared)) {
    return declared;
  }
  if (/[ |<>]/.test(declared)) return declared;
  const prefix = declared.startsWith('^') || declared.startsWith('~');
  const mark = prefix ? declared[0] : '';
  return `${mark}${wanted}`;
};

const declaredIn = (pkg, section, name) => {
  const map = pkg[section];
  if (!map || typeof map[name] !== 'string') return null;
  return { section, version: map[name] };
};

const findDeclared = (pkg, name, type) => {
  if (type && SECTION_KEYS.includes(type)) {
    const found = declaredIn(pkg, type, name);
    if (found) return found;
  }
  for (const section of SECTION_KEYS) {
    const found = declaredIn(pkg, section, name);
    if (found) return found;
  }
  return null;
};

const fmtVer = (parts) => `${parts.major}.${parts.minor}.${parts.patch}`;

const clauseUpper = (clause) => {
  let best = null;
  for (const match of clause.matchAll(/(<=?)\s*(\d+\.\d+\.\d+)/g)) {
    const parsed = parseVersion(match[2]);
    if (!parsed) continue;
    if (best && cmpVersion(parsed, best.ver) >= 0) continue;
    best = { op: match[1], ver: parsed };
  }
  return best;
};

const patchedFromRange = (current, range) => {
  if (!current || !range) return '';
  const now = parseVersion(current);
  if (!now) return '';
  for (const clause of `${range}`.split('||')) {
    const upper = clauseUpper(clause);
    if (!upper) continue;
    if (now.major !== upper.ver.major) continue;
    if (cmpVersion(now, upper.ver) > 0) continue;
    if (upper.op === '<') return fmtVer(upper.ver);
    return fmtVer({ ...upper.ver, patch: upper.ver.patch + 1 });
  }
  return '';
};

const sameMajor = (from, to) => {
  const left = parseVersion(from);
  const right = parseVersion(to);
  return !!left && !!right && left.major === right.major;
};

const proposedLockVersion = (current, vul) => {
  if (!current) return '';
  if (!vul) return current;
  const fix = vul.fix;
  if (fix && sameMajor(current, fix) && fix !== current) return fix;
  const patched = patchedFromRange(current, vul.range);
  return patched || current;
};

const proposedWanted = (out, vul) => {
  if (out && out.wanted && out.wanted !== out.current) return out.wanted;
  if (vul && vul.fix) return vul.fix;
  return '';
};

module.exports = {
  MANIFEST,
  LOCKFILE,
  SECTION_KEYS,
  isObject,
  depFileMeta,
  relOf,
  listFilePath,
  emptySectionMaps,
  readSections,
  lockRootSections,
  lockEntries,
  lockPackageCount,
  mergeDepFile,
  applyWantedRange,
  findDeclared,
  patchedFromRange,
  proposedLockVersion,
  proposedWanted,
};
