'use strict';

const metautil = require('metautil');
const { jsonParse } = metautil;
const files = require('./files.js');
const { itemPath } = files;
const patch = require('./diff/patch.js');
const { countSides, formatHunkHeader, formatPatch } = patch;
const diff = require('./diff/diff.js');
const { isCtxType } = diff;
const manifest = require('./manifest.js');
const { MANIFEST, LOCKFILE, SECTION_KEYS, depFileMeta, relOf } = manifest;
const { listFilePath, readSections, emptySectionMaps } = manifest;
const { lockRootSections, lockEntries, lockPackageCount } = manifest;

const SECTION_ORDER = [...SECTION_KEYS, 'resolved', 'field'];
const ACTION_ORDER = ['added', 'removed', 'changed', 'vulnerable'];
const SECTION_NAMES = SECTION_KEYS.join('|');
const SECTION_OPEN = new RegExp(`^\\s*"(${SECTION_NAMES})"\\s*:\\s*\\{\\s*$`);
const SECTION_END = /^\s*\},?\s*$/;
const DEP_ENTRY = /^\s*"([^"]+)"\s*:\s*"([^"]*)"\s*,?\s*$/;

const diffMaps = (oldMap, newMap, section) => {
  const keys = [...oldMap.keys(), ...newMap.keys()];
  const names = [...new Set(keys)];
  names.sort();
  const changes = [];
  for (const name of names) {
    const from = oldMap.has(name) ? oldMap.get(name) : '';
    const to = newMap.has(name) ? newMap.get(name) : '';
    if (from === to) continue;
    let action = 'changed';
    if (!oldMap.has(name)) action = 'added';
    else if (!newMap.has(name)) action = 'removed';
    changes.push({ name, section, action, from, to });
  }
  return changes;
};

const diffSections = (oldMaps, newMaps) =>
  SECTION_KEYS.flatMap((key) => diffMaps(oldMaps[key], newMaps[key], key));

const fieldText = (value) => {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
};

const diffOtherFields = (oldPkg, newPkg) => {
  if (!oldPkg && !newPkg) return [];
  const oldObj = oldPkg ?? {};
  const newObj = newPkg ?? {};
  const keys = [...Object.keys(oldObj), ...Object.keys(newObj)];
  const names = [...new Set(keys)];
  names.sort();
  const changes = [];
  for (const name of names) {
    if (SECTION_KEYS.includes(name)) continue;
    const prev = oldObj[name];
    const next = newObj[name];
    if (JSON.stringify(prev) === JSON.stringify(next)) continue;
    let action = 'changed';
    if (!Object.hasOwn(oldObj, name)) action = 'added';
    else if (!Object.hasOwn(newObj, name)) action = 'removed';
    const from = fieldText(prev);
    const to = fieldText(next);
    const section = 'field';
    changes.push({ name, section, action, from, to });
  }
  return changes;
};

const foldedDepNames = (changes) => {
  const names = new Set();
  for (const change of changes) {
    if (change.section === 'field') continue;
    names.add(change.name);
  }
  return names;
};

const lineEntryName = (text) => {
  const entry = DEP_ENTRY.exec(text);
  return entry ? entry[1] : '';
};

const lineInBlock = (item, line) => {
  const blockId = item.blockId;
  if (typeof blockId !== 'number') return true;
  return line.blockId === blockId;
};

const hunkOnlyFoldedDeps = (item, names) => {
  if (!item.hunk || !names.size) return false;
  let folded = 0;
  for (const line of item.hunk.lines) {
    if (line.type === 'ctx') continue;
    if (!lineInBlock(item, line)) continue;
    const name = lineEntryName(line.text);
    if (name && names.has(name)) {
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
  const lines = [];
  let removed = false;
  for (const line of item.hunk.lines) {
    if (line.type !== 'ctx') {
      const name = lineEntryName(line.text);
      if (name && names.has(name)) {
        removed = true;
        continue;
      }
    }
    lines.push(line);
  }
  if (!removed) return item;
  let hasEdit = false;
  for (const line of lines) {
    if (line.type === 'ctx') continue;
    if (!lineInBlock(item, line)) continue;
    hasEdit = true;
    break;
  }
  if (!hasEdit) return null;
  const counts = countSides(lines);
  const hunk = {
    ...item.hunk,
    oldCount: counts.oldCount,
    newCount: counts.newCount,
    header: formatHunkHeader(
      item.hunk.oldStart,
      counts.oldCount,
      item.hunk.newStart,
      counts.newCount,
    ),
    lines,
  };
  const patchAdd = formatPatch(item.file, hunk, item.blockId, 'old');
  const patchRevert = formatPatch(item.file, hunk, item.blockId, 'new');
  return { ...item, hunk, patchAdd, patchRevert };
};

const onlyDepEdits = (items) => {
  if (!items.length) return false;
  for (const item of items) {
    if (!item.hunk) return false;
    const blockId = item.blockId;
    const scoped = typeof blockId === 'number';
    let section = '';
    for (const line of item.hunk.lines) {
      const open = SECTION_OPEN.exec(line.text);
      let nextSection = section;
      if (open) nextSection = open[1];
      else if (section && SECTION_END.test(line.text)) nextSection = '';
      const inBlock = !scoped || line.blockId === blockId;
      if (inBlock && line.type !== 'ctx') {
        const inDep = !!(open || section);
        if (!inDep) return false;
        const isEntry = DEP_ENTRY.test(line.text);
        const isClose = SECTION_END.test(line.text);
        if (!open && !isEntry && !isClose) return false;
      }
      section = nextSection;
    }
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
      if (!section) continue;
      const entry = DEP_ENTRY.exec(line.text);
      if (!entry) continue;
      const name = entry[1];
      const version = entry[2];
      if (line.type === 'del' || line.type === 'ctx') {
        oldMaps[section].set(name, version);
      }
      if (line.type === 'add' || line.type === 'ctx') {
        newMaps[section].set(name, version);
      }
    }
  }
  return { oldMaps, newMaps };
};

const directNames = (oldMaps, newMaps) => {
  const names = new Set();
  for (const key of SECTION_KEYS) {
    for (const name of oldMaps[key].keys()) names.add(name);
    for (const name of newMaps[key].keys()) names.add(name);
  }
  return names;
};

const mergeResolved = (changes, oldResolved, newResolved, oldMaps, newMaps) => {
  const seen = new Set();
  const { length } = changes;
  const merged = new Array(length);
  for (let i = 0; i < length; i++) {
    const change = changes[i];
    seen.add(change.name);
    const resolvedFrom = oldResolved.get(change.name) ?? '';
    const resolvedTo = newResolved.get(change.name) ?? '';
    merged[i] = { ...change, resolvedFrom, resolvedTo };
  }
  const names = [...directNames(oldMaps, newMaps)];
  names.sort();
  for (const name of names) {
    if (seen.has(name)) continue;
    const from = oldResolved.get(name) ?? '';
    const to = newResolved.get(name) ?? '';
    if (from === to) continue;
    if (!from && !to) continue;
    let action = 'changed';
    if (!from) action = 'added';
    else if (!to) action = 'removed';
    const section = 'resolved';
    const resolvedFrom = from;
    const resolvedTo = to;
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

const orderedChanges = (changes) => [...changes].sort(compareChangeOrder);

const kindItems = (items, kind) =>
  items.filter((item) => depFileMeta(itemPath(item))?.kind === kind);

const readGroupSnapshot = (group, readSides) => {
  const origin = group.origin;
  const dir = group.dir;
  const groupItems = group.items;
  const manifestItems = kindItems(groupItems, 'manifest');
  const lockItems = kindItems(groupItems, 'lockfile');
  const manifestRel = relOf(dir, MANIFEST);
  const lockRel = relOf(dir, LOCKFILE);
  const manifestSides = readSides(origin, manifestRel);
  const lockSides = readSides(origin, lockRel);
  const oldPkg = jsonParse(manifestSides.oldText ?? '');
  const newPkg = jsonParse(manifestSides.newText ?? '');
  const oldLock = jsonParse(lockSides.oldText ?? '');
  const newLock = jsonParse(lockSides.newText ?? '');
  const parsedManifest = !!(oldPkg || newPkg);
  return {
    origin,
    dir,
    groupItems,
    manifestItems,
    lockItems,
    oldPkg,
    newPkg,
    oldLock,
    newLock,
    parsedManifest,
  };
};

const sectionMapsOf = (snapshot) => {
  if (snapshot.parsedManifest) {
    const oldMaps = readSections(snapshot.oldPkg);
    const newMaps = readSections(snapshot.newPkg);
    return { oldMaps, newMaps };
  }
  if (snapshot.manifestItems.length) {
    return mapsFromHunks(snapshot.manifestItems);
  }
  const oldMaps = lockRootSections(snapshot.oldLock);
  const newMaps = lockRootSections(snapshot.newLock);
  return { oldMaps, newMaps };
};

const comparedChanges = (snapshot) => {
  const maps = sectionMapsOf(snapshot);
  const oldMaps = maps.oldMaps;
  const newMaps = maps.newMaps;
  const manifestChanges = diffSections(oldMaps, newMaps);
  const parsed = snapshot.parsedManifest;
  let otherChanges = [];
  if (parsed) {
    otherChanges = diffOtherFields(snapshot.oldPkg, snapshot.newPkg);
  }
  const oldResolved = lockEntries(snapshot.oldLock);
  const newResolved = lockEntries(snapshot.newLock);
  const changes = mergeResolved(
    manifestChanges,
    oldResolved,
    newResolved,
    oldMaps,
    newMaps,
  );
  const oldCount = lockPackageCount(snapshot.oldLock);
  const newCount = lockPackageCount(snapshot.newLock);
  return { changes, otherChanges, oldCount, newCount };
};

const foldingPolicy = (snapshot, compared) => {
  const foldLock = snapshot.lockItems.length > 0;
  const hasDepChanges = compared.changes.length > 0;
  if (!snapshot.manifestItems.length) {
    const foldManifest = false;
    const takeAllManifest = false;
    return { foldLock, foldManifest, takeAllManifest };
  }
  if (snapshot.parsedManifest) {
    const foldManifest = hasDepChanges;
    const takeAllManifest = hasDepChanges && compared.otherChanges.length === 0;
    return { foldLock, foldManifest, takeAllManifest };
  }
  const foldManifest = hasDepChanges && onlyDepEdits(snapshot.manifestItems);
  const takeAllManifest = foldManifest;
  return { foldLock, foldManifest, takeAllManifest };
};

const summarizeGroup = (group, readSides) => {
  const snapshot = readGroupSnapshot(group, readSides);
  const compared = comparedChanges(snapshot);
  const policy = foldingPolicy(snapshot, compared);
  return {
    changes: compared.changes,
    oldCount: compared.oldCount,
    newCount: compared.newCount,
    foldLock: policy.foldLock,
    foldManifest: policy.foldManifest,
    takeAllManifest: policy.takeAllManifest,
    manifestItems: snapshot.manifestItems,
    lockItems: snapshot.lockItems,
    pkg: snapshot.newPkg || snapshot.oldPkg,
  };
};

const collectGroups = (items) => {
  const groups = new Map();
  for (const item of items) {
    const rel = itemPath(item);
    const meta = depFileMeta(rel);
    if (!meta) continue;
    const key = `${item.origin}\0${meta.dir}`;
    let group = groups.get(key);
    if (!group) {
      const dir = meta.dir;
      const origin = item.origin;
      group = { dir, origin, items: [] };
      groups.set(key, group);
    }
    group.items.push(item);
  }
  return groups;
};

const takeManifestItems = (summary) => {
  if (!summary.foldManifest) return [];
  if (summary.takeAllManifest) return [...summary.manifestItems];
  const names = foldedDepNames(summary.changes);
  const taken = [];
  for (const item of summary.manifestItems) {
    if (onlyDepEdits([item]) || hunkOnlyFoldedDeps(item, names)) {
      taken.push(item);
    }
  }
  return taken;
};

const DEP_CAPTION = 'Dependencies in package.json & package-lock.json';

const changeMarks = (change) => {
  const marks = [];
  if (change.unused) marks.push('unused');
  if (change.outdated && !change.propose) marks.push('outdated');
  if (change.audit) marks.push(change.audit.severity);
  return marks;
};

const changeSources = (change) => {
  const sources = [];
  if (change.unused) {
    sources.push('npm uninstall');
    return sources;
  }
  if (change.propose && change.outdated) sources.push('npm outdated');
  if (change.audit) sources.push('npm audit');
  return sources;
};

const sectionTitle = (section, action, marks, sources) => {
  const title = action === 'changed' ? 'version changed' : action;
  const kind = section.replace(/ies$/, 'y');
  let label = `${kind} ${title}`;
  if (section === 'field') label = `package.json ${title}`;
  if (section === 'resolved' && action === 'vulnerable') {
    label = 'lockfile vulnerable';
  } else if (section === 'resolved') {
    label = `lockfile resolved ${title}`;
  }
  if (marks.includes('unused')) {
    label = `${kind} unused`;
    const extra = [];
    for (const mark of marks) {
      if (mark !== 'unused') extra.push(mark);
    }
    if (extra.length) label = `${label}, ${extra.join(', ')}`;
  } else if (marks.length) {
    label = `${label}, ${marks.join(', ')}`;
  }
  if (!sources.length) return label;
  return `${sources.join(', ')}: ${label}`;
};

const entryText = (change, side) => {
  const version = side === 'old' ? change.from : change.to;
  return `"${change.name}": "${version}"`;
};

const ctxLine = (text) => ({ type: 'ctx', text });
const warnLine = (text) => ({ type: 'warn', text });
const noteLine = (text) => ({ type: 'note', text });
const noteSepLine = () => ({ type: 'noteSep', text: '' });

const changeLine = (type, change, side) => {
  const text = entryText(change, side);
  return { type, text };
};

const pushChangeLines = (rows, change) => {
  if (change.unused) {
    const side = change.action === 'added' ? 'new' : 'old';
    rows.push(changeLine('del', change, side));
    return;
  }
  if (change.action === 'added') {
    rows.push(changeLine('add', change, 'new'));
    return;
  }
  if (change.action === 'removed') {
    rows.push(changeLine('del', change, 'old'));
    return;
  }
  if (change.from === change.to) {
    rows.push(changeLine('ctx', change, 'old'));
    return;
  }
  rows.push(changeLine('del', change, 'old'));
  rows.push(changeLine('add', change, 'new'));
};

const lockCountText = (oldCount, newCount) => {
  if (oldCount === newCount) return '';
  return `lockfile packages  ${oldCount} → ${newCount}`;
};

const auditNoteTexts = (audit) => {
  if (!audit) return [];
  const notes = [];
  if (Array.isArray(audit.titles)) {
    for (const note of audit.titles) {
      if (note && !notes.includes(note)) notes.push(note);
    }
  } else if (audit.title) {
    notes.push(audit.title);
  }
  const severity = audit.severity;
  if (!notes.length) return [`npm audit  ${severity}`];
  return notes.map((note) => `npm audit  ${severity}  ${note}`);
};

const pushAuditNotes = (rows, audit) => {
  const texts = auditNoteTexts(audit);
  if (!texts.length) return;
  rows.push(ctxLine(''));
  let first = true;
  for (const text of texts) {
    if (!first) rows.push(noteSepLine());
    first = false;
    rows.push(noteLine(text));
  }
};

const buildRows = (change, oldCount, newCount) => {
  const rows = [ctxLine(DEP_CAPTION), ctxLine('')];
  if (change) {
    const marks = changeMarks(change);
    const sources = changeSources(change);
    const title = sectionTitle(change.section, change.action, marks, sources);
    const audited = sources.includes('npm audit');
    rows.push(audited ? warnLine(title) : ctxLine(title));
    rows.push(ctxLine(''));
    pushChangeLines(rows, change);
    pushAuditNotes(rows, change.audit);
  }
  const countLine = lockCountText(oldCount, newCount);
  if (countLine) {
    if (rows.at(-1).text !== '') rows.push(ctxLine(''));
    rows.push(ctxLine(countLine));
  }
  return rows;
};

const toHunkLine = (row, blockId) => ({
  type: row.type,
  text: row.text,
  noNl: false,
  blockId: isCtxType(row.type) ? null : blockId,
});

const makeHunk = (rows, blockId) => {
  const lines = rows.map((row) => toHunkLine(row, blockId));
  const counts = countSides(lines);
  const oldCount = counts.oldCount;
  const newCount = counts.newCount;
  const header = `@@ -1,${oldCount} +1,${newCount} @@`;
  return { oldStart: 1, oldCount, newStart: 1, newCount, header, lines };
};

const uniquePaths = (items) => {
  const files = [];
  const seen = new Set();
  for (const item of items) {
    const rel = itemPath(item);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    files.push(rel);
  }
  return files;
};

const filesForChange = (change, files) => {
  const manifest = [];
  const lockfile = [];
  for (const rel of files) {
    const meta = depFileMeta(rel);
    if (!meta) continue;
    if (meta.kind === 'manifest') manifest.push(rel);
    else lockfile.push(rel);
  }
  if (change.section === 'resolved') return lockfile.length ? lockfile : files;
  if (change.section === 'field' || change.propose) {
    return manifest.length ? manifest : files;
  }
  return manifest.length || lockfile.length
    ? [...manifest, ...lockfile]
    : files;
};

const pickPrimary = (items) => {
  for (const item of items) {
    const rel = itemPath(item);
    const meta = depFileMeta(rel);
    if (meta && meta.kind === 'manifest') return item;
  }
  return items[0];
};

const makeDepItem = (origin, fileItems, hidden, change, extra, blockId) => {
  const allFiles = uniquePaths(fileItems);
  const files = change ? filesForChange(change, allFiles) : allFiles;
  const primary = pickPrimary(fileItems);
  const rel = listFilePath(itemPath(primary));
  const counts = change ? {} : extra;
  const rows = buildRows(change, counts.oldCount ?? 0, counts.newCount ?? 0);
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
  const ordered = orderedChanges(summary.changes);
  if (!ordered.length) {
    const oldCount = summary.oldCount ?? 0;
    const newCount = summary.newCount ?? 0;
    if (oldCount === newCount) return [];
    return [makeDepItem(origin, fileItems, hidden, null, summary, 0)];
  }
  return ordered.map((change, index) =>
    makeDepItem(origin, fileItems, hidden, change, summary, index),
  );
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
  orderedChanges,
  summarizeGroup,
  collectGroups,
  takeManifestItems,
  foldedDepNames,
  stripFoldedDepItem,
  buildRows,
  makeHunk,
  makeDepItems,
  stubFileItem,
};
