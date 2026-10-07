'use strict';

const { jsonParse } = require('metautil');
const { itemPath } = require('./files.js');
const patch = require('./diff/patch.js');
const { countSides, formatHunkHeader, formatPatch } = patch;
const { isCtxType } = require('./diff/diff.js');
const manifest = require('./manifest.js');
const { MANIFEST, LOCKFILE, SECTION_KEYS, depFileMeta, relOf } = manifest;
const { listFilePath, readSections, emptySectionMaps } = manifest;
const { lockRootSections, lockEntries, lockPackageCount } = manifest;

const SECTION_ORDER = [...SECTION_KEYS, 'resolved'];
const ACTION_ORDER = ['added', 'removed', 'changed', 'vulnerable'];
const SECTION_NAMES = SECTION_KEYS.join('|');
const SECTION_OPEN = new RegExp(`^\\s*"(${SECTION_NAMES})"\\s*:\\s*\\{\\s*$`);
const SECTION_END = /^\s*\},?\s*$/;
const DEP_ENTRY = /^\s*"([^"]+)"\s*:\s*"([^"]*)"\s*,?\s*$/;
const DEP_CAPTION = 'Dependencies in package.json & package-lock.json';

const changeAction = (hadOld, hasNew) => {
  if (!hadOld) return 'added';
  if (!hasNew) return 'removed';
  return 'changed';
};

const sortedUnion = (left, right) => [...new Set([...left, ...right])].sort();

const diffMaps = (oldMap, newMap, section) => {
  const changes = [];
  for (const name of sortedUnion(oldMap.keys(), newMap.keys())) {
    const from = oldMap.get(name) ?? '';
    const to = newMap.get(name) ?? '';
    if (from === to) continue;
    const action = changeAction(oldMap.has(name), newMap.has(name));
    changes.push({ name, section, action, from, to });
  }
  return changes;
};

const diffSections = (oldMaps, newMaps) =>
  SECTION_KEYS.flatMap((key) => diffMaps(oldMaps[key], newMaps[key], key));

const hasFieldChanges = (oldPkg, newPkg) => {
  const oldObj = oldPkg ?? {};
  const newObj = newPkg ?? {};
  for (const name of new Set([
    ...Object.keys(oldObj),
    ...Object.keys(newObj),
  ])) {
    if (SECTION_KEYS.includes(name)) continue;
    const prev = JSON.stringify(oldObj[name]);
    if (prev !== JSON.stringify(newObj[name])) return true;
  }
  return false;
};

const foldedDepNames = (changes) =>
  new Set(changes.map((change) => change.name));

const lineEntryName = (text) => {
  const entry = DEP_ENTRY.exec(text);
  return entry ? entry[1] : '';
};

const lineInBlock = (item, line) =>
  typeof item.blockId !== 'number' || line.blockId === item.blockId;

const hunkOnlyFoldedDeps = (item, names) => {
  if (!item.hunk || !names.size) return false;
  let folded = 0;
  for (const line of item.hunk.lines) {
    if (line.type === 'ctx' || !lineInBlock(item, line)) continue;
    if (names.has(lineEntryName(line.text))) {
      folded += 1;
      continue;
    }
    if (SECTION_OPEN.test(line.text) || SECTION_END.test(line.text)) continue;
    return false;
  }
  return folded > 0;
};

const stripFoldedDepItem = (item, names) => {
  if (!item.hunk || !names.size) return item;
  const isFolded = (line) =>
    line.type !== 'ctx' && names.has(lineEntryName(line.text));
  const lines = item.hunk.lines.filter((line) => !isFolded(line));
  if (lines.length === item.hunk.lines.length) return item;
  const isEdit = (line) => line.type !== 'ctx' && lineInBlock(item, line);
  if (!lines.some(isEdit)) return null;
  const { oldStart, newStart } = item.hunk;
  const { oldCount, newCount } = countSides(lines);
  const header = formatHunkHeader(oldStart, oldCount, newStart, newCount);
  const hunk = { ...item.hunk, oldCount, newCount, header, lines };
  const patchAdd = formatPatch(item.file, hunk, item.blockId, 'old');
  const patchRevert = formatPatch(item.file, hunk, item.blockId, 'new');
  return { ...item, hunk, patchAdd, patchRevert };
};

const isDepOnlyItem = (item) => {
  if (!item.hunk) return false;
  let section = '';
  for (const line of item.hunk.lines) {
    const open = SECTION_OPEN.exec(line.text);
    const close = SECTION_END.test(line.text);
    if (line.type !== 'ctx' && lineInBlock(item, line) && !open) {
      if (!section) return false;
      if (!close && !DEP_ENTRY.test(line.text)) return false;
    }
    if (open) section = open[1];
    else if (close) section = '';
  }
  return true;
};

const mapsFromHunks = (items) => {
  const oldMaps = emptySectionMaps();
  const newMaps = emptySectionMaps();
  let section = '';
  for (const item of items) {
    if (!item.hunk) continue;
    for (const line of item.hunk.lines) {
      const open = SECTION_OPEN.exec(line.text);
      if (open) {
        section = open[1];
        continue;
      }
      if (section && SECTION_END.test(line.text)) {
        section = '';
        continue;
      }
      const entry = section ? DEP_ENTRY.exec(line.text) : null;
      if (!entry) continue;
      const name = entry[1];
      const version = entry[2];
      const isCtx = line.type === 'ctx';
      if (isCtx || line.type === 'del') oldMaps[section].set(name, version);
      if (isCtx || line.type === 'add') newMaps[section].set(name, version);
    }
  }
  return { oldMaps, newMaps };
};

const mergeResolved = (changes, oldResolved, newResolved, oldMaps, newMaps) => {
  const merged = changes.map((change) => ({
    ...change,
    resolvedFrom: oldResolved.get(change.name) ?? '',
    resolvedTo: newResolved.get(change.name) ?? '',
  }));
  const seen = new Set(changes.map((change) => change.name));
  const direct = SECTION_KEYS.flatMap((key) => [
    ...oldMaps[key].keys(),
    ...newMaps[key].keys(),
  ]);
  for (const name of [...new Set(direct)].sort()) {
    if (seen.has(name)) continue;
    const from = oldResolved.get(name) ?? '';
    const to = newResolved.get(name) ?? '';
    if (from === to) continue;
    const action = changeAction(from, to);
    const resolvedFrom = from;
    const resolvedTo = to;
    const section = 'resolved';
    merged.push({ name, section, action, from, to, resolvedFrom, resolvedTo });
  }
  return merged;
};

const compareChangeOrder = (left, right) => {
  const section = SECTION_ORDER.indexOf(left.section);
  const other = SECTION_ORDER.indexOf(right.section);
  if (section !== other) return section - other;
  const leftAction = ACTION_ORDER.indexOf(left.action);
  const rightAction = ACTION_ORDER.indexOf(right.action);
  if (leftAction !== rightAction) return leftAction - rightAction;
  return left.name.localeCompare(right.name);
};

const kindOf = (rel) => depFileMeta(rel)?.kind;

const kindItems = (items, kind) =>
  items.filter((item) => kindOf(itemPath(item)) === kind);

const readJsonSides = (readSides, origin, rel) => {
  const sides = readSides(origin, rel);
  const before = jsonParse(sides.oldText ?? '');
  const after = jsonParse(sides.newText ?? '');
  return { before, after };
};

const sectionMapsOf = (pkg, lock, manifestItems) => {
  if (pkg.before || pkg.after) {
    return {
      oldMaps: readSections(pkg.before),
      newMaps: readSections(pkg.after),
    };
  }
  if (manifestItems.length) return mapsFromHunks(manifestItems);
  const oldMaps = lockRootSections(lock.before);
  return { oldMaps, newMaps: lockRootSections(lock.after) };
};

const manifestPolicy = (manifestItems, pkg, hasChanges) => {
  if (!manifestItems.length) {
    return { foldManifest: false, takeAllManifest: false };
  }
  if (pkg.before || pkg.after) {
    const onlyDeps = !hasFieldChanges(pkg.before, pkg.after);
    return {
      foldManifest: hasChanges,
      takeAllManifest: hasChanges && onlyDeps,
    };
  }
  const fold = hasChanges && manifestItems.every(isDepOnlyItem);
  return { foldManifest: fold, takeAllManifest: fold };
};

const summarizeGroup = (group, readSides) => {
  const { origin, dir } = group;
  const manifestItems = kindItems(group.items, 'manifest');
  const lockItems = kindItems(group.items, 'lockfile');
  const pkg = readJsonSides(readSides, origin, relOf(dir, MANIFEST));
  const lock = readJsonSides(readSides, origin, relOf(dir, LOCKFILE));
  const { oldMaps, newMaps } = sectionMapsOf(pkg, lock, manifestItems);
  const changes = mergeResolved(
    diffSections(oldMaps, newMaps),
    lockEntries(lock.before),
    lockEntries(lock.after),
    oldMaps,
    newMaps,
  );
  return {
    changes,
    oldCount: lockPackageCount(lock.before),
    newCount: lockPackageCount(lock.after),
    foldLock: lockItems.length > 0,
    ...manifestPolicy(manifestItems, pkg, changes.length > 0),
    manifestItems,
    lockItems,
    pkg: pkg.after || pkg.before,
  };
};

const collectGroups = (items) => {
  const groups = new Map();
  for (const item of items) {
    const meta = depFileMeta(itemPath(item));
    if (!meta) continue;
    const key = `${item.origin}\0${meta.dir}`;
    if (!groups.has(key)) {
      groups.set(key, { dir: meta.dir, origin: item.origin, items: [] });
    }
    groups.get(key).items.push(item);
  }
  return groups;
};

const takeManifestItems = (summary) => {
  if (!summary.foldManifest) return [];
  if (summary.takeAllManifest) return [...summary.manifestItems];
  const names = foldedDepNames(summary.changes);
  return summary.manifestItems.filter(
    (item) => isDepOnlyItem(item) || hunkOnlyFoldedDeps(item, names),
  );
};

const changeMarks = (change) => {
  const marks = [];
  if (change.unused) marks.push('unused');
  if (change.outdated && !change.propose) marks.push('outdated');
  if (change.audit) marks.push(change.audit.severity);
  return marks;
};

const changeSources = (change) => {
  if (change.unused) return ['npm uninstall'];
  const sources = [];
  if (change.propose && change.outdated) sources.push('npm outdated');
  if (change.audit) sources.push('npm audit');
  return sources;
};

const sectionTitle = (change, marks, sources) => {
  const { section, action } = change;
  const title = action === 'changed' ? 'version changed' : action;
  const kind = section.replace(/ies$/, 'y');
  let label = `${kind} ${title}`;
  if (section === 'resolved' && action === 'vulnerable') {
    label = 'lockfile vulnerable';
  } else if (section === 'resolved') {
    label = `lockfile resolved ${title}`;
  }
  if (marks.includes('unused')) label = `${kind} unused`;
  const extra = marks.filter((mark) => mark !== 'unused');
  if (extra.length) label = `${label}, ${extra.join(', ')}`;
  if (!sources.length) return label;
  return `${sources.join(', ')}: ${label}`;
};

const row = (type, text) => ({ type, text });

const entryRow = (type, change, side) => {
  const version = side === 'old' ? change.from : change.to;
  return row(type, `"${change.name}": "${version}"`);
};

const changeLines = (change) => {
  if (change.unused) {
    const side = change.action === 'added' ? 'new' : 'old';
    return [entryRow('del', change, side)];
  }
  if (change.action === 'added') return [entryRow('add', change, 'new')];
  if (change.action === 'removed') return [entryRow('del', change, 'old')];
  if (change.from === change.to) return [entryRow('ctx', change, 'old')];
  return [entryRow('del', change, 'old'), entryRow('add', change, 'new')];
};

const auditRows = (audit) => {
  if (!audit) return [];
  const titles = Array.isArray(audit.titles) ? audit.titles : [audit.title];
  const notes = [...new Set(titles.filter(Boolean))];
  const prefix = `npm audit  ${audit.severity}`;
  if (!notes.length) return [row('ctx', ''), row('note', prefix)];
  const rows = [row('ctx', '')];
  for (const note of notes) {
    if (rows.length > 1) rows.push(row('noteSep', ''));
    rows.push(row('note', `${prefix}  ${note}`));
  }
  return rows;
};

const changeRows = (change) => {
  const sources = changeSources(change);
  const title = sectionTitle(change, changeMarks(change), sources);
  const audited = sources.includes('npm audit');
  return [
    row('ctx', DEP_CAPTION),
    row('ctx', ''),
    row(audited ? 'warn' : 'ctx', title),
    row('ctx', ''),
    ...changeLines(change),
    ...auditRows(change.audit),
  ];
};

const countRows = (oldCount, newCount) => [
  row('ctx', DEP_CAPTION),
  row('ctx', ''),
  row('ctx', `lockfile packages  ${oldCount} → ${newCount}`),
];

const makeHunk = (rows, blockId) => {
  const lines = rows.map((entry) => ({
    type: entry.type,
    text: entry.text,
    noNl: false,
    blockId: isCtxType(entry.type) ? null : blockId,
  }));
  const { oldCount, newCount } = countSides(lines);
  const header = `@@ -1,${oldCount} +1,${newCount} @@`;
  return { oldStart: 1, oldCount, newStart: 1, newCount, header, lines };
};

const filesForChange = (change, rels) => {
  const manifests = rels.filter((rel) => kindOf(rel) === 'manifest');
  const lockfiles = rels.filter((rel) => kindOf(rel) === 'lockfile');
  if (change.section === 'resolved') {
    return lockfiles.length ? lockfiles : rels;
  }
  if (change.propose) return manifests.length ? manifests : rels;
  const both = [...manifests, ...lockfiles];
  return both.length ? both : rels;
};

const makeDepItem = (origin, fileItems, hidden, change, rows, blockId) => {
  const paths = new Set(fileItems.map((item) => itemPath(item)));
  const rels = [...paths].filter(Boolean);
  const files = change ? filesForChange(change, rels) : rels;
  const primary =
    fileItems.find((item) => kindOf(itemPath(item)) === 'manifest') ??
    fileItems[0];
  const rel = listFilePath(itemPath(primary));
  const hunk = makeHunk(rows, blockId);
  return {
    origin,
    file: {
      oldPath: rel,
      newPath: rel,
      isNew: fileItems.some((item) => item.file?.isNew),
      isDeleted: fileItems.every((item) => item.file?.isDeleted),
      isBinary: false,
      preamble: [],
      hunks: [hunk],
    },
    hunk,
    blockId,
    patchAdd: '',
    patchRevert: '',
    dep: { files, items: hidden, change },
    reload: !!change?.propose,
  };
};

const makeDepItems = (origin, fileItems, hidden, summary) => {
  const ordered = [...summary.changes].sort(compareChangeOrder);
  if (ordered.length) {
    return ordered.map((change, index) =>
      makeDepItem(origin, fileItems, hidden, change, changeRows(change), index),
    );
  }
  const oldCount = summary.oldCount ?? 0;
  const newCount = summary.newCount ?? 0;
  if (oldCount === newCount) return [];
  const rows = countRows(oldCount, newCount);
  return [makeDepItem(origin, fileItems, hidden, null, rows, 0)];
};

const stubFileItem = (rel, origin) => ({
  origin,
  file: {
    oldPath: rel,
    newPath: rel,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    preamble: [],
    hunks: [],
  },
  hunk: null,
  blockId: 0,
  patchAdd: '',
  patchRevert: '',
});

module.exports = {
  DEP_CAPTION,
  diffSections,
  mergeResolved,
  summarizeGroup,
  collectGroups,
  takeManifestItems,
  foldedDepNames,
  stripFoldedDepItem,
  makeDepItems,
  stubFileItem,
};
