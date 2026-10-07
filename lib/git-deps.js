'use strict';

const fs = require('node:fs');
const path = require('node:path');

const deps = require('./deps.js');
const { foldDepItems, mergeProposedItems } = deps;
const { parseAuditReport, parseOutdatedReport } = deps;
const { collectUsedNames, collectExportMeta } = deps;
const manifest = require('./manifest.js');
const { MANIFEST, LOCKFILE, depFileMeta, mergeDepFile, relOf } = manifest;
const { itemPath, isPathInScope } = require('./files.js');
const utilities = require('./utilities.js');
const { IS_WIN, abortError, npmBin, oneLine, runProc, runProcSync } = utilities;
const worktree = require('./git-worktree.js');
const { requireOk, runGit, gitText, worktreeText, readDepSides } = worktree;
const { revertOnePath, groupByPath, writeFile, writeIndex } = worktree;

const AUDIT_MS = 15000;
const INSTALL_MS = 120000;

const NPM_REPORT = {
  audit: {
    file: LOCKFILE,
    args: ['audit', '--json', '--package-lock-only'],
    parse: parseAuditReport,
  },
  outdated: {
    file: MANIFEST,
    args: ['outdated', '--json', '--long'],
    parse: parseOutdatedReport,
  },
};

const npmOptions = (cwd, timeout, signal) => ({
  cwd,
  timeout,
  signal,
  shell: IS_WIN,
});

const runNpm = (cwd, args) =>
  runProcSync(npmBin(), args, npmOptions(cwd, INSTALL_MS));

const runNpmAsync = (cwd, args) =>
  runProc(npmBin(), args, npmOptions(cwd, INSTALL_MS));

const npmOutput = (result) => (result.error ? '' : result.stdout);

const collectReport = (top, kind) => {
  const report = NPM_REPORT[kind];
  if (!fs.existsSync(path.join(top, report.file))) return null;
  const options = npmOptions(top, AUDIT_MS);
  return report.parse(npmOutput(runProcSync(npmBin(), report.args, options)));
};

const collectReportAsync = async (top, kind, signal) => {
  const report = NPM_REPORT[kind];
  if (!fs.existsSync(path.join(top, report.file))) return null;
  const options = npmOptions(top, AUDIT_MS, signal);
  const result = await runProc(npmBin(), report.args, options);
  return report.parse(npmOutput(result));
};

const depPaths = (item) => item.dep?.files ?? [];

const depChange = (item) => item.dep?.change ?? null;

const hasProposed = (item) => !!depChange(item)?.propose;

const isStagedOrCommit = (item) =>
  item.origin === 'staged' || item.origin === 'commit';

const firstDepRel = (rels, kind) =>
  rels.find((rel) => depFileMeta(rel)?.kind === kind) ?? '';

const proposedNpmPlan = (top, item) => {
  const change = depChange(item);
  if (!change) return null;
  const rels = depPaths(item);
  const lockOnly = change.section === 'resolved';
  const removing = !!change.unused;
  const manifestRel = firstDepRel(rels, 'manifest');
  const lockRel = firstDepRel(rels, 'lockfile');
  const meta = depFileMeta((lockOnly ? lockRel : manifestRel) || rels[0]);
  if (!meta) return null;
  let npmArgs = ['i'];
  if (removing) npmArgs = ['uninstall', change.name];
  else if (lockOnly) npmArgs = ['audit', 'fix'];
  return {
    cwd: meta.dir === '.' ? top : path.join(top, meta.dir),
    npmArgs,
    fail: removing ? 'npm uninstall failed' : 'npm i failed',
    lockOnly,
    lockPath: lockRel || relOf(meta.dir, LOCKFILE),
    manifest: manifestRel,
    prepareManifest: !lockOnly && !removing && !!manifestRel,
    runner: item.dep.install,
  };
};

const itemsForPath = (rel, items) => {
  const group = [];
  for (const item of items) {
    const listed = item.dep ? item.dep.items : [item];
    for (const entry of listed ?? []) {
      if (itemPath(entry) === rel) group.push(entry);
    }
  }
  return group;
};

const extrasNeeds = (items, rev, extra) => {
  const live = extra.audit === true && !rev;
  const hasDepDiff = items.some((item) => depFileMeta(itemPath(item)));
  const audit = live || (Boolean(extra.audit) && hasDepDiff);
  return { live, scan: live || hasDepDiff, audit };
};

const foldLoaded = (items, top, rev, extra) => {
  const readSides = (origin, rel) => readDepSides(top, rev, origin, rel);
  const needs = extrasNeeds(items, rev, extra);
  const collect = extra.collect !== false;
  const scan = collect && needs.scan;
  const usedNames = extra.usedNames ?? (scan ? collectUsedNames(top) : null);
  let { exportEntries, auditMap: audit, outdatedMap: outdated } = extra;
  if (scan && exportEntries === undefined) {
    exportEntries = collectExportMeta(top);
  }
  if (collect && needs.audit && audit === undefined) {
    audit = collectReport(top, 'audit');
  }
  if (collect && needs.live && outdated === undefined) {
    outdated = collectReport(top, 'outdated');
  }
  audit ??= null;
  outdated ??= null;
  const folded = foldDepItems(items, readSides, usedNames, audit, outdated, {
    root: top,
    exportEntries,
  });
  if (!needs.live || !isPathInScope(MANIFEST, extra.paths)) return folded;
  const pkgText = worktreeText(top, MANIFEST);
  const lockText = worktreeText(top, LOCKFILE);
  const options = { lockText, usedNames, root: top, exportEntries };
  return mergeProposedItems(folded, pkgText, outdated, audit, options);
};

const finishLoad = (snapshot, extra) => {
  const { top, rev, parsed } = snapshot;
  const options = { ...extra, collect: !extra.deferExtras };
  const items = foldLoaded(parsed, top, rev, options);
  const pending = extra.deferExtras && extrasNeeds(parsed, rev, extra).audit;
  return { ...snapshot, items, pending };
};

const later = (fn) => Promise.resolve().then(fn);

const reportTask = (wanted, known, collect) => {
  if (!wanted) return null;
  return known === undefined ? collect() : known;
};

const loadExtras = async (snapshot, extra = {}) => {
  const { top, rev, parsed } = snapshot;
  const { signal } = extra;
  const needs = extrasNeeds(parsed, rev, extra);
  const known = extra.exportEntries;
  const [usedNames, audit, outdated, exportEntries] = await Promise.all([
    needs.scan ? later(() => collectUsedNames(top)) : null,
    reportTask(needs.audit, extra.auditMap, () =>
      collectReportAsync(top, 'audit', signal),
    ),
    reportTask(needs.live, extra.outdatedMap, () =>
      collectReportAsync(top, 'outdated', signal),
    ),
    known === undefined && needs.scan
      ? later(() => collectExportMeta(top))
      : known,
  ]);
  if (signal && signal.aborted) throw abortError();
  const found = { usedNames, auditMap: audit, outdatedMap: outdated };
  const items = foldLoaded(parsed, top, rev, {
    ...extra,
    ...found,
    paths: extra.paths ?? [],
    exportEntries,
    collect: false,
  });
  return { ...snapshot, items, pending: false, ...found, exportEntries };
};

const captureFile = (top, rel) => {
  try {
    const text = fs.readFileSync(path.join(top, rel), 'utf8');
    return { rel, existed: true, text };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { rel, existed: false, text: '' };
  }
};

const restoreFile = (top, saved) => {
  const abs = path.join(top, saved.rel);
  if (saved.existed) fs.writeFileSync(abs, saved.text);
  else fs.rmSync(abs, { force: true });
};

const mergeLive = (top, rel, item, base, side) => {
  const sides = readDepSides(top, null, item.origin, rel);
  const { kind } = depFileMeta(rel);
  const change = depChange(item);
  return mergeDepFile(base, sides.oldText, sides.newText, change, side, kind);
};

const applyDepIndex = (top, rel, item, side) => {
  if (!depFileMeta(rel)) return;
  const indexed = gitText(top, `:${rel}`) || gitText(top, `HEAD:${rel}`);
  writeIndex(top, rel, mergeLive(top, rel, item, indexed, side));
};

const applyDepWorktree = (top, rel, item, side) => {
  if (!depFileMeta(rel)) return;
  const text = mergeLive(top, rel, item, worktreeText(top, rel), side);
  writeFile(top, rel, text);
};

const npmError = (result, fail) => {
  const { error } = result;
  const msg = error ? error.message : result.stderr || result.stdout;
  return new Error(oneLine(msg || fail, fail));
};

const stagePlan = (top, plan) => {
  const toAdd = [];
  if (!plan.lockOnly && plan.manifest) toAdd.push(plan.manifest);
  if (fs.existsSync(path.join(top, plan.lockPath))) toAdd.push(plan.lockPath);
  if (!toAdd.length) return;
  requireOk(runGit(['add', '--', ...toAdd], top));
};

const startPlan = (top, item) => {
  const plan = proposedNpmPlan(top, item);
  if (!plan) return null;
  const rels = [...new Set([plan.manifest, plan.lockPath].filter(Boolean))];
  const owned = rels.map((rel) => captureFile(top, rel));
  return { plan, owned };
};

const finishPlan = (top, plan, result, stage = stagePlan) => {
  const failed = result && (result.error || result.status !== 0);
  if (failed) throw npmError(result, plan.fail);
  stage(top, plan);
};

const restoreOwned = (top, owned) => {
  for (const saved of owned) restoreFile(top, saved);
};

const applyProposedUpdate = (top, item, extra = {}) => {
  const started = startPlan(top, item);
  if (!started) return;
  const { plan, owned } = started;
  try {
    if (plan.prepareManifest) applyDepWorktree(top, plan.manifest, item, 'new');
    const install = extra.run ?? plan.runner ?? runNpm;
    finishPlan(top, plan, install(plan.cwd, plan.npmArgs), extra.stage);
  } catch (error) {
    restoreOwned(top, owned);
    throw error;
  }
};

const applyProposedUpdateAsync = async (top, item) => {
  const started = startPlan(top, item);
  if (!started) return;
  const { plan, owned } = started;
  try {
    if (plan.prepareManifest) applyDepWorktree(top, plan.manifest, item, 'new');
    const install = plan.runner ?? runNpmAsync;
    finishPlan(top, plan, await install(plan.cwd, plan.npmArgs));
  } catch (error) {
    restoreOwned(top, owned);
    throw error;
  }
};

const applyDepChange = (top, item, mode) => {
  const change = depChange(item);
  if (change.propose) {
    if (mode === 'add') return void applyProposedUpdate(top, item);
    if (!change.unused) return;
  }
  for (const rel of depPaths(item)) {
    if (mode !== 'revert') {
      applyDepIndex(top, rel, item, mode === 'add' ? 'new' : 'old');
      continue;
    }
    if (item.origin === 'staged') applyDepIndex(top, rel, item, 'old');
    applyDepWorktree(top, rel, item, 'old');
  }
};

const addItem = (top, item) => {
  if (!item.dep) return void worktree.addItem(top, item);
  if (isStagedOrCommit(item)) return;
  if (depChange(item)) return void applyDepChange(top, item, 'add');
  const rels = depPaths(item);
  if (rels.length) requireOk(runGit(['add', '--', ...rels], top));
};

const addItemAsync = async (top, item) => {
  if (isStagedOrCommit(item) || !hasProposed(item)) {
    return void addItem(top, item);
  }
  await applyProposedUpdateAsync(top, item);
};

const unstageItem = (top, item) => {
  if (!item.dep) return void worktree.unstageItem(top, item);
  if (item.origin !== 'staged') return;
  if (depChange(item)) return void applyDepChange(top, item, 'unstage');
  const rels = depPaths(item);
  if (!rels.length) return;
  requireOk(runGit(['restore', '--staged', '--', ...rels], top));
};

const revertItem = (top, item) => {
  if (item.origin === 'commit') return;
  if (!item.dep) return void worktree.revertItem(top, item);
  if (depChange(item)) return void applyDepChange(top, item, 'revert');
  const byPath = groupByPath(item.dep.items ?? []);
  for (const rel of byPath.keys()) revertOnePath(top, rel, byPath.get(rel));
};

const revertFile = (top, rel, items) => {
  const rels = new Set([rel]);
  for (const item of items) {
    for (const file of depPaths(item)) rels.add(file);
  }
  for (const file of rels) {
    const group = itemsForPath(file, items);
    revertOnePath(top, file, group.length ? group : items);
  }
};

module.exports = {
  collectReportAsync,
  finishLoad,
  loadExtras,
  captureFile,
  restoreFile,
  proposedNpmPlan,
  applyProposedUpdate,
  addItem,
  addItemAsync,
  unstageItem,
  revertItem,
  revertFile,
};
