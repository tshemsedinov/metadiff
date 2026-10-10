'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { jsonParse, isHashObject } = require('metautil');
const { itemPath, REVIEW_DIR } = require('../common/files.js');
const { asText, readText } = require('../common/utilities.js');
const manifest = require('./manifest.js');
const { MANIFEST, LOCKFILE, SECTION_KEYS, isObject } = manifest;
const { depFileMeta, relOf, listFilePath, readSections } = manifest;
const { lockEntries, findDeclared, applyWantedRange } = manifest;
const { proposedLockVersion, proposedWanted } = manifest;
const depDiff = require('./diff.js');
const { summarizeGroup, collectGroups, takeManifestItems } = depDiff;
const { foldedDepNames, stripFoldedDepItem } = depDiff;
const { makeDepItems, stubFileItem } = depDiff;

const SOURCE_EXT = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'];
const SPEC_PATTERNS = [
  /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bfrom\s+['"]([^'"]+)['"]/g,
  /import\s+['"]([^'"]+)['"]/g,
  /import\(\s*['"]([^'"]+)['"]\s*\)/g,
];
const SCRIPT_RUNNERS = ['npx', 'npm', 'node'];
const SKIP_WALK = ['node_modules', '.git', REVIEW_DIR, 'coverage', 'dist'];
const SEVERITY_RANK = { critical: 4, high: 3, moderate: 2, low: 1, info: 0 };

const toPackageName = (spec) => {
  if (!spec || spec.startsWith('.') || spec.startsWith('/')) return '';
  if (spec.startsWith('node:')) return '';
  const parts = spec.split('/');
  if (!spec.startsWith('@')) return parts[0];
  return parts.length < 2 ? '' : `${parts[0]}/${parts[1]}`;
};

const addSpec = (used, spec) => {
  const name = toPackageName(spec);
  if (name) used.add(name);
};

const collectUsedFromText = (used, text) => {
  for (const pattern of SPEC_PATTERNS) {
    for (const match of text.matchAll(pattern)) addSpec(used, match[1]);
  }
};

const collectUsedFromScripts = (used, scripts) => {
  if (!isObject(scripts)) return;
  for (const script of Object.values(scripts)) {
    for (const token of `${script}`.split(/[\s;&|]+/)) {
      if (!token || token.startsWith('-')) continue;
      if (!SCRIPT_RUNNERS.includes(token)) addSpec(used, token);
    }
  }
};

const hasText = (value) => typeof value === 'string' && value !== '';

const pkgHasExportEntry = (pkg) => {
  if (!isObject(pkg)) return false;
  if (hasText(pkg.main) || hasText(pkg.module)) return true;
  const exported = pkg.exports;
  if (hasText(exported)) return true;
  return isObject(exported) && Object.keys(exported).length > 0;
};

const isRuntimeFile = (value) => hasText(value) && !value.endsWith('.d.ts');

const hasRuntimeExport = (value) => {
  if (isRuntimeFile(value)) return true;
  if (Array.isArray(value)) return value.some(hasRuntimeExport);
  if (!isObject(value)) return false;
  for (const key of Object.keys(value)) {
    if (key === 'types' || key === 'typings') continue;
    if (hasRuntimeExport(value[key])) return true;
  }
  return false;
};

const pkgHasBin = (pkg) => {
  const bin = pkg.bin;
  if (typeof bin === 'string') return !!bin;
  return isHashObject(bin) && Object.keys(bin).length > 0;
};

const pkgExportsLibrary = (pkg) => {
  if (!isObject(pkg) || pkgHasBin(pkg)) return false;
  if (isRuntimeFile(pkg.main) || isRuntimeFile(pkg.module)) return true;
  return hasRuntimeExport(pkg.exports);
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
      const skip = SKIP_WALK.includes(entry.name) || entry.name.startsWith('.');
      if (!skip) walkUsedNames(used, full);
    } else if (entry.name === MANIFEST) {
      collectUsedFromScripts(used, jsonParse(readText(full))?.scripts);
    } else if (SOURCE_EXT.includes(path.extname(entry.name))) {
      collectUsedFromText(used, readText(full));
    }
  }
};

const collectUsedNames = (root) => {
  const used = new Set();
  if (root) walkUsedNames(used, root);
  return used;
};

const depModuleParts = (name) => {
  if (!name.startsWith('@')) return [name];
  const parts = name.split('/');
  return parts.length < 2 ? [] : parts.slice(0, 2);
};

const readDepPkg = (root, pkgDir, name) => {
  if (!name) return null;
  const parts = depModuleParts(name);
  if (!parts.length) return null;
  let dir = path.join(root, pkgDir || '.');
  while (true) {
    const file = path.join(dir, 'node_modules', ...parts, MANIFEST);
    const text = readText(file);
    if (text) return jsonParse(text);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

const collectExportEntries = (root, pkgDir, names) => {
  const entries = new Map();
  if (!root) return entries;
  for (const name of names) {
    const pkg = readDepPkg(root, pkgDir, name);
    entries.set(name, !!pkg && pkgExportsLibrary(pkg));
  }
  return entries;
};

const collectExportMeta = (root) => {
  const pkg = jsonParse(readText(path.join(root, MANIFEST)));
  const maps = readSections(pkg);
  const names = SECTION_KEYS.flatMap((key) => [...maps[key].keys()]);
  return collectExportEntries(root, '.', names);
};

const namedTitle = (name, title) => {
  if (!title) return '';
  if (!name) return title;
  const prefix = `${name}: `;
  return title.startsWith(prefix) ? title : `${prefix}${title}`;
};

const viaNotes = (via, pkgName) => {
  if (!Array.isArray(via)) return [];
  const notes = [];
  for (const item of via) {
    const title = asText(item?.title);
    if (!isObject(item) || !title) continue;
    const named = hasText(item.name) ? item.name : pkgName;
    const note = namedTitle(named, title);
    if (!notes.includes(note)) notes.push(note);
  }
  return notes;
};

const severityRank = (severity) => SEVERITY_RANK[severity] ?? 0;

const auditFix = (entry) => asText(entry.fixAvailable?.version);

const auditEntryNames = (key, entry) => {
  const effects = Array.isArray(entry.effects) ? entry.effects : [];
  const names = effects.filter(hasText);
  const primary = entry.name || key;
  return primary ? [primary, ...names] : names;
};

const uniqueTexts = (list) => [...new Set(list.filter(Boolean))];

const keepHighestAudit = (audit, found) => {
  const { name, severity } = found;
  if (!name || !severity || severity === 'info') return;
  const titles = uniqueTexts(found.titles);
  const prev = audit.get(name);
  if (prev && severityRank(prev.severity) >= severityRank(severity)) {
    audit.set(name, {
      ...prev,
      titles: uniqueTexts([...prev.titles, ...titles]),
      fix: prev.fix || found.fix,
      range: prev.range || found.range,
    });
    return;
  }
  const title = titles[0] || '';
  const fix = found.fix || '';
  const range = found.range || '';
  audit.set(name, { name, severity, title, titles, fix, range });
};

const vulnFindings = (vulns) => {
  const found = [];
  for (const key of Object.keys(vulns)) {
    const entry = vulns[key];
    if (!isObject(entry)) continue;
    const { severity } = entry;
    const titles = viaNotes(entry.via, entry.name || key);
    const fix = auditFix(entry);
    const range = asText(entry.range);
    for (const name of auditEntryNames(key, entry)) {
      found.push({ name, severity, fix, range, titles });
    }
  }
  return found;
};

const advisoryFinding = (entry) => {
  const name = entry.module_name || entry.name;
  const title = namedTitle(name, asText(entry.title));
  const titles = title ? [title] : [];
  const fix = auditFix(entry);
  const range = asText(entry.range);
  return { name, severity: entry.severity, fix, range, titles };
};

const parseAuditReport = (text) => {
  const audit = new Map();
  const data = text ? jsonParse(text) : null;
  if (!isHashObject(data)) return audit;
  const { vulnerabilities, advisories } = data;
  const found = isObject(vulnerabilities) ? vulnFindings(vulnerabilities) : [];
  if (isObject(advisories)) {
    const listed = Object.values(advisories).filter(isObject);
    found.push(...listed.map(advisoryFinding));
  }
  for (const entry of found) keepHighestAudit(audit, entry);
  return audit;
};

const parseOutdatedReport = (text) => {
  const outdated = new Map();
  const data = text ? jsonParse(text) : null;
  if (!isHashObject(data)) return outdated;
  for (const name of Object.keys(data)) {
    const entry = data[name];
    const wanted = asText(entry?.wanted);
    if (!isObject(entry) || !wanted) continue;
    const current = asText(entry.current);
    const latest = asText(entry.latest);
    const type = asText(entry.type);
    outdated.set(name, { current, wanted, latest, type });
  }
  return outdated;
};

const markChanges = (changes, report, kind) => {
  if (!report) return changes;
  return changes.map((change) => {
    if (change.action === 'removed') return change;
    const found = report.get(change.name);
    if (!found) return change;
    const isCurrent = found.wanted && found.wanted === found.current;
    if (kind === 'outdated' && isCurrent) return change;
    return { ...change, [kind]: found };
  });
};

const depExports = (exportEntries, name) => exportEntries?.get(name) === true;

const isAddedDep = (change) =>
  change.action === 'added' && change.section !== 'resolved';

const unusedChangeNames = (changes, used) => {
  if (!used || !used.size) return [];
  const unused = changes.filter(
    (change) => isAddedDep(change) && !used.has(change.name),
  );
  return unused.map((change) => change.name);
};

const unusedDeclared = (pkg, used) => {
  const found = [];
  if (!pkgHasExportEntry(pkg) || !used?.size) return found;
  const maps = readSections(pkg);
  for (const section of SECTION_KEYS) {
    if (section === 'peerDependencies') continue;
    const map = maps[section];
    for (const name of [...map.keys()].sort()) {
      if (!used.has(name)) found.push({ name, section, from: map.get(name) });
    }
  }
  return found;
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
  const taken = new Set();
  for (const { name, section, from } of unusedDeclared(pkg, used)) {
    if (taken.has(name) || !depExports(exportEntries, name)) continue;
    taken.add(name);
    const action = 'removed';
    const to = '';
    changes.push({
      name,
      section,
      action,
      from,
      to,
      propose: true,
      unused: true,
    });
  }
  return changes;
};

const resolvedChange = (name, vul, resolved) => {
  const from = resolved.get(name) || '';
  if (!vul || !from) return null;
  const to = proposedLockVersion(from, vul);
  const section = 'resolved';
  const action = 'vulnerable';
  return { name, section, action, from, to, propose: true, audit: vul };
};

const declaredChange = (name, declared, out, vul) => {
  const wanted = proposedWanted(out, vul);
  if (!wanted && !vul) return null;
  const from = declared.version;
  const to = wanted ? applyWantedRange(from, wanted) : from;
  if (to === from && !vul) return null;
  const action = to === from ? 'vulnerable' : 'changed';
  const { section } = declared;
  const change = { name, section, action, from, to, propose: true };
  if (out) change.outdated = out;
  if (vul) change.audit = vul;
  return change;
};

const mapKeys = (map) => (map ? [...map.keys()] : []);

const buildProposedChanges = (pkg, outdated, audit, lock, options) => {
  const listed = [...new Set([...mapKeys(outdated), ...mapKeys(audit)])];
  listed.sort();
  const resolved = lockEntries(lock);
  const { used, exportEntries } = options;
  const changes = unusedDeclaredChanges(pkg, used, exportEntries);
  const taken = new Set(changes.map((change) => change.name));
  for (const name of listed) {
    if (taken.has(name)) continue;
    const out = outdated ? outdated.get(name) : null;
    const vul = audit ? audit.get(name) : null;
    const declared = findDeclared(pkg, name, out ? out.type : '');
    const change = declared
      ? declaredChange(name, declared, out, vul)
      : resolvedChange(name, vul, resolved);
    if (change) changes.push(change);
  }
  return changes;
};

const loadExportEntries = (names, extra, dir) => {
  const supplied = extra.exportEntries;
  if (supplied === null) return new Map();
  const missing = names.filter((name) => !supplied || !supplied.has(name));
  if (!missing.length) return supplied ?? new Map();
  const found = collectExportEntries(extra.root, dir, missing);
  return supplied ? new Map([...supplied, ...found]) : found;
};

const spliceAtSlots = (out, synthetic, slot) => {
  const byPath = new Map();
  for (const key of synthetic.keys()) {
    const rel = relOf(key.slice(key.indexOf('\0') + 1), MANIFEST);
    const list = byPath.get(rel) ?? [];
    list.push(...synthetic.get(key));
    byPath.set(rel, list);
  }
  const inserts = [...byPath.keys()].map((rel) => ({
    at: slot.get(rel) ?? out.length,
    items: byPath.get(rel),
  }));
  inserts.sort((left, right) => right.at - left.at);
  for (const insert of inserts) out.splice(insert.at, 0, ...insert.items);
  return out;
};

const placeFolded = (items, { folded, synthetic, leftoverNames }) => {
  const out = [];
  const slot = new Map();
  for (const item of items) {
    const meta = depFileMeta(itemPath(item));
    const pkgRel = meta ? relOf(meta.dir, MANIFEST) : '';
    const key = meta ? `${item.origin}\0${meta.dir}` : '';
    if (meta && synthetic.has(key) && !slot.has(pkgRel)) {
      slot.set(pkgRel, out.length);
    }
    if (folded.has(item)) continue;
    if (!meta || meta.kind !== 'manifest') {
      out.push(item);
      continue;
    }
    const names = leftoverNames.get(key);
    const kept = names ? stripFoldedDepItem(item, names) : item;
    if (!kept) continue;
    out.push(kept);
    slot.set(pkgRel, out.length);
  }
  return spliceAtSlots(out, synthetic, slot);
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
    const { pkg } = summary;
    let changes = summary.changes;
    changes = markUnusedChanges(changes, usedNames, pkg, exportEntries);
    changes = markChanges(changes, audit, 'audit');
    changes = markChanges(changes, outdated, 'outdated');
    const next = { ...summary, changes };
    leftoverNames.set(key, foldedDepNames(changes));
    const taken = takeManifestItems(next);
    if (next.foldLock) taken.push(...next.lockItems);
    if (!taken.length && !changes.length) continue;
    const made = makeDepItems(group.origin, group.items, taken, next);
    if (made.length) synthetic.set(key, made);
    for (const item of taken) folded.add(item);
  }
  if (!synthetic.size && !folded.size) return items;
  return placeFolded(items, { folded, synthetic, leftoverNames });
};

const proposeDepItems = (pkgText, outdated, audit, extra = {}) => {
  const pkg = jsonParse(pkgText ?? '');
  if (!pkg) return [];
  const lock = jsonParse(extra.lockText ?? '');
  const used = extra.usedNames;
  const names = unusedDeclared(pkg, used).map((dep) => dep.name);
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
  const taken = new Set();
  for (const item of items) {
    const change = item.dep?.change;
    if (change) taken.add(change.name);
  }
  const added = proposed.filter((item) => {
    const change = item.dep?.change;
    return change && !taken.has(change.name);
  });
  if (!added.length) return items;
  const rel = relOf(extra.dir ?? '.', MANIFEST);
  const at = items.findLastIndex(
    (item) => listFilePath(itemPath(item)) === rel,
  );
  if (at < 0) return [...items, ...added];
  return [...items.slice(0, at + 1), ...added, ...items.slice(at + 1)];
};

module.exports = {
  MANIFEST,
  LOCKFILE,
  depFileMeta,
  collectUsedNames,
  collectExportMeta,
  parseAuditReport,
  parseOutdatedReport,
  proposeDepItems,
  foldDepItems,
  mergeProposedItems,
};
