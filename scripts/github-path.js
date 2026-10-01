#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');

const paths = require('./install-paths.js');
const { destDir } = paths;

const file = process.env.GITHUB_PATH;
if (!file) {
  console.error('reslop: GITHUB_PATH is not set');
  process.exit(1);
}

fs.appendFileSync(file, `${destDir}${os.EOL}`);
