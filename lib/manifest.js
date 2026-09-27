'use strict';

const path = require('node:path');
const metautil = require('metautil');
const { isHashObject, jsonParse } = metautil;
const utilities = require('./utilities.js');
const { parseVersion, cmpVersion } = utilities;

const MANIFEST = 'package.json';
const LOCKFILE = 'package-lock.json';
const DEP_KIND = { [MANIFEST]: 'manifest', [LOCKFILE]: 'lockfile' };
const SECTION_KEYS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

const posixRel = (rel) => {
  const raw = `${rel ?? ''}`;
  return raw.replaceAll('\\', '/');
};

const depFileMeta = (rel) => {
  const normalized = posixRel(rel);
  if (!normalized) return null;
  const base = path.posix.basename(normalized);
  const kind = DEP_KIND[base];
  if (!kind) return null;
  const dir = path.posix.dirname(normalized);
  return { kind, dir, base, rel: normalized };
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
  const packages = lock.packages;
  const root = packages && typeof packages === 'object' ? packages[''] : null;
  const src = root && typeof root === 'object' ? root : lock;
  return readSections(src);
};

const lockEntries = (lock) => {
  const versions = new Map();
  if (!lock) return versions;
  const packages = lock.packages;
  if (packages && typeof packages === 'object') {
    for (const key of Object.keys(packages)) {
      const entry = packages[key];
      if (!key.startsWith('node_modules/')) continue;
      if (key.includes('/node_modules/')) continue;
      if (!entry || typeof entry.version !== 'string') continue;
      const name = key.slice('node_modules/'.length);
      versions.set(name, entry.version);
    }
  }
  const deps = lock.dependencies;
  if (!deps || typeof deps !== 'object') return versions;
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
  const packages = lock.packages;
  if (packages && typeof packages === 'object') {
    let count = 0;
    for (const key of Object.keys(packages)) {
      if (key !== '') count += 1;
    }
    return count;
  }
  const deps = lock.dependencies;
  if (!deps || typeof deps !== 'object') return 0;
  return Object.keys(deps).length;
};

const cloneJson = (value) => JSON.parse(JSON.stringify(value ?? null));

const detectIndent = (text) => {
  const match = /\n([ \t]+)"/.exec(text);
  if (!match) return 2;
  return match[1];
};

const stringifyJson = (value, original) => {
  const indent = detectIndent(original || '');
  const body = JSON.stringify(value, null, indent);
  return `${body}\n`;
};

const setSectionEntry = (pkg, section, name, version) => {
  if (!version) {
    const map = pkg[section];
    if (!map || typeof map !== 'object') return;
    delete map[name];
    if (!Object.keys(map).length) delete pkg[section];
    return;
  }
  const map = pkg[section];
  if (!map || typeof map !== 'object') pkg[section] = {};
  pkg[section][name] = version;
};

const dropsEntry = (change, side) => {
  if (side === 'new') return change.action === 'removed';
  return change.action === 'added';
};

const applyManifestChange = (pkg, change, side) => {
  if (change.section === 'resolved') return pkg;
  const value = side === 'new' ? change.to : change.from;
  if (change.section === 'field') {
    if (value === '') {
      delete pkg[change.name];
      return pkg;
    }
    pkg[change.name] = jsonParse(value ?? '') ?? value;
    return pkg;
  }
  const version = dropsEntry(change, side) ? '' : value;
  setSectionEntry(pkg, change.section, change.name, version);
  return pkg;
};

const ensureLockRoot = (lock) => {
  if (!lock.packages || typeof lock.packages !== 'object') {
    lock.packages = {};
  }
  const root = lock.packages[''];
  if (!root || typeof root !== 'object') lock.packages[''] = {};
  return lock.packages[''];
};

const applyLegacyLockDep = (lock, change, side, src) => {
  const deps = lock.dependencies;
  if (!deps || typeof deps !== 'object') return;
  if (dropsEntry(change, side)) {
    delete deps[change.name];
    return;
  }
  const srcDeps = src && src.dependencies;
  if (!srcDeps || typeof srcDeps !== 'object') return;
  const entry = srcDeps[change.name];
  if (entry) deps[change.name] = cloneJson(entry);
};

const applyLockChange = (lock, change, side, oldLock, newLock) => {
  if (change.section === 'field') return lock;
  const src = side === 'new' ? newLock : oldLock;
  if (change.section !== 'resolved') {
    const root = ensureLockRoot(lock);
    applyManifestChange(root, change, side);
    applyLegacyLockDep(lock, change, side, src);
  }
  const packages = lock.packages;
  if (!packages || typeof packages !== 'object') return lock;
  const key = `node_modules/${change.name}`;
  if (dropsEntry(change, side)) {
    delete packages[key];
    return lock;
  }
  const srcPkgs = src && src.packages;
  if (!srcPkgs || typeof srcPkgs !== 'object') return lock;
  const entry = srcPkgs[key];
  if (entry) packages[key] = cloneJson(entry);
  return lock;
};

const seedManifest = (oldObj, newObj) => {
  const base = cloneJson(oldObj) || {};
  if (!newObj) return base;
  for (const key of Object.keys(newObj)) {
    const value = newObj[key];
    if (SECTION_KEYS.includes(key)) continue;
    if (Object.hasOwn(base, key)) continue;
    base[key] = cloneJson(value);
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
  const original = baseText || newText || oldText || '';
  return stringifyJson(base, original);
};

const applyWantedRange = (declared, wanted) => {
  if (!wanted) return declared ?? '';
  if (!declared) return wanted;
  if (/^(file:|git[+@:]|workspace:|https?:|npm:)/.test(declared)) {
    return declared;
  }
  if (declared.includes(' ') || declared.includes('|')) return declared;
  if (declared.includes('<') || declared.includes('>')) return declared;
  const prefix = declared.startsWith('^') || declared.startsWith('~');
  const mark = prefix ? declared[0] : '';
  return `${mark}${wanted}`;
};

const findDeclared = (pkg, name, type) => {
  if (type && SECTION_KEYS.includes(type)) {
    const map = pkg[type];
    if (map && typeof map[name] === 'string') {
      return { section: type, version: map[name] };
    }
  }
  for (const section of SECTION_KEYS) {
    const map = pkg[section];
    if (map && typeof map[name] === 'string') {
      return { section, version: map[name] };
    }
  }
  return null;
};

const fmtVer = (parts) => `${parts.major}.${parts.minor}.${parts.patch}`;

const clauseUpper = (clause) => {
  const pattern = /(<=?)\s*(\d+\.\d+\.\d+)/g;
  const matches = clause.matchAll(pattern);
  let best = null;
  for (const match of matches) {
    const op = match[1];
    const parsed = parseVersion(match[2]);
    if (!parsed) continue;
    if (best && cmpVersion(parsed, best.ver) >= 0) continue;
    best = { op, ver: parsed };
  }
  return best;
};

const patchedFromRange = (current, range) => {
  if (!current || !range) return '';
  const now = parseVersion(current);
  if (!now) return '';
  const clauses = `${range}`.split('||');
  for (const clause of clauses) {
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
  if (!left || !right) return false;
  return left.major === right.major;
};

const proposedLockVersion = (current, vul) => {
  if (!current) return '';
  if (!vul) return current;
  const fix = vul.fix;
  if (fix && sameMajor(current, fix) && fix !== current) return fix;
  const patched = patchedFromRange(current, vul.range);
  if (patched && patched !== current) return patched;
  return current;
};

const proposedWanted = (out, vul) => {
  if (out && out.wanted && out.wanted !== out.current) return out.wanted;
  if (vul && vul.fix) return vul.fix;
  return '';
};

module.exports = {
  MANIFEST,
  LOCKFILE,
  DEP_KIND,
  SECTION_KEYS,
  posixRel,
  depFileMeta,
  relOf,
  listFilePath,
  emptySectionMaps,
  readSections,
  lockRootSections,
  lockEntries,
  lockPackageCount,
  cloneJson,
  stringifyJson,
  mergeDepFile,
  applyWantedRange,
  findDeclared,
  patchedFromRange,
  proposedLockVersion,
  proposedWanted,
};
