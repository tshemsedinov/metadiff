#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const utilities = require('../lib/utilities.js');
const { IS_WIN } = utilities;

const home = os.homedir();
const destDir = process.env.RESLOP_BIN_DIR
  ? path.resolve(process.env.RESLOP_BIN_DIR)
  : path.join(home, '.local', 'bin');
const destName = IS_WIN ? 'reslop.cmd' : 'reslop';
const dest = path.join(destDir, destName);

const MARK_BEGIN = '# >>> reslop >>>';
const MARK_END = '# <<< reslop <<<';

try {
  if (fs.existsSync(dest) || fs.lstatSync(dest).isSymbolicLink()) {
    fs.unlinkSync(dest);
    console.log(`reslop: removed ${dest}`);
  } else {
    console.log(`reslop: nothing to remove at ${dest}`);
  }
} catch (error) {
  console.log(`reslop: could not remove bin (${error.message})`);
}

const dropIn = path.join(home, '.bashrc.d', 'reslop.sh');
if (fs.existsSync(dropIn)) {
  fs.unlinkSync(dropIn);
  console.log(`reslop: removed ${dropIn}`);
}

const envFile = path.join(home, '.config', 'environment.d', 'reslop.conf');
if (fs.existsSync(envFile)) {
  fs.unlinkSync(envFile);
  console.log(`reslop: removed ${envFile}`);
}

const profiles = [
  path.join(home, '.bashrc'),
  path.join(home, '.zshrc'),
  path.join(home, '.profile'),
];

for (const filePath of profiles) {
  if (!fs.existsSync(filePath)) continue;
  try {
    let text = fs.readFileSync(filePath, 'utf8');
    if (!text.includes(MARK_BEGIN)) continue;
    const re = new RegExp(`${MARK_BEGIN}[\\s\\S]*?${MARK_END}\\n?`, 'm');
    text = text.replace(re, '');
    fs.writeFileSync(filePath, text);
    console.log(`reslop: cleaned ${filePath}`);
  } catch (error) {
    console.log(`reslop: skip ${filePath} (${error.message})`);
  }
}
