'use strict';

const core = require('./core.js');
const { words, emit, wordStyles, scanWhile, lineEnd } = core;

const SINGLE_QUOTES = `'\``;

const KEYWORDS = words(`
  if then else elif fi for while until do done case esac function select in
  time coproc
`);

const BUILTINS = words(`
  echo printf cd pwd exit export source alias unalias local declare typeset
  readonly unset shift read test true false exec eval set trap wait kill type
  command builtin return break continue pushd popd dirs getopts mapfile
  readarray let umask ulimit fg bg jobs hash help enable caller bind compgen
  complete
`);

const WORD_STYLE = wordStyles({ control: KEYWORDS, function: BUILTINS });

const varEnd = (source, i) => {
  if (source[i + 1] === '{') {
    const close = source.indexOf('}', i + 2);
    return close < 0 ? source.length : close + 1;
  }
  if (/[0-9#?$!*@-]/.test(source[i + 1] || '')) return i + 2;
  return scanWhile(source, i + 1, /[A-Za-z0-9_]/);
};

const pushDoubleQuoted = (out, source, i) => {
  const n = source.length;
  let chunk = '"';
  let j = i + 1;
  while (j < n && source[j] !== '"') {
    if (source[j] === '\\' && j + 1 < n) {
      chunk += source.slice(j, j + 2);
      j += 2;
    } else if (source[j] === '$') {
      emit(out, 'string', chunk);
      chunk = '';
      const end = varEnd(source, j);
      emit(out, 'variable', source.slice(j, end));
      j = end;
    } else {
      chunk += source[j];
      j += 1;
    }
  }
  if (j < n) {
    chunk += '"';
    j += 1;
  }
  emit(out, 'string', chunk);
  return j;
};

const highlight = (source) => {
  const out = [];
  let i = 0;
  const take = (style, end) => {
    emit(out, style, source.slice(i, end));
    i = end;
  };
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '#' && (i === 0 || /\s/.test(source[i - 1]))) {
      take('comment', lineEnd(source, i));
    } else if (SINGLE_QUOTES.includes(ch)) {
      const close = source.indexOf(ch, i + 1);
      take('string', close < 0 ? source.length : close + 1);
    } else if (ch === '"') {
      i = pushDoubleQuoted(out, source, i);
    } else if (ch === '$') {
      take('variable', varEnd(source, i));
    } else if (ch === '-' && /[A-Za-z0-9]/.test(next || '')) {
      take('attr', scanWhile(source, i + 1, /[A-Za-z0-9_-]/));
    } else if (/[A-Za-z_]/.test(ch)) {
      const end = scanWhile(source, i + 1, /[A-Za-z0-9_]/);
      const word = source.slice(i, end);
      const assign = source[end] === '=' ? 'variable' : 'plain';
      take(WORD_STYLE[word] || assign, end);
    } else if (/[0-9]/.test(ch)) {
      take('number', scanWhile(source, i + 1, /[0-9]/));
    } else if ('|&;<>(){}'.includes(ch)) {
      const doubled = '|&><'.includes(ch) && next === ch;
      take('operator', i + (doubled ? 2 : 1));
    } else {
      take('plain', i + 1);
    }
  }
  return out;
};

module.exports = {
  langs: ['bash'],
  aliases: { sh: 'bash', shell: 'bash', zsh: 'bash' },
  highlight,
};
