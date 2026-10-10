'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { jsonParse } = require('metautil');
const utilities = require('../common/utilities.js');
const { readText } = utilities;
const { MANIFEST } = require('../common/files.js');

const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];

const readManifest = (root) => {
  const text = readText(path.join(root, MANIFEST));
  if (!text) return null;
  const pkg = jsonParse(text);
  if (!pkg || typeof pkg !== 'object') return null;
  return pkg;
};

const writeManifest = (root, pkg) => {
  const file = path.join(root, MANIFEST);
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
};

const scriptEntries = (pkg) => {
  const scripts = pkg.scripts;
  if (!scripts || typeof scripts !== 'object') return [];
  const entries = [];
  for (const name of Object.keys(scripts)) {
    const command = scripts[name];
    if (typeof command !== 'string') continue;
    entries.push({ name, command, kind: 'script' });
  }
  return entries;
};

const binNames = (pkg) => {
  if (!pkg || typeof pkg !== 'object') return [];
  const bin = pkg.bin;
  if (typeof bin === 'string' && bin) {
    const raw = `${pkg.name ?? ''}`;
    const base = raw.startsWith('@') ? raw.split('/')[1] : raw;
    return base ? [base] : [];
  }
  if (!bin || typeof bin !== 'object' || Array.isArray(bin)) return [];
  const isPath = (name) => typeof bin[name] === 'string' && bin[name] !== '';
  return Object.keys(bin).filter(isPath);
};

const declaredNames = (pkg) => {
  const names = [];
  for (const section of SECTIONS) {
    const map = pkg[section];
    if (!map || typeof map !== 'object') continue;
    names.push(...Object.keys(map));
  }
  return names;
};

const depManifest = (root, name) => {
  const parts = name.startsWith('@') ? name.split('/').slice(0, 2) : [name];
  return path.join(root, 'node_modules', ...parts, MANIFEST);
};

const binEntries = (root, pkg, taken) => {
  const entries = [];
  const seen = new Set(taken);
  for (const name of declaredNames(pkg)) {
    const dep = jsonParse(readText(depManifest(root, name)));
    for (const bin of binNames(dep)) {
      if (seen.has(bin)) continue;
      seen.add(bin);
      entries.push({ name: bin, command: bin, kind: 'bin', package: name });
    }
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  return entries;
};

const listCommands = (root) => {
  const pkg = readManifest(root);
  if (!pkg) return [];
  const scripts = scriptEntries(pkg);
  const taken = scripts.map((entry) => entry.name);
  return [...scripts, ...binEntries(root, pkg, taken)];
};

const orderedScripts = (pkg) => {
  const scripts = pkg.scripts;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) {
    return {};
  }
  return scripts;
};

const pickScripts = (scripts, names) => {
  const ordered = {};
  for (const key of names) ordered[key] = scripts[key];
  return ordered;
};

const upsertScript = (pkg, prev, next) => {
  const scripts = orderedScripts(pkg);
  const names = Object.keys(scripts);
  if (!prev || !names.includes(prev)) {
    pkg.scripts = { ...scripts, [next.name]: next.command };
    return;
  }
  const ordered = {};
  for (const key of names) {
    if (key === prev) ordered[next.name] = next.command;
    else if (key !== next.name) ordered[key] = scripts[key];
  }
  pkg.scripts = ordered;
};

const saveScript = (root, prev, next) => {
  const pkg = readManifest(root) ?? {};
  upsertScript(pkg, prev, next);
  writeManifest(root, pkg);
};

const removeScript = (root, name) => {
  const pkg = readManifest(root);
  if (!pkg) return false;
  const scripts = orderedScripts(pkg);
  if (!Object.hasOwn(scripts, name)) return false;
  const names = Object.keys(scripts).filter((key) => key !== name);
  pkg.scripts = pickScripts(scripts, names);
  writeManifest(root, pkg);
  return true;
};

const reorderScript = (root, name, delta) => {
  const pkg = readManifest(root);
  if (!pkg) return false;
  const scripts = orderedScripts(pkg);
  const names = Object.keys(scripts);
  const at = names.indexOf(name);
  const next = at + delta;
  if (at < 0 || next < 0 || next >= names.length) return false;
  names[at] = names[next];
  names[next] = name;
  pkg.scripts = pickScripts(scripts, names);
  writeManifest(root, pkg);
  return true;
};

module.exports = {
  listCommands,
  saveScript,
  removeScript,
  reorderScript,
};
