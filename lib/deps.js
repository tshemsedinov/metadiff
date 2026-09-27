'use strict';

const fs = require('node:fs');
const path = require('node:path');
const metautil = require('metautil');
const { jsonParse, isHashObject } = metautil;
const files = require('./files.js');
const { itemPath } = files;
const manifest = require('./manifest.js');
const { MANIFEST, LOCKFILE, SECTION_KEYS, depFileMeta, relOf } = manifest;
const { listFilePath, readSections, lockEntries, lockPackageCount } = manifest;
const { mergeDepFile, findDeclared, applyWantedRange } = manifest;
const { patchedFromRange, proposedLockVersion, proposedWanted } = manifest;
const depDiff = require('./deps-diff.js');
const { diffSections, mergeResolved, summarizeGroup, collectGroups } = depDiff;
const { takeManifestItems, foldedDepNames, stripFoldedDepItem } = depDiff;
const { makeDepItems, stubFileItem } = depDiff;

const SOURCE_EXT = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'];
const REQUIRE_SPEC = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
const FROM_SPEC = /\bfrom\s+['"]([^'"]+)['"]/g;
const IMPORT_FILE = /import\s+['"]([^'"]+)['"]/g;
const IMPORT_CALL = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

const toPackageName = (spec) => {
  if (!spec || spec.startsWith('.') || spec.startsWith('/')) return '';
  if (spec.startsWith('node:')) return '';
  if (spec.startsWith('@')) {
    const parts = spec.split('/');
    if (parts.length < 2) return '';
    return `${parts[0]}/${parts[1]}`;
  }
  return spec.split('/')[0];
};

const addSpec = (used, spec) => {
  const name = toPackageName(spec);
  if (name) used.add(name);
};

const addMatches = (used, text, pattern) => {
  const matches = text.matchAll(pattern);
  for (const match of matches) addSpec(used, match[1]);
};

const collectUsedFromText = (used, text) => {
  addMatches(used, text, REQUIRE_SPEC);
  addMatches(used, text, FROM_SPEC);
  addMatches(used, text, IMPORT_FILE);
  addMatches(used, text, IMPORT_CALL);
};

const collectUsedFromScripts = (used, scripts) => {
  if (!scripts || typeof scripts !== 'object') return;
  for (const script of Object.values(scripts)) {
    const tokens = `${script}`.split(/[\s;&|]+/);
    for (const token of tokens) {
      if (!token || token.startsWith('-')) continue;
      if (token === 'npx' || token === 'npm' || token === 'node') continue;
      addSpec(used, token);
    }
  }
};

const pkgHasExportEntry = (pkg) => {
  if (!pkg || typeof pkg !== 'object') return false;
  const main = pkg.main;
  if (typeof main === 'string' && main) return true;
  const esm = pkg.module;
  if (typeof esm === 'string' && esm) return true;
  const exported = pkg.exports;
  if (typeof exported === 'string' && exported) return true;
  if (!exported || typeof exported !== 'object') return false;
  if (Array.isArray(exported)) return exported.length > 0;
  return Object.keys(exported).length > 0;
};

const isRuntimeFile = (value) => {
  if (typeof value !== 'string' || !value) return false;
  return !value.endsWith('.d.ts');
};

const hasRuntimeExport = (value) => {
  if (isRuntimeFile(value)) return true;
  if (Array.isArray(value)) return value.some(hasRuntimeExport);
  if (!value || typeof value !== 'object') return false;
  const keys = Object.keys(value);
  for (const key of keys) {
    if (key === 'types' || key === 'typings') continue;
    if (hasRuntimeExport(value[key])) return true;
  }
  return false;
};

const pkgHasBin = (pkg) => {
  if (!pkg || typeof pkg !== 'object') return false;
  const bin = pkg.bin;
  if (typeof bin === 'string') return !!bin;
  if (!bin || typeof bin !== 'object' || Array.isArray(bin)) return false;
  return Object.keys(bin).length > 0;
};

const pkgExportsLibrary = (pkg) => {
  if (!pkg || typeof pkg !== 'object') return false;
  if (pkgHasBin(pkg)) return false;
  if (isRuntimeFile(pkg.main)) return true;
  if (isRuntimeFile(pkg.module)) return true;
  return hasRuntimeExport(pkg.exports);
};

const SKIP_WALK = ['node_modules', '.git', '.review', 'coverage', 'dist'];

const collectUsedFromManifest = (used, rel) => {
  let text;
  try {
    text = fs.readFileSync(rel, 'utf8');
  } catch {
    return;
  }
  const pkg = jsonParse(text);
  if (!pkg) return;
  collectUsedFromScripts(used, pkg.scripts);
};

const walkUsedNames = (used, dir) => {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_WALK.includes(entry.name)) continue;
      if (entry.name.startsWith('.')) continue;
      walkUsedNames(used, full);
      continue;
    }
    if (entry.name === MANIFEST) {
      collectUsedFromManifest(used, full);
      continue;
    }
    const ext = path.extname(entry.name);
    if (!SOURCE_EXT.includes(ext)) continue;
    let text;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    collectUsedFromText(used, text);
  }
};

const collectUsedNames = (root) => {
  const used = new Set();
  if (!root) return used;
  walkUsedNames(used, root);
  return used;
};

const depModuleParts = (name) => {
  if (!name.startsWith('@')) return [name];
  const parts = name.split('/');
  if (parts.length < 2) return [];
  return parts.slice(0, 2);
};

const readDepPkg = (root, pkgDir, name) => {
  if (!root || !name) return null;
  const parts = depModuleParts(name);
  if (!parts.length) return null;
  const nested = pkgDir && pkgDir !== '.' ? pkgDir : '';
  let dir = nested ? path.join(root, nested) : root;
  while (true) {
    const file = path.join(dir, 'node_modules', ...parts, MANIFEST);
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      // Missing node_modules copy; try a parent directory.
    }
    if (text) return jsonParse(text);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

const depHasExportEntry = (root, pkgDir, name) => {
  const pkg = readDepPkg(root, pkgDir, name);
  if (!pkg) return false;
  return pkgExportsLibrary(pkg);
};

const collectExportEntries = (root, pkgDir, names) => {
  const entries = new Map();
  if (!root) return entries;
  for (const name of names) {
    const hasExport = depHasExportEntry(root, pkgDir, name);
    entries.set(name, hasExport);
  }
  return entries;
};

const declaredDepNames = (root, pkgDir) => {
  const nested = pkgDir && pkgDir !== '.' ? pkgDir : '';
  const file = path.join(root, nested, MANIFEST);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const maps = readSections(jsonParse(text));
  return SECTION_KEYS.flatMap((key) => [...maps[key].keys()]);
};

const collectExportMeta = (root, extra = {}) => {
  if (extra.exportEntries !== undefined) return extra.exportEntries;
  const pkgDir = extra.dir ?? '.';
  const names = extra.names ?? declaredDepNames(root, pkgDir);
  return collectExportEntries(root, pkgDir, names);
};

const SEVERITY_RANK = { critical: 4, high: 3, moderate: 2, low: 1, info: 0 };

const namedTitle = (name, title) => {
  if (!title) return '';
  if (!name) return title;
  const prefix = `${name}: `;
  if (title.startsWith(prefix)) return title;
  return `${prefix}${title}`;
};

const viaNotes = (via, pkgName) => {
  if (!Array.isArray(via)) return [];
  const notes = [];
  for (const item of via) {
    if (!item || typeof item !== 'object') continue;
    const title = typeof item.title === 'string' ? item.title : '';
    if (!title) continue;
    const hasName = typeof item.name === 'string' && item.name;
    const named = hasName ? item.name : pkgName;
    const note = namedTitle(named, title);
    if (!notes.includes(note)) notes.push(note);
  }
  return notes;
};

const severityRank = (severity) => SEVERITY_RANK[severity] ?? 0;

const auditFix = (entry) => {
  const available = entry.fixAvailable;
  if (!available || typeof available !== 'object') return '';
  if (typeof available.version !== 'string') return '';
  return available.version;
};

const auditEntryNames = (key, entry) => {
  const names = [];
  const primary = entry.name || key;
  if (primary) names.push(primary);
  const effects = entry.effects;
  if (!Array.isArray(effects)) return names;
  for (const effect of effects) {
    if (typeof effect === 'string' && effect) names.push(effect);
  }
  return names;
};

const keepHighestAudit = (audit, name, severity, fix, range, notes) => {
  if (!name || !severity || severity === 'info') return;
  const titles = [];
  for (const note of notes) {
    if (note && !titles.includes(note)) titles.push(note);
  }
  const prev = audit.get(name);
  if (prev && severityRank(prev.severity) >= severityRank(severity)) {
    const merged = [...prev.titles];
    for (const note of titles) {
      if (!merged.includes(note)) merged.push(note);
    }
    const next = {
      ...prev,
      titles: merged,
      fix: prev.fix || fix,
      range: prev.range || range,
    };
    audit.set(name, next);
    return;
  }
  const title = titles[0] || '';
  const next = { name, severity, title, titles, fix, range };
  next.fix ||= '';
  next.range ||= '';
  audit.set(name, next);
};

const parseAuditReport = (text) => {
  const audit = new Map();
  if (!text || !`${text}`.trim()) return audit;
  const data = jsonParse(text);
  if (!isHashObject(data)) return audit;
  const vulns = data.vulnerabilities;
  if (vulns && typeof vulns === 'object') {
    for (const key of Object.keys(vulns)) {
      const entry = vulns[key];
      if (!entry || typeof entry !== 'object') continue;
      const severity = entry.severity;
      const names = auditEntryNames(key, entry);
      const pkgName = entry.name || key;
      const titles = viaNotes(entry.via, pkgName);
      const fix = auditFix(entry);
      const range = typeof entry.range === 'string' ? entry.range : '';
      for (const name of names) {
        keepHighestAudit(audit, name, severity, fix, range, titles);
      }
    }
  }
  const advisories = data.advisories;
  if (advisories && typeof advisories === 'object') {
    for (const entry of Object.values(advisories)) {
      if (!entry || typeof entry !== 'object') continue;
      const name = entry.module_name || entry.name;
      const severity = entry.severity;
      const raw = typeof entry.title === 'string' ? entry.title : '';
      const title = namedTitle(name, raw);
      const titles = title ? [title] : [];
      const fix = auditFix(entry);
      const range = typeof entry.range === 'string' ? entry.range : '';
      keepHighestAudit(audit, name, severity, fix, range, titles);
    }
  }
  return audit;
};

const parseOutdatedReport = (text) => {
  const outdated = new Map();
  if (!text || !`${text}`.trim()) return outdated;
  const data = jsonParse(text);
  if (!isHashObject(data)) return outdated;
  for (const name of Object.keys(data)) {
    const entry = data[name];
    if (!entry || typeof entry !== 'object') continue;
    const current = typeof entry.current === 'string' ? entry.current : '';
    const wanted = typeof entry.wanted === 'string' ? entry.wanted : '';
    const latest = typeof entry.latest === 'string' ? entry.latest : '';
    const type = typeof entry.type === 'string' ? entry.type : '';
    if (!wanted) continue;
    outdated.set(name, { current, wanted, latest, type });
  }
  return outdated;
};

const markChanges = (changes, report, kind) => {
  if (!report) return changes;
  return changes.map((change) => {
    if (change.action === 'removed' || change.section === 'field') {
      return change;
    }
    const found = report.get(change.name);
    if (!found) return change;
    if (kind === 'outdated' && found.wanted && found.wanted === found.current) {
      return change;
    }
    return { ...change, [kind]: found };
  });
};

const depExports = (exportEntries, name) => exportEntries?.get(name) === true;

const isAddedDep = (change) => {
  if (change.action !== 'added') return false;
  if (change.section === 'resolved') return false;
  if (change.section === 'field') return false;
  return true;
};

const unusedChangeNames = (changes, used) => {
  const names = [];
  if (!used || !used.size) return names;
  for (const change of changes) {
    if (!isAddedDep(change)) continue;
    if (used.has(change.name)) continue;
    names.push(change.name);
  }
  return names;
};

const unusedDeclaredNames = (pkg, used) => {
  const names = [];
  if (!pkgHasExportEntry(pkg)) return names;
  if (!used || !used.size) return names;
  const maps = readSections(pkg);
  for (const section of SECTION_KEYS) {
    if (section === 'peerDependencies') continue;
    const keys = [...maps[section].keys()];
    keys.sort();
    for (const name of keys) {
      if (used.has(name)) continue;
      names.push(name);
    }
  }
  return names;
};

const markUnusedChanges = (changes, used, pkg, exportEntries) => {
  if (!pkgHasExportEntry(pkg) || !used?.size) return changes;
  return changes.map((change) => {
    if (!isAddedDep(change) || used.has(change.name)) return change;
    if (!depExports(exportEntries, change.name)) return change;
    return { ...change, unused: true, propose: true };
  });
};

const unusedDeclaredChanges = (pkg, used, exportEntries) => {
  const changes = [];
  if (!pkgHasExportEntry(pkg)) return changes;
  if (!used || !used.size) return changes;
  const maps = readSections(pkg);
  const taken = new Set();
  for (const section of SECTION_KEYS) {
    if (section === 'peerDependencies') continue;
    const map = maps[section];
    const names = [...map.keys()];
    names.sort();
    for (const name of names) {
      if (used.has(name)) continue;
      if (taken.has(name)) continue;
      if (!depExports(exportEntries, name)) continue;
      taken.add(name);
      const version = map.get(name);
      changes.push({
        name,
        section,
        action: 'removed',
        from: version,
        to: '',
        propose: true,
        unused: true,
      });
    }
  }
  return changes;
};

const buildProposedChanges = (pkg, outdated, audit, lock, options = {}) => {
  const used = options.used;
  const exportEntries = options.exportEntries;
  const names = new Set();
  if (outdated) {
    for (const name of outdated.keys()) names.add(name);
  }
  if (audit) {
    for (const name of audit.keys()) names.add(name);
  }
  const listed = [...names];
  listed.sort();
  const resolved = lockEntries(lock);
  const unused = unusedDeclaredChanges(pkg, used, exportEntries);
  const taken = new Set();
  for (const change of unused) taken.add(change.name);
  const changes = [...unused];
  for (const name of listed) {
    if (taken.has(name)) continue;
    const out = outdated ? outdated.get(name) : null;
    const vul = audit ? audit.get(name) : null;
    const type = out ? out.type : '';
    const declared = findDeclared(pkg, name, type);
    if (!declared) {
      if (!vul) continue;
      const version = resolved.get(name) || '';
      if (!version) continue;
      const to = proposedLockVersion(version, vul);
      changes.push({
        name,
        section: 'resolved',
        action: 'vulnerable',
        from: version,
        to,
        propose: true,
        audit: vul,
      });
      continue;
    }
    const wanted = proposedWanted(out, vul);
    if (!wanted && !vul) continue;
    let to = declared.version;
    if (wanted) to = applyWantedRange(declared.version, wanted);
    if (to === declared.version && !vul) continue;
    let action = 'changed';
    if (to === declared.version) action = 'vulnerable';
    const change = {
      name,
      section: declared.section,
      action,
      from: declared.version,
      to,
      propose: true,
    };
    if (out) change.outdated = out;
    if (vul) change.audit = vul;
    changes.push(change);
  }
  return changes;
};

const loadExportEntries = (names, extra = {}, pkgDir) => {
  const supplied = extra.exportEntries;
  if (supplied === null) return new Map();
  const dir = pkgDir ?? extra.dir;
  const missing = [];
  for (const name of names) {
    if (!supplied || !supplied.has(name)) missing.push(name);
  }
  if (!missing.length) return supplied ?? new Map();
  const found = collectExportEntries(extra.root, dir, missing);
  if (!supplied) return found;
  return new Map([...supplied, ...found]);
};

const groupedSynthetics = (synthetic) => {
  const byPath = new Map();
  for (const [key, items] of synthetic) {
    const dir = key.slice(key.indexOf('\0') + 1);
    const rel = relOf(dir, MANIFEST);
    const list = byPath.get(rel) ?? [];
    for (const item of items) list.push(item);
    byPath.set(rel, list);
  }
  return byPath;
};

const spliceAtSlots = (out, synthetic, slot) => {
  const byPath = groupedSynthetics(synthetic);
  const inserts = [...byPath].map(([rel, items]) => ({
    at: slot.get(rel) ?? out.length,
    items,
  }));
  inserts.sort((left, right) => right.at - left.at);
  for (const insert of inserts) {
    out.splice(insert.at, 0, ...insert.items);
  }
  return out;
};

const lastPathIndex = (items, rel) => {
  let at = -1;
  for (let i = 0; i < items.length; i++) {
    if (listFilePath(itemPath(items[i])) === rel) at = i;
  }
  return at;
};

const insertAfterPath = (items, added, rel) => {
  const at = lastPathIndex(items, rel);
  if (at < 0) return [...items, ...added];
  return [...items.slice(0, at + 1), ...added, ...items.slice(at + 1)];
};

const foldDepItems = (
  items,
  readSides = () => ({ oldText: '', newText: '' }),
  usedNames = null,
  audit = null,
  outdated = null,
  extra = {},
) => {
  const groups = collectGroups(items);
  if (!groups.size) return items;
  const folded = new Set();
  const synthetic = new Map();
  const leftoverNames = new Map();
  for (const [key, group] of groups) {
    const summary = summarizeGroup(group, readSides);
    const unusedNames = unusedChangeNames(summary.changes, usedNames);
    const exportEntries = loadExportEntries(unusedNames, extra, group.dir);
    const unused = markUnusedChanges(
      summary.changes,
      usedNames,
      summary.pkg,
      exportEntries,
    );
    const audited = markChanges(unused, audit, 'audit');
    const changes = markChanges(audited, outdated, 'outdated');
    const next = { ...summary, changes };
    leftoverNames.set(key, foldedDepNames(next.changes));
    const taken = takeManifestItems(next);
    if (next.foldLock) {
      for (const item of next.lockItems) taken.push(item);
    }
    if (!taken.length && !next.changes.length) continue;
    const made = makeDepItems(group.origin, group.items, taken, next);
    if (made.length) synthetic.set(key, made);
    for (const item of taken) folded.add(item);
  }
  if (!synthetic.size && !folded.size) return items;
  const out = [];
  const slot = new Map();
  for (const item of items) {
    const rel = itemPath(item);
    const meta = depFileMeta(rel);
    if (meta) {
      const pkgRel = relOf(meta.dir, MANIFEST);
      const key = `${item.origin}\0${meta.dir}`;
      if (synthetic.has(key) && !slot.has(pkgRel)) {
        slot.set(pkgRel, out.length);
      }
    }
    if (folded.has(item)) continue;
    if (meta && meta.kind === 'manifest') {
      const names = leftoverNames.get(`${item.origin}\0${meta.dir}`);
      const kept = names ? stripFoldedDepItem(item, names) : item;
      if (kept) {
        out.push(kept);
        slot.set(relOf(meta.dir, MANIFEST), out.length);
      }
      continue;
    }
    out.push(item);
  }
  return spliceAtSlots(out, synthetic, slot);
};

const proposeDepItems = (pkgText, outdated, audit, extra = {}) => {
  const pkg = jsonParse(pkgText ?? '');
  if (!pkg) return [];
  const lock = jsonParse(extra.lockText ?? '');
  const used = extra.usedNames;
  const names = unusedDeclaredNames(pkg, used);
  const exportEntries = loadExportEntries(names, extra, extra.dir);
  const options = { used, exportEntries };
  const changes = buildProposedChanges(pkg, outdated, audit, lock, options);
  if (!changes.length) return [];
  const stubs = [
    stubFileItem(MANIFEST, 'unstaged'),
    stubFileItem(LOCKFILE, 'unstaged'),
  ];
  const summary = { changes, oldCount: 0, newCount: 0 };
  return makeDepItems('unstaged', stubs, [], summary);
};

const mergeProposedItems = (items, pkgText, outdated, audit, extra = {}) => {
  const proposed = proposeDepItems(pkgText, outdated, audit, extra);
  if (!proposed.length) return items;
  const taken = new Set();
  for (const item of items) {
    const change = item.dep && item.dep.change;
    if (change) taken.add(change.name);
  }
  const added = [];
  for (const item of proposed) {
    const change = item.dep && item.dep.change;
    if (!change || taken.has(change.name)) continue;
    added.push(item);
  }
  if (!added.length) return items;
  const rel = relOf(extra.dir ?? '.', MANIFEST);
  return insertAfterPath(items, added, rel);
};

module.exports = {
  MANIFEST,
  LOCKFILE,
  depFileMeta,
  readSections,
  lockEntries,
  lockPackageCount,
  diffSections,
  mergeDepFile,
  mergeResolved,
  collectUsedNames,
  collectExportMeta,
  parseAuditReport,
  parseOutdatedReport,
  applyWantedRange,
  patchedFromRange,
  proposeDepItems,
  foldDepItems,
  mergeProposedItems,
};
