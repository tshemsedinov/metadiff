'use strict';

const core = require('./highlight/core.js');
const { tokensText, words } = core;

const PLUGIN_NAMES = words('bash css csv dart dot html js json log txt');

const HIGHLIGHTERS = Object.create(null);
const LANG = Object.create(null);

for (const name of PLUGIN_NAMES) {
  const plugin = require(`./highlight/${name}.js`);
  for (const id of plugin.langs) {
    HIGHLIGHTERS[id] = plugin.highlight;
    LANG[id] = id;
  }
  Object.assign(LANG, plugin.aliases);
}

const mapLang = (name) => {
  if (!name) return 'txt';
  return LANG[name.toLowerCase()] || 'txt';
};

const tokenize = (lang, source) => {
  const key = mapLang(lang);
  return HIGHLIGHTERS[key](source ?? '', key);
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
    const n = Math.min(tokenText.length - tokenOff, spanText.length - spanOff);
    if (n > 0) {
      const style = typeof token.style === 'string' && token.style;
      pieces.push({
        text: tokenText.slice(tokenOff, tokenOff + n),
        style: style || 'plain',
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
  for (; spanIndex < diff.length; spanIndex++) {
    const span = diff[spanIndex];
    const text = (span.text ?? '').slice(spanOff);
    if (text) {
      pieces.push({ text, style: 'plain', changed: span.changed === true });
    }
    spanOff = 0;
  }
  return pieces;
};

module.exports = { tokensText, tokenize, overlayTokens, mapLang };
