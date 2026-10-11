'use strict';

const { spawnSync } = require('node:child_process');

const { ESC } = require('./ansi.js');
const { spawnBase } = require('../common/process.js');

const CLIP_TIMEOUT_MS = 1000;

const COPY_TOOLS = {
  win32: [{ cmd: 'clip', args: [] }],
  darwin: [{ cmd: 'pbcopy', args: [] }],
  unix: [
    { cmd: 'wl-copy', args: [] },
    { cmd: 'xclip', args: ['-selection', 'clipboard'] },
    { cmd: 'xsel', args: ['--clipboard', '--input'] },
  ],
};

const PASTE_TOOLS = {
  win32: [
    { cmd: 'powershell', args: ['-NoProfile', '-Command', 'Get-Clipboard'] },
  ],
  darwin: [{ cmd: 'pbpaste', args: [] }],
  unix: [
    { cmd: 'wl-paste', args: ['--no-newline'] },
    { cmd: 'xclip', args: ['-selection', 'clipboard', '-o'] },
    { cmd: 'xsel', args: ['--clipboard', '--output'] },
  ],
};

let copied = '';

const platformTools = (tools) => tools[process.platform] ?? tools.unix;

const runTool = (tool, input) =>
  spawnSync(
    tool.cmd,
    tool.args,
    spawnBase({ input, encoding: 'utf8', timeout: CLIP_TIMEOUT_MS }),
  );

const osc52 = (text) => {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  return `${ESC}]52;c;${b64}\x07`;
};

const copyText = (text, stdout) => {
  if (!text) return false;
  copied = text;
  let ok = false;
  if (stdout && stdout.write) {
    stdout.write(osc52(text));
    ok = true;
  }
  for (const tool of platformTools(COPY_TOOLS)) {
    const result = runTool(tool, text);
    if (!result.error && result.status === 0) return true;
  }
  return ok;
};

const pasteText = () => {
  for (const tool of platformTools(PASTE_TOOLS)) {
    const result = runTool(tool);
    if (result.error || result.status !== 0) continue;
    if (result.stdout) return result.stdout;
  }
  return copied;
};

module.exports = { osc52, copyText, pasteText };
