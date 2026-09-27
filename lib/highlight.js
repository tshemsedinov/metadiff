'use strict';

const fs = require('node:fs');
const path = require('node:path');

const core = require('./highlight/core.js');
const { tokensText } = core;

const PLUGIN_DIR = path.join(__dirname, 'highlight');
const SKIP = ['core.js'];

const loadPlugins = () => {
  const names = fs
    .readdirSync(PLUGIN_DIR)
    .filter((name) => name.endsWith('.js') && !SKIP.includes(name));
  names.sort();
  return names.map((file) => require(path.join(PLUGIN_DIR, file)));
};

const indexPlugins = (plugins) => {
  const highlighters = Object.create(null);
  const lang = Object.create(null);
  for (const plugin of plugins) {
    for (const id of plugin.langs) {
      highlighters[id] = plugin.highlight;
      lang[id] = id;
    }
    const aliases = plugin.aliases ?? {};
    for (const name of Object.keys(aliases)) lang[name] = aliases[name];
  }
  return { highlighters, lang };
};

const PLUGINS = loadPlugins();
const registry = indexPlugins(PLUGINS);
const HIGHLIGHTERS = registry.highlighters;
const LANG = registry.lang;

const mapLang = (name) => {
  if (!name) return 'txt';
  return LANG[name.toLowerCase()] || 'txt';
};

const tokenize = (lang, source) => {
  const text = source ?? '';
  const key = mapLang(lang);
  const highlight = HIGHLIGHTERS[key] || HIGHLIGHTERS.txt;
  return highlight(text, key);
};

const overlayTokens = (tokens, spans) => {
  const syn = tokens?.length ? tokens : [{ text: '', style: 'plain' }];
  const diff = spans?.length ? spans : [{ text: tokensText(syn) }];
  const pieces = [];
  let tokenIndex = 0;
  let spanIndex = 0;
  let tokenOff = 0;
  let spanOff = 0;
  while (tokenIndex < syn.length && spanIndex < diff.length) {
    const token = syn[tokenIndex];
    const span = diff[spanIndex];
    const tokenText = token.text ?? '';
    const spanText = span.text ?? '';
    const tokenLeft = tokenText.length - tokenOff;
    const spanLeft = spanText.length - spanOff;
    const n = Math.min(tokenLeft, spanLeft);
    if (n > 0) {
      const name = typeof token.style === 'string' ? token.style : 'plain';
      pieces.push({
        text: tokenText.slice(tokenOff, tokenOff + n),
        style: name || 'plain',
        changed: span.changed === true,
      });
    }
    tokenOff += n;
    spanOff += n;
    if (tokenOff >= tokenText.length) {
      tokenIndex += 1;
      tokenOff = 0;
    }
    if (spanOff >= spanText.length) {
      spanIndex += 1;
      spanOff = 0;
    }
  }
  while (spanIndex < diff.length) {
    const span = diff[spanIndex];
    const text = (span.text ?? '').slice(spanOff);
    if (text) {
      pieces.push({ text, style: 'plain', changed: span.changed === true });
    }
    spanIndex += 1;
    spanOff = 0;
  }
  return pieces;
};

module.exports = {
  tokensText,
  tokenize,
  overlayTokens,
  mapLang,
};
