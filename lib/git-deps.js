'use strict';

const fs = require('node:fs');
const path = require('node:path');

const deps = require('./deps.js');
const { foldDepItems, mergeDepFile, depFileMeta } = deps;
const { parseAuditReport, parseOutdatedReport } = deps;
const { mergeProposedItems, MANIFEST, LOCKFILE } = deps;
const { collectUsedNames, collectExportMeta } = deps;
const files = require('./files.js');
const { itemPath, isPathInScope } = files;
const proc = require('./utilities.js');
const { abortError, npmBin, npmOpts, runProc, runProcSync } = proc;
const git = require('./git-worktree.js');
const { oneLine, requireOk, runGit } = git;
const { gitText, worktreeText, readDepSides, revertOnePath } = git;
const { writeFile, writeIndex } = git;

const AUDIT_MS = 15000;
const INSTALL_MS = 120000;

const npmProcOptions = (cwd, extra = {}) => ({
  cwd,
  encoding: proc.DEFAULT_ENCODING,
  maxBuffer: proc.DEFAULT_MAX_BUFFER,
  timeout: extra.timeout,
  signal: extra.signal,
  shell: npmOpts().shell,
});

const runNpm = (cwd, args) =>
  runProcSync(npmBin(), args, npmProcOptions(cwd, { timeout: INSTALL_MS }));

const runNpmAsync = (cwd, args, extra = {}) => {
  const bin = npmBin();
  const signal = extra.signal;
  const options = npmProcOptions(cwd, { timeout: INSTALL_MS, signal });
  return runProc(bin, args, options);
};

const runNpmJson = (top, args, timeout) => {
  const result = runProcSync(npmBin(), args, npmProcOptions(top, { timeout }));
  if (result.error) return '';
  return result.stdout || '';
};

const runNpmJsonAsync = async (top, args, timeout, signal) => {
  const result = await runProc(
    npmBin(),
    args,
    npmProcOptions(top, { timeout, signal }),
  );
  if (result.error) return '';
  return result.stdout || '';
};

const depPaths = (item) => item.dep?.files ?? [];

const origDepItems = (item) => item.dep?.items ?? [];

const depChange = (item) => item.dep?.change ?? null;

const firstDepRel = (files, kind) => {
  for (const rel of files) {
    const meta = depFileMeta(rel);
    if (meta && meta.kind === kind) return rel;
  }
  return '';
};

const proposedNpmPlan = (top, item) => {
  const change = depChange(item);
  if (!change) return null;
  const files = depPaths(item);
  const lockOnly = change.section === 'resolved';
  const removing = !!change.unused;
  const manifest = firstDepRel(files, 'manifest');
  const lockRel = firstDepRel(files, 'lockfile');
  const picked = lockOnly ? lockRel : manifest;
  const target = picked || files[0] || '';
  const meta = depFileMeta(target);
  if (!meta) return null;
  const cwd = meta.dir === '.' ? top : path.join(top, meta.dir);
  let npmArgs = ['i'];
  if (removing) npmArgs = ['uninstall', change.name];
  else if (lockOnly) npmArgs = ['audit', 'fix'];
  const fail = removing ? 'npm uninstall failed' : 'npm i failed';
  const dirLock = meta.dir === '.' ? LOCKFILE : `${meta.dir}/${LOCKFILE}`;
  const lockPath = lockRel || dirLock;
  const prepareManifest = !lockOnly && !removing && !!manifest;
  return {
    cwd,
    npmArgs,
    fail,
    lockOnly,
    lockPath,
    manifest,
    prepareManifest,
    runner: item.dep.install,
  };
};

const hasProposed = (item) => {
  const change = depChange(item);
  return !!(change && change.propose);
};

const itemsForPath = (rel, items) => {
  const group = [];
  for (const item of items) {
    if (item.dep) {
      for (const orig of origDepItems(item)) {
        if (itemPath(orig) === rel) group.push(orig);
      }
      continue;
    }
    if (itemPath(item) === rel) group.push(item);
  }
  return group;
};

const hasDepFile = (items) => {
  for (const item of items) {
    if (depFileMeta(itemPath(item))) return true;
  }
  return false;
};

const collectAudit = (top) => {
  const lock = path.join(top, LOCKFILE);
  if (!fs.existsSync(lock)) return null;
  const args = ['audit', '--json', '--package-lock-only'];
  const text = runNpmJson(top, args, AUDIT_MS);
  return parseAuditReport(text);
};

const collectOutdated = (top) => {
  const manifest = path.join(top, MANIFEST);
  if (!fs.existsSync(manifest)) return null;
  const args = ['outdated', '--json', '--long'];
  const text = runNpmJson(top, args, AUDIT_MS);
  return parseOutdatedReport(text);
};

const collectAuditAsync = async (top, extra, signal) => {
  if (extra.auditMap !== undefined) return extra.auditMap;
  const lock = path.join(top, LOCKFILE);
  if (!fs.existsSync(lock)) return null;
  const args = ['audit', '--json', '--package-lock-only'];
  const text = await runNpmJsonAsync(top, args, AUDIT_MS, signal);
  return parseAuditReport(text);
};

const collectOutdatedAsync = async (top, extra, signal) => {
  if (extra.outdatedMap !== undefined) return extra.outdatedMap;
  const manifest = path.join(top, MANIFEST);
  if (!fs.existsSync(manifest)) return null;
  const args = ['outdated', '--json', '--long'];
  const text = await runNpmJsonAsync(top, args, AUDIT_MS, signal);
  return parseOutdatedReport(text);
};

const pickNpmMap = (override, collect, top) => {
  if (override !== undefined) return override;
  return collect(top);
};

const foldLoaded = (items, top, rev, extra = {}) => {
  const readSides = (origin, rel) => readDepSides(top, rev, origin, rel);
  const live = extra.audit === true && !rev;
  const hasDepDiff = hasDepFile(items);
  const collect = extra.collect !== false;
  let usedNames = extra.usedNames ?? null;
  let audit = extra.auditMap;
  let outdated = extra.outdatedMap;
  let exportEntries = extra.exportEntries;
  if (collect && usedNames === null && (hasDepDiff || live)) {
    usedNames = collectUsedNames(top);
  }
  if (collect && exportEntries === undefined && (hasDepDiff || live)) {
    exportEntries = collectExportMeta(top);
  }
  if (collect && live) {
    audit = pickNpmMap(extra.auditMap, collectAudit, top);
    outdated = pickNpmMap(extra.outdatedMap, collectOutdated, top);
  } else if (collect && extra.audit && hasDepDiff) {
    audit = pickNpmMap(extra.auditMap, collectAudit, top);
  }
  if (audit === undefined) audit = null;
  if (outdated === undefined) outdated = null;
  const folded = foldDepItems(items, readSides, usedNames, audit, outdated, {
    root: top,
    exportEntries,
  });
  if (!live) return folded;
  if (!isPathInScope(MANIFEST, extra.paths ?? [])) return folded;
  const pkgText = worktreeText(top, MANIFEST);
  const lockText = worktreeText(top, LOCKFILE);
  const options = { lockText, usedNames, root: top, exportEntries };
  return mergeProposedItems(folded, pkgText, outdated, audit, options);
};

const needsExtras = (parsed, rev, extra) => {
  const live = extra.audit === true && !rev;
  if (live) return true;
  if (!extra.audit) return false;
  return hasDepFile(parsed);
};

const finishLoad = (snapshot, extra) => {
  const options = { ...extra, paths: extra.paths ?? [] };
  if (extra.deferExtras) options.collect = false;
  const parsed = snapshot.parsed;
  const top = snapshot.top;
  const rev = snapshot.rev;
  const items = foldLoaded(parsed, top, rev, options);
  const pending = extra.deferExtras && needsExtras(parsed, rev, extra);
  return { ...snapshot, items, pending };
};

const extrasMetaOf = (parsed, rev, extra, top, signal) => {
  const live = extra.audit === true && !rev;
  const hasDepDiff = hasDepFile(parsed);
  const needScan = live || hasDepDiff;
  let usedNames = Promise.resolve(null);
  if (needScan) {
    usedNames = Promise.resolve().then(() => collectUsedNames(top));
  }
  let exportEntries = Promise.resolve(undefined);
  if (extra.exportEntries !== undefined) {
    exportEntries = Promise.resolve(extra.exportEntries);
  } else if (needScan) {
    exportEntries = Promise.resolve().then(() => collectExportMeta(top));
  }
  let audit = Promise.resolve(null);
  if (live || (extra.audit && hasDepDiff)) {
    audit = collectAuditAsync(top, extra, signal);
  }
  let outdated = Promise.resolve(null);
  if (live) {
    outdated = collectOutdatedAsync(top, extra, signal);
  }
  return { usedNames, audit, outdated, exportEntries };
};

const loadExtras = async (snapshot, extra = {}) => {
  const top = snapshot.top;
  const rev = snapshot.rev;
  const parsed = snapshot.parsed;
  const signal = extra.signal;
  const tasks = extrasMetaOf(parsed, rev, extra, top, signal);
  const [usedNames, audit, outdated, exportEntries] = await Promise.all([
    tasks.usedNames,
    tasks.audit,
    tasks.outdated,
    tasks.exportEntries,
  ]);
  if (signal && signal.aborted) throw abortError();
  const folded = foldLoaded(parsed, top, rev, {
    ...extra,
    paths: extra.paths ?? [],
    usedNames,
    auditMap: audit,
    outdatedMap: outdated,
    exportEntries,
    collect: false,
  });
  return {
    ...snapshot,
    items: folded,
    pending: false,
    usedNames,
    auditMap: audit,
    outdatedMap: outdated,
    exportEntries,
  };
};

const captureFile = (top, rel) => {
  const abs = path.join(top, rel);
  try {
    const text = fs.readFileSync(abs, 'utf8');
    return { rel, existed: true, text };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { rel, existed: false, text: '' };
    }
    throw error;
  }
};

const restoreFile = (top, saved) => {
  const abs = path.join(top, saved.rel);
  if (saved.existed) return void fs.writeFileSync(abs, saved.text);
  try {
    fs.unlinkSync(abs);
  } catch {
    // missing
  }
};

const captureFiles = (top, rels) => {
  const { length } = rels;
  const owned = new Array(length);
  for (let i = 0; i < length; i++) owned[i] = captureFile(top, rels[i]);
  return owned;
};

const restoreFiles = (top, owned) => {
  for (const saved of owned) restoreFile(top, saved);
};

const mergeDepLive = (top, rel, change, origin, base, side, kind) => {
  const sides = readDepSides(top, null, origin, rel);
  return mergeDepFile(base, sides.oldText, sides.newText, change, side, kind);
};

const applyDepIndex = (top, rel, change, origin, side) => {
  const meta = depFileMeta(rel);
  if (!meta) return;
  const indexed = gitText(top, `:${rel}`) || gitText(top, `HEAD:${rel}`);
  const text = mergeDepLive(top, rel, change, origin, indexed, side, meta.kind);
  writeIndex(top, rel, text);
};

const applyDepWorktree = (top, rel, change, origin) => {
  const meta = depFileMeta(rel);
  if (!meta) return;
  const worktree = worktreeText(top, rel);
  const text = mergeDepLive(
    top,
    rel,
    change,
    origin,
    worktree,
    'old',
    meta.kind,
  );
  writeFile(top, rel, text);
};

const ownedRelsOf = (plan) => {
  const rels = [];
  if (plan.manifest) rels.push(plan.manifest);
  if (plan.lockPath && plan.lockPath !== plan.manifest) {
    rels.push(plan.lockPath);
  }
  return rels;
};

const errorFromResult = (result, fail) => {
  if (!result) return new Error(fail);
  if (result.error) {
    const msg = result.error.message || fail;
    return new Error(oneLine(msg, fail));
  }
  const msg = result.stderr || result.stdout || fail;
  return new Error(oneLine(msg, fail));
};

const applyPreparation = (top, item, plan) => {
  if (!plan.prepareManifest || !plan.manifest) return;
  const change = depChange(item);
  const origin = item.origin;
  const worktree = worktreeText(top, plan.manifest);
  const text = mergeDepLive(
    top,
    plan.manifest,
    change,
    origin,
    worktree,
    'new',
    'manifest',
  );
  writeFile(top, plan.manifest, text);
};

const stagePlan = (top, plan) => {
  const toAdd = [];
  if (!plan.lockOnly && plan.manifest) toAdd.push(plan.manifest);
  if (fs.existsSync(path.join(top, plan.lockPath))) toAdd.push(plan.lockPath);
  if (!toAdd.length) return;
  requireOk(runGit(['add', '--', ...toAdd], top));
};

const finishPlan = (top, plan, result, stage) => {
  if (result && (result.error || result.status !== 0)) {
    throw errorFromResult(result, plan.fail);
  }
  const stageFn = stage ?? stagePlan;
  stageFn(top, plan);
};

const applyProposedUpdate = (top, item, extra = {}) => {
  const plan = proposedNpmPlan(top, item);
  if (!plan) return;
  const owned = captureFiles(top, ownedRelsOf(plan));
  try {
    applyPreparation(top, item, plan);
    const install = extra.run ?? plan.runner ?? runNpm;
    const result = install(plan.cwd, plan.npmArgs);
    finishPlan(top, plan, result, extra.stage);
  } catch (error) {
    restoreFiles(top, owned);
    throw error;
  }
};

const applyProposedUpdateAsync = async (top, item, extra = {}) => {
  const plan = proposedNpmPlan(top, item);
  if (!plan) return;
  const owned = captureFiles(top, ownedRelsOf(plan));
  try {
    applyPreparation(top, item, plan);
    const run = extra.run ?? plan.runner ?? runNpmAsync;
    const result = await run(plan.cwd, plan.npmArgs);
    finishPlan(top, plan, result, extra.stage);
  } catch (error) {
    restoreFiles(top, owned);
    throw error;
  }
};

const applyDepChange = (top, item, mode) => {
  const change = depChange(item);
  if (change && change.propose) {
    if (mode === 'add') return void applyProposedUpdate(top, item);
    if (!change.unused) return;
  }
  const origin = item.origin;
  const files = depPaths(item);
  for (const rel of files) {
    if (mode === 'add') {
      applyDepIndex(top, rel, change, origin, 'new');
      continue;
    }
    if (mode === 'unstage') {
      applyDepIndex(top, rel, change, origin, 'old');
      continue;
    }
    if (origin === 'staged') applyDepIndex(top, rel, change, origin, 'old');
    applyDepWorktree(top, rel, change, origin);
  }
};

const addItem = (top, item) => {
  if (item.origin === 'staged' || item.origin === 'commit') return;
  if (depChange(item)) return void applyDepChange(top, item, 'add');
  const files = depPaths(item);
  if (files.length) {
    requireOk(runGit(['add', '--', ...files], top));
  }
};

const addItemAsync = async (top, item) => {
  if (item.origin === 'staged' || item.origin === 'commit') return;
  if (hasProposed(item)) {
    await applyProposedUpdateAsync(top, item);
    return;
  }
  addItem(top, item);
};

const unstageItem = (top, item) => {
  if (item.origin !== 'staged') return;
  if (depChange(item)) return void applyDepChange(top, item, 'unstage');
  const files = depPaths(item);
  if (files.length) {
    requireOk(runGit(['restore', '--staged', '--', ...files], top));
  }
};

const revertDepItem = (top, item) => {
  if (depChange(item)) return void applyDepChange(top, item, 'revert');
  const byPath = new Map();
  for (const orig of origDepItems(item)) {
    const rel = itemPath(orig);
    const list = byPath.get(rel);
    if (list) list.push(orig);
    else byPath.set(rel, [orig]);
  }
  for (const rel of byPath.keys()) {
    revertOnePath(top, rel, byPath.get(rel));
  }
};

const revertFile = (top, rel, items) => {
  const paths = new Set([rel]);
  for (const item of items) {
    for (const file of depPaths(item)) paths.add(file);
  }
  for (const file of paths) {
    const group = itemsForPath(file, items);
    const targets = group.length ? group : items;
    revertOnePath(top, file, targets);
  }
};

module.exports = {
  hasProposed,
  itemsForPath,
  finishLoad,
  loadExtras,
  captureFile,
  restoreFile,
  applyProposedUpdate,
  applyProposedUpdateAsync,
  applyDepChange,
  addItem,
  addItemAsync,
  unstageItem,
  revertDepItem,
  revertFile,
  AUDIT_MS,
  INSTALL_MS,
  runNpm,
  runNpmAsync,
  runNpmJson,
  runNpmJsonAsync,
  proposedNpmPlan,
};
