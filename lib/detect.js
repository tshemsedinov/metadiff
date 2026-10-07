'use strict';

const path = require('node:path');
const { fileExt } = require('metautil');

const { mapLang } = require('./highlight.js');

const PROSE_BASENAMES = [
  'license',
  'licence',
  'copying',
  'authors',
  'notice',
  'copyright',
];

const isProse = (base) => {
  const stem = base.replace(/\.(txt|text|md|markdown)$/, '');
  return PROSE_BASENAMES.includes(stem);
};

const detectLang = (filePath) => {
  const base = path.basename(filePath || '').toLowerCase();
  if (base.endsWith('.d.ts')) return 'dts';
  if (isProse(base)) return 'md';
  if (base.endsWith('.log')) return 'log';
  if (base.startsWith('.') || !base.includes('.')) return 'dot';
  const ext = fileExt(base);
  return ext ? mapLang(ext) : 'dot';
};

module.exports = { detectLang };
