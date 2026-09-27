'use strict';

const nodeTest = require('node:test');
const { test } = nodeTest;
const assert = require('node:assert/strict');

const deps = require('../lib/deps.js');
const diff = require('../lib/diff/diff.js');
const git = require('../lib/git.js');
const gitDeps = require('../lib/git-deps.js');
const { proposedNpmPlan } = gitDeps;
const render = require('../lib/render/render.js');
const session = require('../lib/session.js');
const { Session } = session;
const fs = require('node:fs');
const path = require('node:path');
const { realpathSync } = fs;
const helpers = require('./helpers.js');
const { makeRepo, sink } = helpers;
const ansi = require('../lib/ansi.js');
const { stripAnsi, THEME, bg } = ansi;
const { parseDiff, itemsFromFiles } = diff;
const { load, loadExtras, addItem, unstageItem, revertItem } = git;
const { foldDepItems, readSections, diffSections } = deps;
const { mergeResolved, lockEntries, lockPackageCount } = deps;
const { mergeDepFile, collectUsedNames, parseAuditReport } = deps;
const { parseOutdatedReport, applyWantedRange, proposeDepItems } = deps;
const { patchedFromRange, mergeProposedItems } = deps;

const pkgJson = (dependencies, extra = {}) => {
  const body = { name: 'demo', ...extra, dependencies };
  return `${JSON.stringify(body, null, 2)}\n`;
};

const pkgLib = (dependencies, extra = {}) =>
  pkgJson(dependencies, { main: 'index.js', ...extra });

const noExportPkg = (name) => {
  const bin = { [name]: 'cli.js' };
  return `${JSON.stringify({ name, bin }, null, 2)}\n`;
};

const libPkg = (name) => {
  const body = { name, main: 'index.js' };
  return `${JSON.stringify(body, null, 2)}\n`;
};

const toolPkg = (name, binName) => {
  const bin = { [binName]: 'bin.js' };
  const body = { name, main: 'index.js', bin };
  return `${JSON.stringify(body, null, 2)}\n`;
};

const typesPkg = (name) => {
  const exported = { '.': { types: './index.d.ts' } };
  const body = { name, types: 'index.d.ts', exports: exported };
  return `${JSON.stringify(body, null, 2)}\n`;
};

const exportsOf = (name) => new Map([[name, true]]);

const lockV3 = (dependencies, versions) => {
  const packages = { '': { dependencies } };
  for (const name of Object.keys(versions)) {
    const version = versions[name];
    packages[`node_modules/${name}`] = { version };
  }
  const body = { lockfileVersion: 3, packages };
  return `${JSON.stringify(body, null, 2)}\n`;
};

const dummyFile = (rel, isNew = false) => {
  const oldPath = rel;
  const newPath = rel;
  const isDeleted = false;
  const isBinary = false;
  const preamble = [];
  const hunks = [];
  return { oldPath, newPath, isNew, isDeleted, isBinary, preamble, hunks };
};

const dummyItem = (rel, origin = 'unstaged', isNew = false) => {
  const file = dummyFile(rel, isNew);
  const lines = [{ type: 'add', text: 'x', noNl: false, blockId: 0 }];
  const oldStart = 1;
  const oldCount = 1;
  const newStart = 1;
  const newCount = 1;
  const header = '@@ -1,1 +1,1 @@';
  const hunk = { oldStart, oldCount, newStart, newCount, header, lines };
  const blockId = 0;
  const patchAdd = '';
  const patchRevert = '';
  return { origin, file, hunk, blockId, patchAdd, patchRevert };
};

const dummyHunkItem = (rel, rows, origin = 'unstaged') => {
  const file = dummyFile(rel);
  const lines = rows.map((row) => {
    const type = row.type;
    const text = row.text;
    const noNl = false;
    const blockId = type === 'ctx' ? null : 0;
    return { type, text, noNl, blockId };
  });
  const oldStart = 1;
  const oldCount = 1;
  const newStart = 1;
  const newCount = 1;
  const header = '@@ -1,1 +1,1 @@';
  const hunk = { oldStart, oldCount, newStart, newCount, header, lines };
  const blockId = 0;
  const patchAdd = '';
  const patchRevert = '';
  return { origin, file, hunk, blockId, patchAdd, patchRevert };
};

const splitHunkItems = (rel, lines) => {
  const file = dummyFile(rel);
  const oldStart = 1;
  const oldCount = 1;
  const newStart = 1;
  const newCount = 1;
  const header = '@@ -1,1 +1,1 @@';
  const hunk = { oldStart, oldCount, newStart, newCount, header, lines };
  const ids = [];
  const seen = new Set();
  for (const line of lines) {
    const blockId = line.blockId;
    if (typeof blockId !== 'number' || seen.has(blockId)) continue;
    seen.add(blockId);
    ids.push(blockId);
  }
  const items = [];
  for (const blockId of ids) {
    const origin = 'unstaged';
    const patchAdd = '';
    const patchRevert = '';
    items.push({ origin, file, hunk, blockId, patchAdd, patchRevert });
  }
  return items;
};

const DEP_CAPTION = 'Dependencies in package.json & package-lock.json';

const sidesOf = (files) => (origin, rel) => {
  const pair = files[rel];
  if (!pair) return { oldText: '', newText: '' };
  return pair;
};

const sessionFor = (dir) => {
  const stdout = sink();
  const session = new Session({
    repo: git.createGitRepo(),
    cwd: dir,
    stdout,
    color: false,
    startPane: 'diff',
  });
  session.load();
  return session;
};

const hunkTexts = (item) => item.hunk.lines.map((line) => line.text);

const assertBlankAfter = (lines, heading) => {
  const at = lines.indexOf(heading);
  assert.ok(at >= 0, heading);
  assert.equal(lines[at + 1], '');
};

const depByName = (items, name) => {
  for (const item of items) {
    const change = item.dep && item.dep.change;
    if (change && change.name === name) return item;
  }
  return null;
};

const parseGitJson = (repo, spec) => JSON.parse(repo.git(['show', spec]));

test('mergeDepFile applies one dependency and leaves others', () => {
  const oldDeps = { lodash: '^4.17.20' };
  const newDeps = { lodash: '^4.17.21', leftpad: '1.0.0' };
  const oldText = pkgJson(oldDeps);
  const newText = pkgJson(newDeps);
  const name = 'lodash';
  const section = 'dependencies';
  const action = 'changed';
  const from = '^4.17.20';
  const to = '^4.17.21';
  const change = { name, section, action, from, to };
  const staged = mergeDepFile(
    oldText,
    oldText,
    newText,
    change,
    'new',
    'manifest',
  );
  const stagedPkg = JSON.parse(staged);
  assert.equal(stagedPkg.dependencies.lodash, '^4.17.21');
  assert.equal(stagedPkg.dependencies.leftpad, undefined);
  const reverted = mergeDepFile(
    newText,
    oldText,
    newText,
    change,
    'old',
    'manifest',
  );
  const workPkg = JSON.parse(reverted);
  assert.equal(workPkg.dependencies.lodash, '^4.17.20');
  assert.equal(workPkg.dependencies.leftpad, '1.0.0');
});

test('diffSections reports added removed and version changes', () => {
  const oldPkg = {
    dependencies: { lodash: '^4.17.20', left: '1.0.0' },
    devDependencies: { eslint: '^8.0.0' },
  };
  const newPkg = {
    dependencies: { lodash: '^4.17.21', right: '2.0.0' },
    devDependencies: { eslint: '^9.0.0' },
  };
  const oldMaps = readSections(oldPkg);
  const newMaps = readSections(newPkg);
  const changes = diffSections(oldMaps, newMaps);
  const entries = changes.map((change) => [change.name, change]);
  const byName = Object.fromEntries(entries);
  assert.equal(byName.lodash.action, 'changed');
  assert.equal(byName.lodash.section, 'dependencies');
  assert.equal(byName.lodash.from, '^4.17.20');
  assert.equal(byName.lodash.to, '^4.17.21');
  assert.equal(byName.left.action, 'removed');
  assert.equal(byName.right.action, 'added');
  assert.equal(byName.eslint.action, 'changed');
  assert.equal(byName.eslint.section, 'devDependencies');
});

test('mergeResolved does not duplicate a package.json change', () => {
  const oldMaps = readSections({ dependencies: { lodash: '^4.17.20' } });
  const newMaps = readSections({ dependencies: { lodash: '^4.17.21' } });
  const manifest = diffSections(oldMaps, newMaps);
  const oldLock = {
    packages: { 'node_modules/lodash': { version: '4.17.20' } },
  };
  const newLock = {
    packages: { 'node_modules/lodash': { version: '4.17.21' } },
  };
  const oldResolved = lockEntries(oldLock);
  const newResolved = lockEntries(newLock);
  const merged = mergeResolved(
    manifest,
    oldResolved,
    newResolved,
    oldMaps,
    newMaps,
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].name, 'lodash');
  assert.equal(merged[0].resolvedFrom, '4.17.20');
  assert.equal(merged[0].resolvedTo, '4.17.21');
});

test('collectUsedNames reads require and npm scripts', () => {
  const repo = makeRepo();
  try {
    const scripts = { lint: 'eslint .' };
    const body = { name: 'demo', scripts, dependencies: { lodash: '1' } };
    repo.write('app.js', 'const _ = require("lodash");\n');
    repo.write('package.json', `${JSON.stringify(body, null, 2)}\n`);
    const used = collectUsedNames(repo.dir);
    assert.ok(used.has('lodash'));
    assert.ok(used.has('eslint'));
  } finally {
    repo.cleanup();
  }
});

test('foldDepItems splits each dependency into its own item', () => {
  const oldDeps = { lodash: '^4.17.20' };
  const newDeps = { lodash: '^4.17.21', leftpad: '1.0.0' };
  const items = [
    dummyItem('lib/a.js'),
    dummyItem('package.json'),
    dummyItem('package-lock.json'),
    dummyItem('lib/b.js'),
  ];
  const folded = foldDepItems(
    items,
    sidesOf({
      'package.json': {
        oldText: pkgJson(oldDeps),
        newText: pkgJson(newDeps),
      },
      'package-lock.json': {
        oldText: lockV3(oldDeps, { lodash: '4.17.20' }),
        newText: lockV3(newDeps, { lodash: '4.17.21', leftpad: '1.0.0' }),
      },
    }),
  );
  assert.equal(folded.length, 4);
  assert.equal(folded[0].file.newPath, 'lib/a.js');
  assert.ok(folded[1].dep);
  assert.ok(folded[2].dep);
  assert.equal(folded[3].file.newPath, 'lib/b.js');
  const names = [folded[1].dep.change.name, folded[2].dep.change.name];
  assert.deepEqual(names, ['leftpad', 'lodash']);
  assert.equal(folded[1].dep.change.action, 'added');
  assert.equal(folded[2].dep.change.action, 'changed');
  assert.deepEqual(folded[1].dep.files, ['package.json', 'package-lock.json']);
  assert.deepEqual(folded[2].dep.files, ['package.json', 'package-lock.json']);
  const added = hunkTexts(folded[1]);
  assert.equal(added[0], DEP_CAPTION);
  assertBlankAfter(added, 'dependency added');
  assert.ok(added.some((line) => line.includes('leftpad')));
  assert.ok(!added.some((line) => line.includes('lodash')));
  const bumped = hunkTexts(folded[2]);
  assert.equal(bumped[0], DEP_CAPTION);
  assertBlankAfter(bumped, 'dependency version changed');
  assert.equal(bumped.filter((line) => line.includes('lodash')).length, 2);
  assert.ok(!bumped.some((line) => line.includes('leftpad')));
});

test('foldDepItems marks an added dependency that is not imported', () => {
  const oldDeps = { lodash: '^4.17.20' };
  const newDeps = { lodash: '^4.17.20', leftpad: '1.0.0' };
  const items = [dummyItem('package.json'), dummyItem('package-lock.json')];
  const used = new Set(['lodash']);
  const folded = foldDepItems(
    items,
    sidesOf({
      'package.json': {
        oldText: pkgLib(oldDeps),
        newText: pkgLib(newDeps),
      },
      'package-lock.json': {
        oldText: lockV3(oldDeps, { lodash: '4.17.20' }),
        newText: lockV3(newDeps, { lodash: '4.17.20', leftpad: '1.0.0' }),
      },
    }),
    used,
    null,
    null,
    { exportEntries: exportsOf('leftpad') },
  );
  const leftpad = depByName(folded, 'leftpad');
  assert.ok(leftpad);
  assert.equal(leftpad.dep.change.unused, true);
  assert.equal(leftpad.dep.change.propose, true);
  const lines = hunkTexts(leftpad);
  const heading = 'npm uninstall: dependency unused';
  const entry = '"leftpad": "1.0.0"';
  assertBlankAfter(lines, heading);
  const gone = leftpad.hunk.lines.find((line) => line.text === entry);
  assert.equal(gone.type, 'del');
});

test('foldDepItems does not mark an imported added dependency unused', () => {
  const oldDeps = { lodash: '^4.17.20' };
  const newDeps = { lodash: '^4.17.20', leftpad: '1.0.0' };
  const items = [dummyItem('package.json')];
  const used = new Set(['leftpad']);
  const folded = foldDepItems(
    items,
    sidesOf({
      'package.json': {
        oldText: pkgJson(oldDeps),
        newText: pkgJson(newDeps),
      },
    }),
    used,
  );
  const leftpad = depByName(folded, 'leftpad');
  assert.ok(leftpad);
  assert.ok(!leftpad.dep.change.unused);
  assert.ok(hunkTexts(leftpad).includes('dependency added'));
  assert.ok(!hunkTexts(leftpad).includes('dependency added, unused'));
  assert.ok(!hunkTexts(leftpad).includes('npm uninstall: dependency unused'));
});

test('foldDepItems does not mark unused without an export entry', () => {
  const oldDeps = { lodash: '^4.17.20' };
  const newDeps = { lodash: '^4.17.20', leftpad: '1.0.0' };
  const items = [dummyItem('package.json')];
  const used = new Set(['lodash']);
  const folded = foldDepItems(
    items,
    sidesOf({
      'package.json': {
        oldText: pkgJson(oldDeps),
        newText: pkgJson(newDeps),
      },
    }),
    used,
  );
  const leftpad = depByName(folded, 'leftpad');
  assert.ok(leftpad);
  assert.ok(!leftpad.dep.change.unused);
  assertBlankAfter(hunkTexts(leftpad), 'dependency added');
  assert.ok(!hunkTexts(leftpad).includes('npm uninstall: dependency unused'));
});

test('proposeDepItems shows an unused dependency as a removal', () => {
  const repo = makeRepo();
  try {
    repo.write('node_modules/leftpad/package.json', libPkg('leftpad'));
    const used = new Set(['eslint']);
    const pkg = pkgLib({ eslint: '^9.39.5', leftpad: '1.0.0' });
    const proposed = proposeDepItems(pkg, null, null, {
      usedNames: used,
      root: repo.dir,
    });
    const item = depByName(proposed, 'leftpad');
    assert.ok(item);
    assert.equal(item.dep.change.propose, true);
    assert.equal(item.dep.change.unused, true);
    assert.equal(item.dep.change.action, 'removed');
    const lines = hunkTexts(item);
    assertBlankAfter(lines, 'npm uninstall: dependency unused');
    const entry = '"leftpad": "1.0.0"';
    const gone = item.hunk.lines.find((line) => line.text === entry);
    assert.equal(gone.type, 'del');
    assert.equal(depByName(proposed, 'eslint'), null);
  } finally {
    repo.cleanup();
  }
});

test('proposeDepItems skips unused without an export entry', () => {
  const used = new Set(['eslint']);
  const pkg = pkgJson({ eslint: '^9.39.5', leftpad: '1.0.0' });
  const proposed = proposeDepItems(pkg, null, null, { usedNames: used });
  assert.equal(depByName(proposed, 'leftpad'), null);
});

test('foldDepItems skips unused for a dep with no exports', () => {
  const repo = makeRepo();
  try {
    const oldDeps = { lodash: '^4.17.20' };
    const newDeps = { lodash: '^4.17.20', metaskills: '^1.0.5' };
    repo.write(
      'node_modules/metaskills/package.json',
      noExportPkg('metaskills'),
    );
    const items = [dummyItem('package.json')];
    const used = new Set(['lodash']);
    const folded = foldDepItems(
      items,
      sidesOf({
        'package.json': {
          oldText: pkgLib(oldDeps),
          newText: pkgLib(newDeps),
        },
      }),
      used,
      null,
      null,
      { root: repo.dir },
    );
    const item = depByName(folded, 'metaskills');
    assert.ok(item);
    assert.ok(!item.dep.change.unused);
    assertBlankAfter(hunkTexts(item), 'dependency added');
    const heading = 'npm uninstall: dependency unused';
    assert.ok(!hunkTexts(item).includes(heading));
  } finally {
    repo.cleanup();
  }
});

test('proposeDepItems skips unused for a dep with no exports', () => {
  const repo = makeRepo();
  try {
    repo.write(
      'node_modules/metaskills/package.json',
      noExportPkg('metaskills'),
    );
    const used = new Set(['eslint']);
    const pkg = pkgLib({ eslint: '^9.39.5', metaskills: '^1.0.5' });
    const proposed = proposeDepItems(pkg, null, null, {
      usedNames: used,
      root: repo.dir,
    });
    assert.equal(depByName(proposed, 'metaskills'), null);
  } finally {
    repo.cleanup();
  }
});

test('proposeDepItems removes an unused devDependency that exports', () => {
  const repo = makeRepo();
  try {
    repo.write('node_modules/leftpad/package.json', libPkg('leftpad'));
    const used = new Set(['eslint']);
    const body = {
      name: 'demo',
      main: 'index.js',
      dependencies: { eslint: '^9.39.5' },
      devDependencies: { leftpad: '1.0.0' },
    };
    const pkg = `${JSON.stringify(body, null, 2)}\n`;
    const proposed = proposeDepItems(pkg, null, null, {
      usedNames: used,
      root: repo.dir,
    });
    const item = depByName(proposed, 'leftpad');
    assert.ok(item);
    assert.equal(item.dep.change.section, 'devDependencies');
    assert.equal(item.dep.change.unused, true);
    assertBlankAfter(hunkTexts(item), 'npm uninstall: devDependency unused');
  } finally {
    repo.cleanup();
  }
});

test('proposeDepItems skips a CLI tool that is not imported', () => {
  const repo = makeRepo();
  try {
    const manifest = 'node_modules/typescript/package.json';
    repo.write(manifest, toolPkg('typescript', 'tsc'));
    const used = new Set(['eslint']);
    const pkg = pkgLib({ eslint: '^9.39.5', typescript: '5.9.2' });
    const proposed = proposeDepItems(pkg, null, null, {
      usedNames: used,
      root: repo.dir,
    });
    assert.equal(depByName(proposed, 'typescript'), null);
  } finally {
    repo.cleanup();
  }
});

test('proposeDepItems skips a types-only package', () => {
  const repo = makeRepo();
  try {
    const manifest = 'node_modules/@types/node/package.json';
    repo.write(manifest, typesPkg('@types/node'));
    const used = new Set(['eslint']);
    const deps = { eslint: '^9.39.5', '@types/node': '^22.0.0' };
    const pkg = pkgLib(deps);
    const proposed = proposeDepItems(pkg, null, null, {
      usedNames: used,
      root: repo.dir,
    });
    assert.equal(depByName(proposed, '@types/node'), null);
  } finally {
    repo.cleanup();
  }
});

test('parseAuditReport reads npm audit v2 vulnerabilities', () => {
  const report = {
    auditReportVersion: 2,
    vulnerabilities: {
      lodash: {
        name: 'lodash',
        severity: 'high',
        via: [
          {
            title: 'Prototype Pollution in lodash',
            severity: 'high',
          },
        ],
      },
    },
  };
  const audit = parseAuditReport(JSON.stringify(report));
  const found = audit.get('lodash');
  assert.ok(found);
  assert.equal(found.severity, 'high');
  assert.equal(found.title, 'lodash: Prototype Pollution in lodash');
  assert.deepEqual(found.titles, ['lodash: Prototype Pollution in lodash']);
});

test('parseAuditReport keeps every advisory title', () => {
  const report = {
    auditReportVersion: 2,
    vulnerabilities: {
      'brace-expansion': {
        name: 'brace-expansion',
        severity: 'high',
        via: [
          {
            name: 'brace-expansion',
            title:
              'brace-expansion: DoS via exponential-time expansion of ' +
              'consecutive groups',
          },
          {
            name: 'brace-expansion',
            title: 'DoS via unbounded expansion length',
          },
        ],
      },
    },
  };
  const audit = parseAuditReport(JSON.stringify(report));
  const found = audit.get('brace-expansion');
  assert.equal(found.titles.length, 2);
  assert.ok(found.titles[0].startsWith('brace-expansion: DoS via exponential'));
  assert.ok(!found.titles[0].includes('brace-expansion: brace-expansion:'));
  assert.ok(found.titles[1].includes('unbounded expansion length'));
});

test('parseAuditReport maps affected dependents from effects', () => {
  const report = {
    auditReportVersion: 2,
    vulnerabilities: {
      minimatch: {
        name: 'minimatch',
        severity: 'high',
        effects: ['eslint'],
        via: [{ title: 'ReDoS in minimatch', severity: 'high' }],
        fixAvailable: true,
      },
    },
  };
  const audit = parseAuditReport(JSON.stringify(report));
  const eslint = audit.get('eslint');
  assert.ok(eslint);
  assert.equal(eslint.severity, 'high');
  assert.equal(eslint.title, 'minimatch: ReDoS in minimatch');
});

test('foldDepItems marks a dependency with an npm audit warning', () => {
  const oldDeps = { lodash: '^4.17.20' };
  const newDeps = { lodash: '^4.17.21' };
  const items = [dummyItem('package.json'), dummyItem('package-lock.json')];
  const audit = new Map();
  const severity = 'high';
  const title = 'Prototype Pollution in lodash';
  audit.set('lodash', { severity, title });
  const folded = foldDepItems(
    items,
    sidesOf({
      'package.json': {
        oldText: pkgJson(oldDeps),
        newText: pkgJson(newDeps),
      },
      'package-lock.json': {
        oldText: lockV3(oldDeps, { lodash: '4.17.20' }),
        newText: lockV3(newDeps, { lodash: '4.17.21' }),
      },
    }),
    null,
    audit,
  );
  const lodash = depByName(folded, 'lodash');
  assert.ok(lodash);
  assert.equal(lodash.dep.change.audit.severity, 'high');
  const lines = hunkTexts(lodash);
  assert.ok(lines.includes('npm audit: dependency version changed, high'));
  assert.ok(lines.includes('npm audit  high  Prototype Pollution in lodash'));
});

test('parseOutdatedReport reads npm outdated json', () => {
  const report = {
    lodash: {
      current: '4.17.20',
      wanted: '4.17.21',
      latest: '4.17.21',
      type: 'dependencies',
    },
  };
  const outdated = parseOutdatedReport(JSON.stringify(report));
  const found = outdated.get('lodash');
  assert.ok(found);
  assert.equal(found.wanted, '4.17.21');
  assert.equal(found.current, '4.17.20');
});

test('applyWantedRange keeps caret and tilde prefixes', () => {
  assert.equal(applyWantedRange('^4.17.20', '4.17.21'), '^4.17.21');
  assert.equal(applyWantedRange('~1.2.3', '1.2.9'), '~1.2.9');
  assert.equal(applyWantedRange('4.17.20', '4.17.21'), '4.17.21');
});

test('proposeDepItems shows an outdated bump as a diff', () => {
  const outdated = new Map();
  outdated.set('lodash', {
    current: '4.17.20',
    wanted: '4.17.21',
    latest: '4.17.21',
    type: 'dependencies',
  });
  const proposed = proposeDepItems(pkgJson({ lodash: '^4.17.20' }), outdated);
  assert.equal(proposed.length, 1);
  const item = proposed[0];
  assert.equal(item.dep.change.propose, true);
  assert.equal(item.dep.change.to, '^4.17.21');
  const lines = hunkTexts(item);
  assertBlankAfter(lines, 'npm outdated: dependency version changed');
  assert.ok(!lines.some((line) => line.startsWith('npm outdated  ')));
});

test('proposeDepItems names npm audit next to npm outdated', () => {
  const outdated = new Map();
  outdated.set('lodash', {
    current: '4.17.20',
    wanted: '4.17.21',
    latest: '4.17.21',
    type: 'dependencies',
  });
  const audit = new Map();
  audit.set('lodash', {
    severity: 'high',
    title: 'Prototype Pollution in lodash',
    fix: '',
  });
  const proposed = proposeDepItems(
    pkgJson({ lodash: '^4.17.20' }),
    outdated,
    audit,
  );
  const lines = hunkTexts(proposed[0]);
  const title = 'npm outdated, npm audit: dependency version changed, high';
  assert.ok(lines.includes(title));
});

test('proposeDepItems shows an audit-only direct dependency', () => {
  const audit = new Map();
  audit.set('lodash', {
    severity: 'high',
    title: 'Prototype Pollution in lodash',
    fix: '',
  });
  const proposed = proposeDepItems(
    pkgJson({ lodash: '^4.17.20' }),
    null,
    audit,
  );
  const item = proposed[0];
  assert.ok(item);
  assert.equal(item.dep.change.action, 'vulnerable');
  const lines = hunkTexts(item);
  assert.ok(lines.includes('npm audit: dependency vulnerable, high'));
  assert.ok(lines.includes('"lodash": "^4.17.20"'));
});

test('patchedFromRange takes the first version outside the advisory', () => {
  assert.equal(patchedFromRange('1.1.15', '<=1.1.17'), '1.1.18');
  assert.equal(patchedFromRange('1.1.11', '<1.1.12'), '1.1.12');
  const split = '<=1.1.11 || >=2.0.0 <=2.0.1';
  assert.equal(patchedFromRange('1.1.11', split), '1.1.12');
  assert.equal(patchedFromRange('2.0.1', split), '2.0.2');
  assert.equal(patchedFromRange('1.1.18', '<=1.1.17'), '');
});

test('proposeDepItems shows a transitive npm audit finding', () => {
  const audit = new Map();
  audit.set('brace-expansion', {
    severity: 'high',
    title: 'DoS via exponential-time expansion',
    fix: '',
    range: '<=1.1.17',
  });
  const pkg = pkgJson({ eslint: '^9.39.5' });
  const lock = lockV3(
    { eslint: '^9.39.5' },
    { eslint: '9.39.5', 'brace-expansion': '1.1.15' },
  );
  const proposed = proposeDepItems(pkg, null, audit, { lockText: lock });
  const item = depByName(proposed, 'brace-expansion');
  assert.ok(item);
  assert.equal(item.dep.change.section, 'resolved');
  assert.equal(item.dep.change.from, '1.1.15');
  assert.equal(item.dep.change.to, '1.1.18');
  assert.deepEqual(item.dep.files, ['package-lock.json']);
  assert.equal(item.file.newPath, 'package.json');
  const lines = hunkTexts(item);
  const heading = 'npm audit: lockfile vulnerable, high';
  const oldEntry = '"brace-expansion": "1.1.15"';
  const newEntry = '"brace-expansion": "1.1.18"';
  const note = 'npm audit  high  DoS via exponential-time expansion';
  const titleAt = lines.indexOf(heading);
  assert.ok(titleAt >= 0);
  assert.equal(lines[titleAt + 1], '');
  assert.equal(lines[titleAt + 2], oldEntry);
  assert.equal(lines[titleAt + 3], newEntry);
  assert.equal(lines[titleAt + 4], '');
  assert.equal(lines[titleAt + 5], note);
  const title = item.hunk.lines.find((line) => line.text === heading);
  assert.equal(title.type, 'warn');
  const noteLine = item.hunk.lines.find((line) => line.text === note);
  assert.equal(noteLine.type, 'note');
  const oldLine = item.hunk.lines.find((line) => line.text === oldEntry);
  const newLine = item.hunk.lines.find((line) => line.text === newEntry);
  assert.equal(oldLine.type, 'del');
  assert.equal(newLine.type, 'add');
});

test('proposeDepItems uses an audit fix version when not outdated', () => {
  const audit = new Map();
  audit.set('lodash', {
    severity: 'high',
    title: 'Prototype Pollution in lodash',
    fix: '4.17.21',
  });
  const proposed = proposeDepItems(
    pkgJson({ lodash: '^4.17.20' }),
    null,
    audit,
  );
  const item = proposed[0];
  assert.ok(item);
  assert.equal(item.dep.change.to, '^4.17.21');
  const lines = hunkTexts(item);
  assert.ok(lines.includes('npm audit: dependency version changed, high'));
  assert.ok(lines.includes('npm audit  high  Prototype Pollution in lodash'));
});

test('mergeProposedItems inserts extras after package.json diffs', () => {
  const leftover = dummyHunkItem('package.json', [
    { type: 'del', text: '  "version": "0.1.8",' },
    { type: 'add', text: '  "version": "0.1.9",' },
  ]);
  const items = [dummyItem('keep.js'), leftover, dummyItem('lib/a.js')];
  const outdated = new Map();
  outdated.set('prettier', {
    current: '3.9.7',
    wanted: '3.9.8',
    latest: '3.9.8',
    type: 'devDependencies',
  });
  const merged = mergeProposedItems(
    items,
    pkgJson({ prettier: '^3.9.7' }, { version: '0.1.9' }),
    outdated,
    null,
  );
  assert.equal(merged.length, 4);
  assert.equal(merged[0].file.newPath, 'keep.js');
  assert.equal(merged[1], leftover);
  assert.ok(merged[2].dep);
  assert.equal(merged[2].dep.change.name, 'prettier');
  assert.equal(hunkTexts(merged[2])[0], DEP_CAPTION);
  assert.equal(merged[3].file.newPath, 'lib/a.js');
});

test('foldDepItems keeps package.json hunks for whitespace-only edits', () => {
  const json = pkgJson({ lodash: '^4.17.21' });
  const items = [dummyItem('package.json')];
  const folded = foldDepItems(
    items,
    sidesOf({
      'package.json': { oldText: json, newText: json },
    }),
  );
  assert.equal(folded.length, 1);
  assert.equal(folded[0].dep, undefined);
});

test('foldDepItems keeps keywords and scripts as normal hunks', () => {
  const deps = { lodash: '^4.17.21' };
  const items = [dummyItem('package.json')];
  const folded = foldDepItems(
    items,
    sidesOf({
      'package.json': {
        oldText: pkgJson(deps, { keywords: ['cli'] }),
        newText: pkgJson(deps, { keywords: ['tui'] }),
      },
    }),
  );
  assert.equal(folded.length, 1);
  assert.equal(folded[0].dep, undefined);
});

test('foldDepItems reviews dependencies apart from other fields', () => {
  const oldDeps = { lodash: '^4.17.20' };
  const newDeps = { lodash: '^4.17.21' };
  const keywordItem = dummyHunkItem('package.json', [
    { type: 'ctx', text: '  "keywords": [' },
    { type: 'del', text: '    "cli"' },
    { type: 'add', text: '    "tui"' },
    { type: 'ctx', text: '  ],' },
  ]);
  const depItem = dummyHunkItem('package.json', [
    { type: 'ctx', text: '  "dependencies": {' },
    { type: 'del', text: '    "lodash": "^4.17.20"' },
    { type: 'add', text: '    "lodash": "^4.17.21"' },
    { type: 'ctx', text: '  }' },
  ]);
  const items = [
    dummyItem('lib/a.js'),
    keywordItem,
    depItem,
    dummyItem('package-lock.json'),
    dummyItem('lib/b.js'),
  ];
  const folded = foldDepItems(
    items,
    sidesOf({
      'package.json': {
        oldText: pkgJson(oldDeps, { keywords: ['cli'] }),
        newText: pkgJson(newDeps, { keywords: ['tui'] }),
      },
      'package-lock.json': {
        oldText: lockV3(oldDeps, { lodash: '4.17.20' }),
        newText: lockV3(newDeps, { lodash: '4.17.21' }),
      },
    }),
  );
  assert.equal(folded.length, 4);
  assert.equal(folded[0].file.newPath, 'lib/a.js');
  assert.equal(folded[1].dep, undefined);
  assert.equal(folded[1].file.newPath, 'package.json');
  const kept = hunkTexts(folded[1]);
  assert.ok(kept.some((line) => line.includes('tui')));
  assert.ok(!kept.some((line) => line.includes('lodash')));
  assert.ok(folded[2].dep);
  assert.equal(folded[2].dep.change.name, 'lodash');
  assert.equal(hunkTexts(folded[2])[0], DEP_CAPTION);
  assert.equal(folded[3].file.newPath, 'lib/b.js');
});

test('foldDepItems keeps description in a shared package.json hunk', () => {
  const oldDeps = { lodash: '^4.17.20' };
  const newDeps = { lodash: '^4.17.21' };
  const noNl = false;
  const lines = [
    { type: 'ctx', text: '  "name": "demo",', noNl, blockId: null },
    { type: 'del', text: '  "description": "old",', noNl, blockId: 0 },
    { type: 'add', text: '  "description": "new",', noNl, blockId: 0 },
    { type: 'ctx', text: '  "dependencies": {', noNl, blockId: null },
    { type: 'del', text: '    "lodash": "^4.17.20"', noNl, blockId: 1 },
    { type: 'add', text: '    "lodash": "^4.17.21"', noNl, blockId: 1 },
    { type: 'ctx', text: '  }', noNl, blockId: null },
  ];
  const parts = splitHunkItems('package.json', lines);
  const descItem = parts[0];
  const depHunk = parts[1];
  const items = [descItem, depHunk, dummyItem('package-lock.json')];
  const folded = foldDepItems(
    items,
    sidesOf({
      'package.json': {
        oldText: pkgJson(oldDeps, { description: 'old' }),
        newText: pkgJson(newDeps, { description: 'new' }),
      },
      'package-lock.json': {
        oldText: lockV3(oldDeps, { lodash: '4.17.20' }),
        newText: lockV3(newDeps, { lodash: '4.17.21' }),
      },
    }),
  );
  assert.equal(folded.length, 2);
  assert.equal(folded[0].dep, undefined);
  assert.equal(folded[0].blockId, 0);
  const kept = hunkTexts(folded[0]);
  assert.ok(kept.some((line) => line.includes('description')));
  assert.ok(folded[1].dep);
  assert.equal(folded[1].dep.change.name, 'lodash');
});

test('foldDepItems hides mid-section dep hunks next to other fields', () => {
  const oldDeps = { eslint: '^9.0.0', prettier: '^3.9.7' };
  const newDeps = { eslint: '^9.0.0', prettier: '^3.9.8' };
  const versionItem = dummyHunkItem('package.json', [
    { type: 'ctx', text: '  "name": "demo",' },
    { type: 'del', text: '  "version": "0.1.8",' },
    { type: 'add', text: '  "version": "0.1.9",' },
    { type: 'ctx', text: '  "description": "x",' },
  ]);
  const depItem = dummyHunkItem('package.json', [
    { type: 'ctx', text: '    "eslint": "^9.0.0",' },
    { type: 'del', text: '    "prettier": "^3.9.7"' },
    { type: 'add', text: '    "prettier": "^3.9.8"' },
    { type: 'ctx', text: '  }' },
  ]);
  const items = [versionItem, depItem, dummyItem('package-lock.json')];
  const folded = foldDepItems(
    items,
    sidesOf({
      'package.json': {
        oldText: pkgJson(oldDeps, { version: '0.1.8' }),
        newText: pkgJson(newDeps, { version: '0.1.9' }),
      },
      'package-lock.json': {
        oldText: lockV3(oldDeps, { eslint: '9.0.0', prettier: '3.9.7' }),
        newText: lockV3(newDeps, { eslint: '9.0.0', prettier: '3.9.8' }),
      },
    }),
  );
  const depItems = folded.filter((item) => item.dep);
  const jsonItems = folded.filter(
    (item) => !item.dep && item.file.newPath === 'package.json',
  );
  assert.equal(depItems.length, 1);
  assert.equal(depItems[0].dep.change.name, 'prettier');
  assert.equal(jsonItems.length, 1);
  assert.equal(folded[0], jsonItems[0]);
  assert.equal(folded[1], depItems[0]);
  const kept = hunkTexts(jsonItems[0]);
  assert.ok(kept.some((line) => line.includes('version')));
  assert.ok(!kept.some((line) => line.includes('prettier')));
});

test('foldDepItems strips dep lines from a leftover mixed hunk', () => {
  const oldDeps = { eslint: '^9.0.0', prettier: '^3.9.7' };
  const newDeps = { eslint: '^9.0.0', prettier: '^3.9.8' };
  const noNl = false;
  const lines = [
    { type: 'ctx', text: '  "name": "demo",', noNl, blockId: null },
    { type: 'del', text: '  "version": "0.1.8",', noNl, blockId: 0 },
    { type: 'add', text: '  "version": "0.1.9",', noNl, blockId: 0 },
    { type: 'ctx', text: '    "eslint": "^9.0.0",', noNl, blockId: null },
    { type: 'del', text: '    "prettier": "^3.9.7"', noNl, blockId: 1 },
    { type: 'add', text: '    "prettier": "^3.9.8"', noNl, blockId: 1 },
    { type: 'ctx', text: '  }', noNl, blockId: null },
  ];
  const parts = splitHunkItems('package.json', lines);
  const items = [...parts, dummyItem('package-lock.json')];
  const folded = foldDepItems(
    items,
    sidesOf({
      'package.json': {
        oldText: pkgJson(oldDeps, { version: '0.1.8' }),
        newText: pkgJson(newDeps, { version: '0.1.9' }),
      },
      'package-lock.json': {
        oldText: lockV3(oldDeps, { eslint: '9.0.0', prettier: '3.9.7' }),
        newText: lockV3(newDeps, { eslint: '9.0.0', prettier: '3.9.8' }),
      },
    }),
  );
  const depItems = folded.filter((item) => item.dep);
  const jsonItems = folded.filter(
    (item) => !item.dep && item.file.newPath === 'package.json',
  );
  assert.equal(depItems.length, 1);
  assert.equal(depItems[0].dep.change.name, 'prettier');
  assert.equal(jsonItems.length, 1);
  assert.equal(folded[0], jsonItems[0]);
  assert.equal(folded[1], depItems[0]);
  const kept = hunkTexts(jsonItems[0]);
  assert.ok(kept.some((line) => line.includes('version')));
  assert.ok(!kept.some((line) => line.includes('prettier')));
});

test('foldDepItems hides lockfile-only noise', () => {
  const deps = { lodash: '^4.17.21' };
  const items = [dummyItem('keep.js'), dummyItem('package-lock.json')];
  const folded = foldDepItems(
    items,
    sidesOf({
      'package.json': {
        oldText: pkgJson(deps),
        newText: pkgJson(deps),
      },
      'package-lock.json': {
        oldText: lockV3(deps, { lodash: '4.17.20' }),
        newText: lockV3(deps, { lodash: '4.17.21' }),
      },
    }),
  );
  assert.equal(folded.length, 2);
  assert.equal(folded[1].file.newPath, 'package.json');
  assert.ok(folded[1].dep);
  assert.deepEqual(folded[1].dep.files, ['package-lock.json']);
  assert.equal(folded[1].dep.change.section, 'resolved');
  assert.equal(folded[1].dep.change.name, 'lodash');
  const lockLines = hunkTexts(folded[1]);
  assert.equal(lockLines[0], DEP_CAPTION);
  assertBlankAfter(lockLines, 'lockfile resolved version changed');
});

test('foldDepItems drops empty lockfile updated screens', () => {
  const deps = { lodash: '^4.17.21' };
  const lock = lockV3(deps, { lodash: '4.17.21' });
  const items = [dummyItem('keep.js'), dummyItem('package-lock.json')];
  const folded = foldDepItems(
    items,
    sidesOf({
      'package.json': { oldText: pkgJson(deps), newText: pkgJson(deps) },
      'package-lock.json': { oldText: lock, newText: lock },
    }),
  );
  assert.equal(folded.length, 1);
  assert.equal(folded[0].file.newPath, 'keep.js');
  assert.equal(folded[0].dep, undefined);
});

test('foldDepItems pairs nested package.json with its lockfile', () => {
  const oldDeps = { lodash: '^4.0.0' };
  const newDeps = { lodash: '^5.0.0' };
  const items = [
    dummyItem('packages/app/package.json'),
    dummyItem('packages/app/package-lock.json'),
  ];
  const folded = foldDepItems(
    items,
    sidesOf({
      'packages/app/package.json': {
        oldText: pkgJson(oldDeps),
        newText: pkgJson(newDeps),
      },
      'packages/app/package-lock.json': {
        oldText: lockV3(oldDeps, { lodash: '4.0.0' }),
        newText: lockV3(newDeps, { lodash: '5.0.0' }),
      },
    }),
  );
  assert.equal(folded.length, 1);
  assert.equal(folded[0].file.newPath, 'packages/app/package.json');
  assert.equal(folded[0].dep.files.length, 2);
  assert.equal(hunkTexts(folded[0])[0], DEP_CAPTION);
});

test('foldDepItems unifies PR hunks without file contents', () => {
  const patch = `diff --git a/package.json b/package.json
index 1111111..2222222 100644
--- a/package.json
+++ b/package.json
@@ -1,6 +1,6 @@
 {
   "name": "demo",
   "dependencies": {
-    "lodash": "^4.17.20"
+    "lodash": "^4.17.21"
   }
 }
diff --git a/package-lock.json b/package-lock.json
index 1111111..2222222 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,8 +1,8 @@
 {
   "lockfileVersion": 3,
   "packages": {
     "node_modules/lodash": {
-      "version": "4.17.20"
+      "version": "4.17.21"
     }
   }
 }
`;
  const files = parseDiff(patch);
  const items = itemsFromFiles(files, 'pr');
  assert.ok(items.length > 1);
  const folded = foldDepItems(items);
  assert.equal(folded.length, 1);
  assert.ok(folded[0].dep);
  assert.deepEqual(folded[0].dep.files, ['package.json', 'package-lock.json']);
  const lines = hunkTexts(folded[0]);
  assert.equal(lines[0], DEP_CAPTION);
  assert.ok(lines.includes('dependency version changed'));
  assert.ok(!lines.some((line) => line.includes('node_modules')));
});

test('load folds local dependency files into one review item', () => {
  const repo = makeRepo();
  try {
    const oldDeps = { lodash: '^4.17.20' };
    const newDeps = { lodash: '^4.17.21' };
    repo.write('keep.js', 'ok\n');
    repo.write('package.json', pkgJson(oldDeps));
    repo.write('package-lock.json', lockV3(oldDeps, { lodash: '4.17.20' }));
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    repo.write('package.json', pkgJson(newDeps));
    repo.write('package-lock.json', lockV3(newDeps, { lodash: '4.17.21' }));
    const loaded = load(repo.dir);
    const depItems = loaded.items.filter((item) => item.dep);
    assert.equal(depItems.length, 1);
    assert.equal(depItems[0].origin, 'unstaged');
    assert.deepEqual(depItems[0].dep.files, [
      'package.json',
      'package-lock.json',
    ]);
  } finally {
    repo.cleanup();
  }
});

test('load marks an added dependency that is not imported', () => {
  const repo = makeRepo();
  try {
    const oldDeps = { lodash: '^4.17.20' };
    const newDeps = { lodash: '^4.17.20', leftpad: '1.0.0' };
    const newVers = { lodash: '4.17.20', leftpad: '1.0.0' };
    repo.write('app.js', 'const _ = require("lodash");\n');
    repo.write('package.json', pkgLib(oldDeps));
    repo.write('package-lock.json', lockV3(oldDeps, { lodash: '4.17.20' }));
    repo.write('node_modules/leftpad/package.json', libPkg('leftpad'));
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    repo.write('package.json', pkgLib(newDeps));
    repo.write('package-lock.json', lockV3(newDeps, newVers));
    const loaded = load(repo.dir);
    const leftpad = depByName(loaded.items, 'leftpad');
    assert.ok(leftpad);
    assert.equal(leftpad.dep.change.unused, true);
    assert.equal(leftpad.dep.change.propose, true);
    const lines = hunkTexts(leftpad);
    assertBlankAfter(lines, 'npm uninstall: dependency unused');
    const entry = '"leftpad": "1.0.0"';
    const gone = leftpad.hunk.lines.find((line) => line.text === entry);
    assert.equal(gone.type, 'del');
  } finally {
    repo.cleanup();
  }
});

test('load proposes an unused dependency with no package diffs', () => {
  const repo = makeRepo();
  try {
    const deps = { lodash: '^4.17.20', leftpad: '1.0.0' };
    repo.write('app.js', 'const _ = require("lodash");\n');
    repo.write('package.json', pkgLib(deps));
    repo.write(
      'package-lock.json',
      lockV3(deps, {
        lodash: '4.17.20',
        leftpad: '1.0.0',
      }),
    );
    repo.write('node_modules/leftpad/package.json', libPkg('leftpad'));
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    const loaded = load(repo.dir, [], {
      audit: true,
      outdatedMap: null,
      auditMap: null,
    });
    const item = depByName(loaded.items, 'leftpad');
    assert.ok(item);
    assert.equal(item.dep.change.propose, true);
    assert.equal(item.dep.change.unused, true);
    assertBlankAfter(hunkTexts(item), 'npm uninstall: dependency unused');
  } finally {
    repo.cleanup();
  }
});

test('deferred load shows unused deps after extras', async () => {
  const repo = makeRepo();
  try {
    const deps = { lodash: '^4.17.20', leftpad: '1.0.0' };
    repo.write('app.js', 'const _ = require("lodash");\n');
    repo.write('package.json', pkgLib(deps));
    repo.write(
      'package-lock.json',
      lockV3(deps, {
        lodash: '4.17.20',
        leftpad: '1.0.0',
      }),
    );
    repo.write('node_modules/leftpad/package.json', libPkg('leftpad'));
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    const loaded = load(repo.dir, [], { audit: true, deferExtras: true });
    assert.equal(depByName(loaded.items, 'leftpad'), null);
    assert.equal(loaded.pending, true);
    const extra = await loadExtras(loaded, {
      audit: true,
      outdatedMap: null,
      auditMap: null,
    });
    const item = depByName(extra.items, 'leftpad');
    assert.ok(item);
    assert.equal(item.dep.change.unused, true);
  } finally {
    repo.cleanup();
  }
});

test('load does not propose unused for a dep with no exports', () => {
  const repo = makeRepo();
  try {
    const deps = { lodash: '^4.17.20', metaskills: '^1.0.5' };
    repo.write('app.js', 'const _ = require("lodash");\n');
    repo.write('package.json', pkgLib(deps));
    repo.write(
      'package-lock.json',
      lockV3(deps, {
        lodash: '4.17.20',
        metaskills: '1.0.5',
      }),
    );
    repo.write(
      'node_modules/metaskills/package.json',
      noExportPkg('metaskills'),
    );
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    const loaded = load(repo.dir, [], {
      audit: true,
      outdatedMap: null,
      auditMap: null,
    });
    assert.equal(depByName(loaded.items, 'metaskills'), null);
  } finally {
    repo.cleanup();
  }
});

test('load proposes an outdated dependency with no package diffs', () => {
  const repo = makeRepo();
  try {
    repo.write('package.json', pkgJson({ lodash: '^4.17.20' }));
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    const outdated = new Map();
    outdated.set('lodash', {
      current: '4.17.20',
      wanted: '4.17.21',
      latest: '4.17.21',
      type: 'dependencies',
    });
    const loaded = load(repo.dir, [], {
      audit: true,
      outdatedMap: outdated,
      auditMap: null,
    });
    const lodash = depByName(loaded.items, 'lodash');
    assert.ok(lodash);
    assert.equal(lodash.dep.change.propose, true);
    assert.equal(lodash.dep.change.to, '^4.17.21');
    const lines = hunkTexts(lodash);
    assert.ok(lines.includes('npm outdated: dependency version changed'));
    assert.ok(!lines.some((line) => line.startsWith('npm outdated  ')));
  } finally {
    repo.cleanup();
  }
});

test('add on a proposed update writes package.json and runs npm i', () => {
  const repo = makeRepo();
  try {
    const oldDeps = { lodash: '^4.17.20' };
    repo.write('package.json', pkgJson(oldDeps));
    repo.write('package-lock.json', lockV3(oldDeps, { lodash: '4.17.20' }));
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    const outdated = new Map();
    outdated.set('lodash', {
      current: '4.17.20',
      wanted: '4.17.21',
      latest: '4.17.21',
      type: 'dependencies',
    });
    const loaded = load(repo.dir, [], {
      audit: true,
      outdatedMap: outdated,
      auditMap: null,
    });
    const item = depByName(loaded.items, 'lodash');
    assert.ok(item);
    let installed = '';
    item.dep.install = (cwd) => {
      installed = cwd;
      const next = { lodash: '^4.17.21' };
      repo.write('package-lock.json', lockV3(next, { lodash: '4.17.21' }));
      return { status: 0 };
    };
    addItem(loaded.top, item);
    assert.equal(realpathSync.native(installed), realpathSync.native(repo.dir));
    const pkg = JSON.parse(repo.read('package.json'));
    assert.equal(pkg.dependencies.lodash, '^4.17.21');
    const lock = JSON.parse(repo.read('package-lock.json'));
    assert.equal(lock.packages['node_modules/lodash'].version, '4.17.21');
    const cached = repo.git(['diff', '--cached', '--name-only']);
    assert.match(cached, /package\.json/);
    assert.match(cached, /package-lock\.json/);
  } finally {
    repo.cleanup();
  }
});

test('add on an unused dependency runs npm uninstall', () => {
  const repo = makeRepo();
  try {
    const keep = { lodash: '^4.17.20' };
    const added = { lodash: '^4.17.20', leftpad: '1.0.0' };
    repo.write('app.js', 'const _ = require("lodash");\n');
    repo.write('package.json', pkgLib(keep));
    repo.write('package-lock.json', lockV3(keep, { lodash: '4.17.20' }));
    repo.write('node_modules/leftpad/package.json', libPkg('leftpad'));
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    repo.write('package.json', pkgLib(added));
    repo.write(
      'package-lock.json',
      lockV3(added, {
        lodash: '4.17.20',
        leftpad: '1.0.0',
      }),
    );
    const loaded = load(repo.dir);
    const item = depByName(loaded.items, 'leftpad');
    assert.ok(item);
    let removed = '';
    item.dep.install = (cwd) => {
      removed = cwd;
      repo.write('package.json', pkgJson(keep));
      repo.write('package-lock.json', lockV3(keep, { lodash: '4.17.20' }));
      return { status: 0 };
    };
    addItem(loaded.top, item);
    assert.equal(realpathSync.native(removed), realpathSync.native(repo.dir));
    const pkg = JSON.parse(repo.read('package.json'));
    assert.equal(pkg.dependencies.leftpad, undefined);
    const lock = JSON.parse(repo.read('package-lock.json'));
    assert.equal(lock.packages['node_modules/leftpad'], undefined);
  } finally {
    repo.cleanup();
  }
});

test('session add applies a proposed outdated update', () => {
  const repo = makeRepo();
  try {
    const oldDeps = { lodash: '^4.17.20' };
    repo.write('package.json', pkgJson(oldDeps));
    repo.write('package-lock.json', lockV3(oldDeps, { lodash: '4.17.20' }));
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    const outdated = new Map();
    outdated.set('lodash', {
      current: '4.17.20',
      wanted: '4.17.21',
      latest: '4.17.21',
      type: 'dependencies',
    });
    const stdout = sink();
    const session = new Session({
      repo: git.createGitRepo(),
      cwd: repo.dir,
      stdout,
      color: false,
      startPane: 'diff',
      audit: true,
      outdatedMap: outdated,
      auditMap: null,
    });
    session.load();
    const item = depByName(session.items, 'lodash');
    assert.ok(item);
    item.dep.install = () => {
      const next = { lodash: '^4.17.21' };
      repo.write('package-lock.json', lockV3(next, { lodash: '4.17.21' }));
      return { status: 0 };
    };
    session.dispatch('add');
    assert.equal(session.status, 'staged');
    const pkg = JSON.parse(repo.read('package.json'));
    assert.equal(pkg.dependencies.lodash, '^4.17.21');
    const staged = depByName(session.items, 'lodash');
    assert.ok(staged);
    assert.equal(staged.origin, 'staged');
    assert.equal(staged.dep.change.propose, undefined);
  } finally {
    repo.cleanup();
  }
});

test('session revert dismisses a proposed outdated update', () => {
  const repo = makeRepo();
  try {
    repo.write('package.json', pkgJson({ lodash: '^4.17.20' }));
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    const outdated = new Map();
    outdated.set('lodash', {
      current: '4.17.20',
      wanted: '4.17.21',
      latest: '4.17.21',
      type: 'dependencies',
    });
    const stdout = sink();
    const session = new Session({
      repo: git.createGitRepo(),
      cwd: repo.dir,
      stdout,
      color: false,
      startPane: 'diff',
      audit: true,
      outdatedMap: outdated,
      auditMap: null,
    });
    session.load();
    assert.ok(depByName(session.items, 'lodash'));
    session.dispatch('revert');
    assert.equal(repo.read('package.json'), pkgJson({ lodash: '^4.17.20' }));
    assert.equal(depByName(session.items, 'lodash'), null);
  } finally {
    repo.cleanup();
  }
});

const proposedLodash = (repo) => {
  const oldDeps = { lodash: '^4.17.20' };
  const extra = { description: 'keep me' };
  repo.write('package.json', pkgJson(oldDeps, extra));
  repo.write('package-lock.json', lockV3(oldDeps, { lodash: '4.17.20' }));
  repo.git(['add', '.']);
  repo.git(['commit', '-m', 'init']);
  repo.write('notes.txt', 'unrelated\n');
  const outdated = new Map();
  outdated.set('lodash', {
    current: '4.17.20',
    wanted: '4.17.21',
    latest: '4.17.21',
    type: 'dependencies',
  });
  const loaded = load(repo.dir, [], {
    audit: true,
    outdatedMap: outdated,
    auditMap: null,
  });
  const item = depByName(loaded.items, 'lodash');
  const pkg = repo.read('package.json');
  const lock = repo.read('package-lock.json');
  return { loaded, item, pkg, lock };
};

test('proposedNpmPlan does not write the manifest', () => {
  const repo = makeRepo();
  try {
    const { loaded, item, pkg } = proposedLodash(repo);
    const plan = proposedNpmPlan(loaded.top, item);
    assert.ok(plan);
    assert.deepEqual(plan.npmArgs, ['i']);
    assert.equal(plan.prepareManifest, true);
    assert.equal(repo.read('package.json'), pkg);
  } finally {
    repo.cleanup();
  }
});

test('nonzero npm result restores owned dependency files', () => {
  const repo = makeRepo();
  try {
    const { loaded, item, pkg, lock } = proposedLodash(repo);
    item.dep.install = () => ({ status: 1, stderr: 'npm ERR! boom' });
    assert.throws(() => addItem(loaded.top, item), /npm ERR! boom/);
    assert.equal(repo.read('package.json'), pkg);
    assert.equal(repo.read('package-lock.json'), lock);
    assert.equal(repo.read('notes.txt'), 'unrelated\n');
  } finally {
    repo.cleanup();
  }
});

test('thrown npm runner restores owned dependency files', () => {
  const repo = makeRepo();
  try {
    const { loaded, item, pkg, lock } = proposedLodash(repo);
    item.dep.install = () => {
      throw new Error('install boom');
    };
    assert.throws(() => addItem(loaded.top, item), /install boom/);
    assert.equal(repo.read('package.json'), pkg);
    assert.equal(repo.read('package-lock.json'), lock);
  } finally {
    repo.cleanup();
  }
});

test('rejected npm runner restores owned dependency files', async () => {
  const repo = makeRepo();
  try {
    const { loaded, item, pkg, lock } = proposedLodash(repo);
    item.dep.install = () => Promise.reject(new Error('install nope'));
    await assert.rejects(
      () => git.createGitRepo().addAsync(loaded.top, item),
      /install nope/,
    );
    assert.equal(repo.read('package.json'), pkg);
    assert.equal(repo.read('package-lock.json'), lock);
  } finally {
    repo.cleanup();
  }
});

test('timed out npm result restores owned dependency files', () => {
  const repo = makeRepo();
  try {
    const { loaded, item, pkg, lock } = proposedLodash(repo);
    const error = new Error('timed out');
    error.code = 'ETIMEDOUT';
    item.dep.install = () => ({ status: null, error });
    assert.throws(() => addItem(loaded.top, item), /timed out/);
    assert.equal(repo.read('package.json'), pkg);
    assert.equal(repo.read('package-lock.json'), lock);
  } finally {
    repo.cleanup();
  }
});

test('git staging failure restores owned dependency files', () => {
  const repo = makeRepo();
  try {
    const { loaded, item, pkg, lock } = proposedLodash(repo);
    assert.throws(
      () =>
        gitDeps.applyProposedUpdate(loaded.top, item, {
          run: () => {
            const next = { lodash: '^4.17.21' };
            repo.write(
              'package-lock.json',
              lockV3(next, { lodash: '4.17.21' }),
            );
            return { status: 0 };
          },
          stage: () => {
            throw new Error('add failed');
          },
        }),
      /add failed/,
    );
    assert.equal(repo.read('package.json'), pkg);
    assert.equal(repo.read('package-lock.json'), lock);
  } finally {
    repo.cleanup();
  }
});

test('captureFile distinguishes a missing file from an empty file', () => {
  const repo = makeRepo();
  try {
    const missing = gitDeps.captureFile(repo.dir, 'gone.txt');
    assert.equal(missing.existed, false);
    assert.equal(missing.text, '');
    repo.write('empty.txt', '');
    const empty = gitDeps.captureFile(repo.dir, 'empty.txt');
    assert.equal(empty.existed, true);
    assert.equal(empty.text, '');
    repo.write('empty.txt', 'changed\n');
    gitDeps.restoreFile(repo.dir, empty);
    assert.equal(repo.read('empty.txt'), '');
    repo.write('gone.txt', 'created\n');
    gitDeps.restoreFile(repo.dir, missing);
    assert.equal(repo.exists('gone.txt'), false);
  } finally {
    repo.cleanup();
  }
});

test('load keeps description and keywords as normal diffs', () => {
  const repo = makeRepo();
  try {
    const oldDeps = { lodash: '^4.17.20' };
    const newDeps = { lodash: '^4.17.21' };
    const oldExtra = { description: 'old', keywords: ['cli'] };
    const newExtra = { description: 'new', keywords: ['tui'] };
    repo.write('package.json', pkgJson(oldDeps, oldExtra));
    repo.write('package-lock.json', lockV3(oldDeps, { lodash: '4.17.20' }));
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    repo.write('package.json', pkgJson(newDeps, newExtra));
    repo.write('package-lock.json', lockV3(newDeps, { lodash: '4.17.21' }));
    const loaded = load(repo.dir);
    const depItems = loaded.items.filter((item) => item.dep);
    const jsonItems = [];
    for (const item of loaded.items) {
      if (item.dep) continue;
      if (item.file.newPath !== 'package.json') continue;
      jsonItems.push(item);
    }
    assert.equal(depItems.length, 1);
    assert.equal(depItems[0].dep.change.name, 'lodash');
    assert.ok(jsonItems.length >= 1);
    const texts = [];
    for (const item of jsonItems) {
      for (const line of hunkTexts(item)) texts.push(line);
    }
    assert.ok(texts.some((line) => line.includes('description')));
    const hasKeywords = texts.some((line) => line.includes('tui'));
    assert.ok(hasKeywords);
  } finally {
    repo.cleanup();
  }
});

test('load does not duplicate a dep hunk when other fields change', () => {
  const repo = makeRepo();
  try {
    const pad = {
      description: 'x'.repeat(80),
      keywords: ['cli'],
      license: 'MIT',
    };
    const oldDeps = { eslint: '^9.0.0', prettier: '^3.9.7' };
    const newDeps = { eslint: '^9.0.0', prettier: '^3.9.8' };
    const oldVers = { eslint: '9.0.0', prettier: '3.9.7' };
    const newVers = { eslint: '9.0.0', prettier: '3.9.8' };
    repo.write('package.json', pkgJson(oldDeps, { version: '0.1.8', ...pad }));
    repo.write('package-lock.json', lockV3(oldDeps, oldVers));
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    repo.write('package.json', pkgJson(newDeps, { version: '0.1.9', ...pad }));
    repo.write('package-lock.json', lockV3(newDeps, newVers));
    const loaded = load(repo.dir);
    const prettier = depByName(loaded.items, 'prettier');
    assert.ok(prettier);
    const jsonItems = loaded.items.filter((item) => {
      if (item.dep) return false;
      return item.file.newPath === 'package.json';
    });
    const pkgItems = loaded.items.filter(
      (item) => item.file.newPath === 'package.json',
    );
    assert.ok(pkgItems.length >= 2);
    assert.equal(pkgItems[0].dep, undefined);
    assert.equal(pkgItems.at(-1), prettier);
    const texts = [];
    for (const item of jsonItems) {
      for (const line of hunkTexts(item)) texts.push(line);
    }
    assert.ok(texts.some((line) => line.includes('version')));
    assert.ok(!texts.some((line) => line.includes('prettier')));
  } finally {
    repo.cleanup();
  }
});

test('add unstage and revert apply to both dependency files', () => {
  const repo = makeRepo();
  try {
    const oldDeps = { lodash: '^4.17.20' };
    const newDeps = { lodash: '^4.17.21' };
    repo.write('package.json', pkgJson(oldDeps));
    repo.write('package-lock.json', lockV3(oldDeps, { lodash: '4.17.20' }));
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    repo.write('package.json', pkgJson(newDeps));
    repo.write('package-lock.json', lockV3(newDeps, { lodash: '4.17.21' }));
    const loaded = load(repo.dir);
    const item = loaded.items[0];
    assert.ok(item.dep);
    addItem(loaded.top, item);
    const cached = repo.git(['diff', '--cached', '--name-only']);
    assert.match(cached, /package\.json/);
    assert.match(cached, /package-lock\.json/);
    assert.equal(repo.git(['diff', '--name-only']), '');
    item.origin = 'staged';
    unstageItem(loaded.top, item);
    assert.equal(repo.git(['diff', '--cached', '--name-only']), '');
    assert.match(repo.git(['diff', '--name-only']), /package\.json/);
    revertItem(loaded.top, item);
    assert.equal(repo.read('package.json'), pkgJson(oldDeps));
    assert.equal(
      repo.read('package-lock.json'),
      lockV3(oldDeps, { lodash: '4.17.20' }),
    );
  } finally {
    repo.cleanup();
  }
});

test('add applies one dependency and leaves the other unstaged', () => {
  const repo = makeRepo();
  try {
    const oldDeps = { lodash: '^4.17.20' };
    const newDeps = { lodash: '^4.17.21', leftpad: '1.0.0' };
    const newVers = { lodash: '4.17.21', leftpad: '1.0.0' };
    repo.write('package.json', pkgJson(oldDeps));
    repo.write('package-lock.json', lockV3(oldDeps, { lodash: '4.17.20' }));
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    repo.write('package.json', pkgJson(newDeps));
    repo.write('package-lock.json', lockV3(newDeps, newVers));
    const loaded = load(repo.dir);
    const lodash = depByName(loaded.items, 'lodash');
    const leftpad = depByName(loaded.items, 'leftpad');
    assert.ok(lodash);
    assert.ok(leftpad);
    addItem(loaded.top, lodash);
    const indexPkg = parseGitJson(repo, ':package.json');
    assert.equal(indexPkg.dependencies.lodash, '^4.17.21');
    assert.equal(indexPkg.dependencies.leftpad, undefined);
    const workPkg = JSON.parse(repo.read('package.json'));
    assert.equal(workPkg.dependencies.lodash, '^4.17.21');
    assert.equal(workPkg.dependencies.leftpad, '1.0.0');
    const indexLock = parseGitJson(repo, ':package-lock.json');
    const indexPkgs = indexLock.packages;
    assert.equal(indexPkgs['node_modules/lodash'].version, '4.17.21');
    assert.equal(indexPkgs['node_modules/leftpad'], undefined);
    const workLock = JSON.parse(repo.read('package-lock.json'));
    assert.equal(workLock.packages['node_modules/leftpad'].version, '1.0.0');
  } finally {
    repo.cleanup();
  }
});

test('revert applies one dependency and leaves the other', () => {
  const repo = makeRepo();
  try {
    const oldDeps = { lodash: '^4.17.20' };
    const newDeps = { lodash: '^4.17.21', leftpad: '1.0.0' };
    const newVers = { lodash: '4.17.21', leftpad: '1.0.0' };
    repo.write('package.json', pkgJson(oldDeps));
    repo.write('package-lock.json', lockV3(oldDeps, { lodash: '4.17.20' }));
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    repo.write('package.json', pkgJson(newDeps));
    repo.write('package-lock.json', lockV3(newDeps, newVers));
    const loaded = load(repo.dir);
    const lodash = depByName(loaded.items, 'lodash');
    revertItem(loaded.top, lodash);
    const workPkg = JSON.parse(repo.read('package.json'));
    assert.equal(workPkg.dependencies.lodash, '^4.17.20');
    assert.equal(workPkg.dependencies.leftpad, '1.0.0');
    const workLock = JSON.parse(repo.read('package-lock.json'));
    const workPkgs = workLock.packages;
    assert.equal(workPkgs['node_modules/lodash'].version, '4.17.20');
    assert.equal(workPkgs['node_modules/leftpad'].version, '1.0.0');
    assert.equal(workPkgs[''].dependencies.lodash, '^4.17.20');
    assert.equal(workPkgs[''].dependencies.leftpad, '1.0.0');
  } finally {
    repo.cleanup();
  }
});

test('session a u r act on one dependency', () => {
  const repo = makeRepo();
  try {
    const oldDeps = { lodash: '^4.17.20' };
    const newDeps = { lodash: '^4.17.21' };
    repo.write('package.json', pkgJson(oldDeps));
    repo.write('package-lock.json', lockV3(oldDeps, { lodash: '4.17.20' }));
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    repo.write('package.json', pkgJson(newDeps));
    repo.write('package-lock.json', lockV3(newDeps, { lodash: '4.17.21' }));
    const session = sessionFor(repo.dir);
    assert.equal(session.items.length, 1);
    assert.ok(session.items[0].dep);
    session.dispatch('add');
    assert.equal(session.status, 'staged');
    const cached = repo.git(['diff', '--cached', '--name-only']);
    assert.match(cached, /package\.json/);
    session.dispatch('unstage');
    assert.equal(session.status, 'unstaged');
    assert.equal(repo.git(['diff', '--cached']), '');
    session.dispatch('revert');
    assert.equal(repo.read('package.json'), pkgJson(oldDeps));
    assert.equal(
      repo.read('package-lock.json'),
      lockV3(oldDeps, { lodash: '4.17.20' }),
    );
  } finally {
    repo.cleanup();
  }
});

test('session add stages only the current dependency', () => {
  const repo = makeRepo();
  try {
    const oldDeps = { lodash: '^4.17.20' };
    const newDeps = { lodash: '^4.17.21', leftpad: '1.0.0' };
    const newVers = { lodash: '4.17.21', leftpad: '1.0.0' };
    repo.write('package.json', pkgJson(oldDeps));
    repo.write('package-lock.json', lockV3(oldDeps, { lodash: '4.17.20' }));
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    repo.write('package.json', pkgJson(newDeps));
    repo.write('package-lock.json', lockV3(newDeps, newVers));
    const session = sessionFor(repo.dir);
    assert.equal(session.items.length, 2);
    assert.equal(session.items[0].dep.change.name, 'leftpad');
    session.dispatch('add');
    assert.equal(session.status, 'staged');
    const indexPkg = parseGitJson(repo, ':package.json');
    assert.equal(indexPkg.dependencies.leftpad, '1.0.0');
    assert.equal(indexPkg.dependencies.lodash, '^4.17.20');
    assert.equal(session.items[1].origin, 'unstaged');
    const workPkg = JSON.parse(repo.read('package.json'));
    assert.equal(workPkg.dependencies.lodash, '^4.17.21');
  } finally {
    repo.cleanup();
  }
});

test('files pane revert restores both dependency files', () => {
  const repo = makeRepo();
  try {
    const oldDeps = { lodash: '^4.17.20' };
    const newDeps = { lodash: '^4.17.21' };
    repo.write('keep.js', 'ok\n');
    repo.write('package.json', pkgJson(oldDeps));
    repo.write('package-lock.json', lockV3(oldDeps, { lodash: '4.17.20' }));
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'init']);
    repo.write('keep.js', 'OK\n');
    repo.write('package.json', pkgJson(newDeps));
    repo.write('package-lock.json', lockV3(newDeps, { lodash: '4.17.21' }));
    const session = sessionFor(repo.dir);
    session.showFiles();
    const files = session.fileList();
    const dep = files.find((entry) => entry.path === 'package.json');
    assert.ok(dep);
    session.fileCursor = files.indexOf(dep);
    session.dispatch('revert');
    assert.equal(repo.read('package.json'), pkgJson(oldDeps));
    assert.equal(
      repo.read('package-lock.json'),
      lockV3(oldDeps, { lodash: '4.17.20' }),
    );
    assert.equal(repo.read('keep.js'), 'OK\n');
  } finally {
    repo.cleanup();
  }
});

test('render shows a readable dependency summary', () => {
  const oldDeps = { lodash: '^4.17.20' };
  const newDeps = { lodash: '^4.17.21' };
  const items = [dummyItem('package.json'), dummyItem('package-lock.json')];
  const folded = foldDepItems(
    items,
    sidesOf({
      'package.json': {
        oldText: pkgJson(oldDeps),
        newText: pkgJson(newDeps),
      },
      'package-lock.json': {
        oldText: lockV3(oldDeps, { lodash: '4.17.20' }),
        newText: lockV3(newDeps, { lodash: '4.17.21' }),
      },
    }),
  );
  const item = folded[0];
  const frame = render.renderFrame(
    {
      item,
      index: 0,
      total: 1,
      scroll: 0,
      status: '',
      counts: { staged: 0, unstaged: 1, untracked: 0 },
    },
    { width: 80, height: 16, color: false },
  );
  const text = stripAnsi(frame.text);
  assert.match(text, /Dependencies in package\.json & package-lock\.json/);
  assert.match(text, /dependency version changed/);
  assert.match(text, /lodash/);
  assert.doesNotMatch(text, /node_modules/);
});

test('render paints npm audit notes grey with separators', () => {
  const first =
    'brace-expansion: DoS via exponential-time expansion of ' +
    'consecutive non-expanding groups';
  const second = 'brace-expansion: DoS via unbounded expansion length';
  const audit = new Map();
  audit.set('brace-expansion', {
    severity: 'high',
    title: first,
    titles: [first, second],
    range: '<=1.1.17',
  });
  const pkg = pkgJson({ eslint: '^9.39.5' });
  const lock = lockV3(
    { eslint: '^9.39.5' },
    { eslint: '9.39.5', 'brace-expansion': '1.1.15' },
  );
  const proposed = proposeDepItems(pkg, null, audit, { lockText: lock });
  const item = proposed[0];
  const frame = render.renderFrame(
    {
      item,
      index: 0,
      total: 1,
      scroll: 0,
      status: '',
      counts: { staged: 0, unstaged: 1, untracked: 0 },
    },
    { width: 42, height: 24, color: true },
  );
  const text = stripAnsi(frame.text);
  assert.match(text, /lockfile vulnerable/);
  assert.match(text, /exponential-time/);
  assert.match(text, /unbounded expansion/);
  assert.doesNotMatch(text, /brace-expansion: brace-expansion:/);
  assert.match(text, /─/);
  const red = bg(THEME.delLineBg);
  const grey = bg(THEME.noteBg);
  const heading = frame.rows.some((row) => {
    if (!row.includes(red)) return false;
    return stripAnsi(row).includes('lockfile vulnerable');
  });
  const note = frame.rows.some((row) => {
    if (!row.includes(grey)) return false;
    return stripAnsi(row).includes('npm audit');
  });
  assert.ok(heading);
  assert.ok(note);
});

test('lockPackageCount ignores the root package entry', () => {
  const lock = {
    packages: {
      '': { dependencies: { lodash: '^4.17.21' } },
      'node_modules/lodash': { version: '4.17.21' },
    },
  };
  assert.equal(lockPackageCount(lock), 1);
});

const dependencyStagingRepo = (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const before = { lodash: '^4.17.20' };
  const after = { lodash: '^4.17.21', leftpad: '1.0.0' };
  repo.write('package.json', pkgJson(before));
  repo.write('package-lock.json', lockV3(before, { lodash: '4.17.20' }));
  repo.git(['add', '.']);
  repo.git(['commit', '-m', 'init']);
  repo.write('package.json', pkgJson(after));
  const versions = { lodash: '4.17.21', leftpad: '1.0.0' };
  repo.write('package-lock.json', lockV3(after, versions));
  for (const rel of ['package.json', 'package-lock.json']) {
    fs.utimesSync(path.join(repo.dir, rel), 1, 1);
  }
  return repo;
};

const dependencyFiles = (repo) =>
  ['package.json', 'package-lock.json'].map((rel) => {
    const file = path.join(repo.dir, rel);
    const { mtimeMs, mode, ino } = fs.statSync(file);
    return { text: repo.read(rel), mtimeMs, mode, ino };
  });

test('partial dependency staging leaves worktree files untouched', (t) => {
  const repo = dependencyStagingRepo(t);
  const before = dependencyFiles(repo);
  const item = depByName(load(repo.dir).items, 'lodash');
  addItem(repo.dir, item);
  assert.deepEqual(dependencyFiles(repo), before);
  const staged = load(repo.dir).items.find(
    (entry) => entry.origin === 'staged' && entry.dep?.change.name === 'lodash',
  );
  unstageItem(repo.dir, staged);
  assert.deepEqual(dependencyFiles(repo), before);
  assert.equal(repo.git(['diff', '--cached']), '');
});

test('failed dependency staging preserves worktree and index', (t) => {
  const repo = dependencyStagingRepo(t);
  const before = dependencyFiles(repo);
  const item = depByName(load(repo.dir).items, 'lodash');
  repo.write('.git/index.lock', 'locked');
  assert.throws(() => addItem(repo.dir, item), /index.lock/);
  assert.deepEqual(dependencyFiles(repo), before);
  assert.equal(repo.git(['diff', '--cached']), '');
});

test('partial staging adds new dependency files to an empty index', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  repo.write('package.json', pkgJson({ lodash: '^4.17.21' }));
  const before = repo.read('package.json');
  const item = depByName(load(repo.dir).items, 'lodash');
  assert.ok(item);
  addItem(repo.dir, item);
  assert.equal(repo.read('package.json'), before);
  const indexed = parseGitJson(repo, ':package.json');
  assert.equal(indexed.dependencies.lodash, '^4.17.21');
});

test('dependency staging respects clean filters without editing files', (t) => {
  const repo = dependencyStagingRepo(t);
  const filter = path.join(repo.dir, 'clean.cjs');
  const script = `
    const fs = require('node:fs');
    const text = fs.readFileSync(0, 'utf8');
    process.stdout.write(text.replace('demo', 'clean'));
  `;
  repo.write('clean.cjs', script);
  const command = [process.execPath, filter]
    .map((value) => JSON.stringify(value))
    .join(' ');
  repo.git(['config', 'filter.dependency.clean', command]);
  repo.write('.gitattributes', 'package.json filter=dependency\n');
  const before = dependencyFiles(repo);
  const item = depByName(load(repo.dir).items, 'lodash');
  addItem(repo.dir, item);
  assert.equal(parseGitJson(repo, ':package.json').name, 'clean');
  assert.deepEqual(dependencyFiles(repo), before);
});
