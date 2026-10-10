'use strict';

const fs = require('node:fs');

const file = process.argv[process.argv.length - 1];
const msg = process.env.RESLOP_REWORD_FILE;
if (!file || !msg) process.exit(1);
const rows = fs.readFileSync(file, 'utf8').split('\n');
const at = rows.findIndex((row) => /^(pick|p)\s+/.test(row));
const amend = `exec git commit --amend --only -F ${JSON.stringify(msg)}`;
if (at >= 0) rows.splice(at + 1, 0, amend);
fs.writeFileSync(file, rows.join('\n'));
