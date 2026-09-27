#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { spawnSync } = childProcess;

const utilities = require('../lib/utilities.js');
const { IS_WIN, spawnBase } = utilities;

const root = path.resolve(__dirname, '..');
const binSrc = path.join(root, 'bin', 'reslop.js');
const home = os.homedir();
const destDir = process.env.RESLOP_BIN_DIR
  ? path.resolve(process.env.RESLOP_BIN_DIR)
  : path.join(home, '.local', 'bin');
const destName = IS_WIN ? 'reslop.cmd' : 'reslop';
const dest = path.join(destDir, destName);

const MARK_BEGIN = '# >>> reslop >>>';
const MARK_END = '# <<< reslop <<<';

const shellBlock = `${MARK_BEGIN}
export PATH="$HOME/.local/bin:$PATH"
${MARK_END}
`;

const stripMarkedBlock = (text) => {
  if (!text.includes(MARK_BEGIN)) return text;
  return text.replace(
    new RegExp(`${MARK_BEGIN}[\\s\\S]*?${MARK_END}\\n?`, 'm'),
    '',
  );
};

const readTextOrEmpty = (filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
};

const upsertShellConfig = (filePath) => {
  let text = readTextOrEmpty(filePath);
  text = stripMarkedBlock(text);
  if (text.length && !text.endsWith('\n')) text += '\n';
  text += `\n${shellBlock}`;
  fs.writeFileSync(filePath, text);
  console.log(`reslop: updated ${filePath}`);
};

const removeMarkedBlock = (filePath) => {
  if (!fs.existsSync(filePath)) return;
  try {
    let text = fs.readFileSync(filePath, 'utf8');
    if (!text.includes(MARK_BEGIN)) return;
    text = stripMarkedBlock(text);
    fs.writeFileSync(filePath, text);
    console.log(`reslop: cleaned old block from ${filePath}`);
  } catch (error) {
    console.log(`reslop: skip ${filePath} (${error.message})`);
  }
};

const installBin = () => {
  try {
    fs.chmodSync(binSrc, 0o755);
  } catch {
    // Windows
  }
  fs.mkdirSync(destDir, { recursive: true });

  try {
    fs.lstatSync(dest);
    fs.unlinkSync(dest);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (IS_WIN) {
    const quoted = `"${binSrc.replaceAll('"', '')}"`;
    const wrapper = `@echo off\r\nnode ${quoted} %*\r\n`;
    fs.writeFileSync(dest, wrapper);
    console.log(`reslop: installed ${dest}`);
    return;
  }

  try {
    fs.symlinkSync(binSrc, dest);
    console.log(`reslop: linked ${dest} → ${binSrc}`);
  } catch (error) {
    try {
      fs.unlinkSync(dest);
    } catch {
      // ignore missing dest
    }
    const wrapper = `#!/usr/bin/env bash
exec node ${JSON.stringify(binSrc)} "$@"
`;
    try {
      fs.writeFileSync(dest, wrapper, { mode: 0o755, flag: 'wx' });
      console.log(`reslop: installed wrapper ${dest}`);
      console.log(`(symlink failed: ${error.message}; used wrapper instead)`);
    } catch (writeError) {
      console.error(
        `reslop: could not install bin at ${dest}: ${writeError.message}`,
      );
      process.exit(1);
    }
  }
};

installBin();

if (!IS_WIN) {
  const bashrcd = path.join(home, '.bashrc.d');
  const dropIn = path.join(bashrcd, 'reslop.sh');
  try {
    if (fs.existsSync(bashrcd) || fs.existsSync(path.join(home, '.bashrc'))) {
      fs.mkdirSync(bashrcd, { recursive: true });
      fs.writeFileSync(dropIn, shellBlock, { mode: 0o644 });
      console.log(`reslop: wrote ${dropIn}`);
      removeMarkedBlock(path.join(home, '.bashrc'));
    }
  } catch (error) {
    console.log(`reslop: skip shell drop-in (${error.message})`);
  }

  try {
    const envDir = path.join(home, '.config', 'environment.d');
    fs.mkdirSync(envDir, { recursive: true });
    const envFile = path.join(envDir, 'reslop.conf');
    fs.writeFileSync(envFile, `PATH=${destDir}:$PATH\n`);
    console.log(`reslop: wrote ${envFile}`);
  } catch (error) {
    console.log(`reslop: skip environment.d (${error.message})`);
  }

  for (const rc of [path.join(home, '.zshrc'), path.join(home, '.profile')]) {
    if (!fs.existsSync(rc)) continue;
    try {
      upsertShellConfig(rc);
    } catch (error) {
      console.log(`reslop: skip ${rc} (${error.message})`);
    }
  }
}

const check = spawnSync(
  dest,
  [],
  spawnBase({ encoding: 'utf8', shell: IS_WIN }),
);
if (check.error) {
  console.error('reslop: enable finished but binary failed to run:');
  console.error(check.error.message);
  process.exit(1);
}

const ready = IS_WIN
  ? [
      '',
      'Ready. Add this directory to PATH if needed:',
      '',
      `  ${destDir}`,
      '',
      'Then run reslop from any git repository.',
      '',
    ]
  : [
      '',
      'Ready. Apply in this terminal:',
      '',
      '  source ~/.bashrc.d/reslop.sh',
      '',
      'Then run reslop from any git repository.',
      '',
    ];
console.log(ready.join('\n'));
