'use strict';

const os = require('node:os');
const path = require('node:path');

const { IS_WIN } = require('../lib/common/process.js');

const MARK_BEGIN = '# >>> reslop >>>';
const MARK_END = '# <<< reslop <<<';
const MARKED_BLOCK = new RegExp(`${MARK_BEGIN}[\\s\\S]*?${MARK_END}\\n?`, 'm');

const home = os.homedir();
const destDir = process.env.RESLOP_BIN_DIR
  ? path.resolve(process.env.RESLOP_BIN_DIR)
  : path.join(home, '.local', 'bin');
const dest = path.join(destDir, IS_WIN ? 'reslop.cmd' : 'reslop');

const stripMarkedBlock = (text) => text.replace(MARKED_BLOCK, '');

module.exports = {
  IS_WIN,
  MARK_BEGIN,
  MARK_END,
  home,
  destDir,
  dest,
  stripMarkedBlock,
};
