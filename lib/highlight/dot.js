'use strict';

const core = require('./core.js');
const { emit } = core;

const highlightDotLine = (line) => {
  if (!line) return [];
  const out = [];
  const t = line.trimStart();
  if (t.startsWith('#') || t.startsWith(';')) {
    emit(out, 'comment', line);
    return out;
  }
  if (t.startsWith('!')) {
    const lead = line.slice(0, line.length - t.length);
    emit(out, 'plain', lead);
    emit(out, 'operator', '!');
    emit(out, 'plain', t.slice(1));
    return out;
  }
  const eq = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_.-]*)(\s*=\s*)(.*)$/);
  if (eq) {
    emit(out, 'plain', eq[1]);
    emit(out, 'variable', eq[2]);
    emit(out, 'operator', eq[3]);
    emit(out, 'string', eq[4]);
    return out;
  }
  emit(out, 'plain', line);
  return out;
};

const highlight = (source) => {
  const lines = source.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (i) emit(out, 'plain', '\n');
    for (const t of highlightDotLine(lines[i])) out.push(t);
  }
  return out;
};

module.exports = {
  langs: ['dot'],
  aliases: {
    env: 'dot',
    ini: 'dot',
    conf: 'dot',
    cfg: 'dot',
    yaml: 'dot',
    yml: 'dot',
    toml: 'dot',
  },
  highlight,
};
