'use strict';

const path = require('node:path');
const metautil = require('metautil');
const { fileExt } = metautil;

const highlight = require('./highlight.js');
const { mapLang } = highlight;

const PROSE_BASENAMES = [
  'license',
  'licence',
  'copying',
  'authors',
  'notice',
  'copyright',
];

const isProseBasename = (base) => {
  const name = (base || '').toLowerCase();
  if (PROSE_BASENAMES.includes(name)) return true;
  const stem = name.replace(/\.(txt|text|md|markdown)$/i, '');
  return PROSE_BASENAMES.includes(stem);
};

const LANG_RULES = [
  { test: (base) => base.endsWith('.d.ts'), lang: 'dts' },
  { test: isProseBasename, lang: 'md' },
  { test: (base) => base.endsWith('.log'), lang: 'log' },
  { test: (base) => base.startsWith('.'), lang: 'dot' },
  { test: (base) => !base.includes('.'), lang: 'dot' },
];

const detectLang = (filePath) => {
  const base = path.basename(filePath || '').toLowerCase();
  for (const rule of LANG_RULES) {
    if (rule.test(base)) return rule.lang;
  }
  const ext = fileExt(base);
  if (ext) return mapLang(ext);
  return 'dot';
};

module.exports = { mapLang, detectLang };
