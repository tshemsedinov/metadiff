#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const paths = require('./install-paths.js');
const { MARK_BEGIN, home, dest, stripMarkedBlock } = paths;

try {
  fs.lstatSync(dest);
  fs.unlinkSync(dest);
  console.log(`reslop: removed ${dest}`);
} catch (error) {
  console.log(`reslop: could not remove bin (${error.message})`);
}

const generated = [
  path.join(home, '.bashrc.d', 'reslop.sh'),
  path.join(home, '.config', 'environment.d', 'reslop.conf'),
];

for (const file of generated) {
  if (!fs.existsSync(file)) continue;
  fs.unlinkSync(file);
  console.log(`reslop: removed ${file}`);
}

const profiles = ['.bashrc', '.zshrc', '.profile'];

for (const name of profiles) {
  const filePath = path.join(home, name);
  if (!fs.existsSync(filePath)) continue;
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    if (!text.includes(MARK_BEGIN)) continue;
    fs.writeFileSync(filePath, stripMarkedBlock(text));
    console.log(`reslop: cleaned ${filePath}`);
  } catch (error) {
    console.log(`reslop: skip ${filePath} (${error.message})`);
  }
}
