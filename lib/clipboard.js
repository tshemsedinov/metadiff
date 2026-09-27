'use strict';

const childProcess = require('node:child_process');
const { spawnSync } = childProcess;

const ansi = require('./ansi.js');
const { ESC } = ansi;
const utilities = require('./utilities.js');
const { clipTools, spawnBase } = utilities;

const CLIP_TIMEOUT_MS = 1000;

const osc52 = (text) => {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  return `${ESC}]52;c;${b64}\x07`;
};

const runClip = (cmd, args, text) => {
  const result = spawnSync(
    cmd,
    args,
    spawnBase({
      input: text,
      encoding: 'utf8',
      timeout: CLIP_TIMEOUT_MS,
    }),
  );
  if (result.error) return false;
  return result.status === 0;
};

const copyText = (text, stdout) => {
  if (!text) return false;
  let ok = false;
  if (stdout && stdout.write) {
    stdout.write(osc52(text));
    ok = true;
  }
  for (const tool of clipTools()) {
    if (runClip(tool.cmd, tool.args, text)) return true;
  }
  return ok;
};

module.exports = { osc52, copyText };
