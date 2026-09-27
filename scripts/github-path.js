#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const file = process.env.GITHUB_PATH;
if (!file) {
  console.error('reslop: GITHUB_PATH is not set');
  process.exit(1);
}

const home = os.homedir();
const destDir = process.env.RESLOP_BIN_DIR
  ? path.resolve(process.env.RESLOP_BIN_DIR)
  : path.join(home, '.local', 'bin');

fs.appendFileSync(file, `${destDir}${os.EOL}`);
