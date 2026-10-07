'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { detectLang } = require('../lib/detect.js');
const { tokenize, overlayTokens, tokensText } = require('../lib/highlight.js');

const stylesOf = (tokens, text) =>
  tokens.filter((t) => t.text === text).map((t) => t.style);

test('AC24 detectLang prefers .d.ts and dotfile rules', () => {
  assert.equal(detectLang('src/a.d.ts'), 'dts');
  assert.equal(detectLang('src/a.ts'), 'ts');
  assert.equal(detectLang('src/a.jsx'), 'jsx');
  assert.equal(detectLang('src/a.tsx'), 'tsx');
  assert.equal(detectLang('lib/main.dart'), 'dart');
  assert.equal(detectLang('.env'), 'dot');
});

test('highlight plugins export langs and highlight', () => {
  const dir = path.join(__dirname, '../lib/highlight');
  const names = fs.readdirSync(dir).filter((name) => {
    if (!name.endsWith('.js')) return false;
    return name !== 'core.js';
  });
  assert.ok(names.length > 0);
  for (const name of names) {
    const plugin = require(path.join(dir, name));
    assert.ok(Array.isArray(plugin.langs), name);
    assert.ok(plugin.langs.length, name);
    assert.equal(typeof plugin.highlight, 'function', name);
  }
});

test('AC24 js tokens for const assignment', () => {
  const tokens = tokenize('js', 'const x = 1;');
  assert.deepEqual(stylesOf(tokens, 'const'), ['storage']);
  assert.deepEqual(stylesOf(tokens, 'x'), ['variable']);
  assert.ok(stylesOf(tokens, '1').includes('number'));
  assert.equal(tokensText(tokens), 'const x = 1;');
});

test('AC24 overlay keeps syntax on changed pieces', () => {
  const tokens = tokenize('js', 'const x = 1;');
  const spans = [
    { text: 'const x = ', changed: false },
    { text: '1', changed: true },
    { text: ';', changed: false },
  ];
  const pieces = overlayTokens(tokens, spans);
  const one = pieces.find((p) => p.text === '1');
  assert.ok(one);
  assert.equal(one.style, 'number');
  assert.equal(one.changed, true);
  const cst = pieces.find((p) => p.text === 'const');
  assert.equal(cst.style, 'storage');
  assert.equal(cst.changed, false);
});

test('json property vs string', () => {
  const tokens = tokenize('json', '{"a":"b"}');
  assert.equal(stylesOf(tokens, '"a"')[0], 'property');
  assert.equal(stylesOf(tokens, '"b"')[0], 'string');
});

test('bash highlights echo as function', () => {
  const tokens = tokenize('bash', 'echo "hi"');
  assert.equal(stylesOf(tokens, 'echo')[0], 'function');
});

test('jsx highlights tags attrs and expressions', () => {
  const src = '<div className="card">{title}</div>';
  const tokens = tokenize('jsx', src);
  assert.equal(tokensText(tokens), src);
  assert.equal(stylesOf(tokens, 'div')[0], 'tag');
  assert.equal(stylesOf(tokens, 'className')[0], 'attr');
  assert.equal(stylesOf(tokens, '"card"')[0], 'string');
  assert.equal(stylesOf(tokens, 'title')[0], 'variable');
});

test('jsx keeps less-than as an operator', () => {
  const src = 'if (a < b) return a;';
  const tokens = tokenize('jsx', src);
  assert.equal(tokensText(tokens), src);
  assert.equal(stylesOf(tokens, '<')[0], 'operator');
});

test('tsx highlights components and keeps types', () => {
  const src = 'const n: number = 1;\nconst el = <Card title={n} />;';
  const tokens = tokenize('tsx', src);
  assert.equal(tokensText(tokens), src);
  assert.equal(stylesOf(tokens, 'number')[0], 'type');
  assert.equal(stylesOf(tokens, 'Card')[0], 'className');
  assert.equal(stylesOf(tokens, 'title')[0], 'attr');
});

test('tsx does not treat generics as jsx', () => {
  const src = 'useState<number>(0)';
  const tokens = tokenize('tsx', src);
  assert.equal(tokensText(tokens), src);
  assert.equal(stylesOf(tokens, 'number')[0], 'type');
  assert.equal(stylesOf(tokens, '<')[0], 'operator');
});

test('dart highlights keywords types and interpolation', () => {
  const interp = '$name';
  const src = `final n = 1;\nString hi = 'Hello ${interp}';`;
  const tokens = tokenize('dart', src);
  assert.equal(tokensText(tokens), src);
  assert.equal(stylesOf(tokens, 'final')[0], 'storage');
  assert.equal(stylesOf(tokens, 'n')[0], 'variable');
  assert.ok(stylesOf(tokens, '1').includes('number'));
  assert.equal(stylesOf(tokens, 'String')[0], 'className');
  assert.equal(stylesOf(tokens, '$name')[0], 'interpolation');
});

test('dart highlights class names comments and annotations', () => {
  const src = '@override\nclass Foo {}\n// note';
  const tokens = tokenize('dart', src);
  assert.equal(tokensText(tokens), src);
  assert.equal(stylesOf(tokens, '@override')[0], 'decorator');
  assert.equal(stylesOf(tokens, 'class')[0], 'storage');
  assert.equal(stylesOf(tokens, 'Foo')[0], 'className');
  assert.equal(stylesOf(tokens, '// note')[0], 'comment');
});

test('toString identifier does not crash tokenize', () => {
  const tokens = tokenize('js', 'foo.toString()');
  assert.equal(tokensText(tokens), 'foo.toString()');
  const name = tokens.find((t) => t.text === 'toString');
  assert.ok(name);
  const pieces = overlayTokens(tokens, [
    { text: 'foo.toString()', changed: false },
  ]);
  assert.equal(tokensText(pieces), 'foo.toString()');
});

test('js family reconstructs incomplete strings templates regexes', () => {
  const interp = ['$', '{'].join('');
  const cases = [
    ['js', 'const s = "oops'],
    ['js', `const t = \`a${interp}x}b`],
    ['js', `\`unclosed ${interp}a`],
    ['js', '/unclosed'],
    ['js', '@dec class Foo {}'],
    ['js', 'const re = /ab+c/i;'],
    ['js', 'a / b'],
    ['js', '// c\nconst x = 1;'],
    ['js', '/* c */ const x = 1;'],
    ['ts', '@Injectable() class Svc {}'],
    ['jsx', '<A><B>x</B></A>'],
    ['jsx', '<>frag</>'],
    ['tsx', 'const el = <A><B x={1}/></A>;'],
  ];
  for (const [lang, src] of cases) {
    const tokens = tokenize(lang, src);
    assert.equal(tokensText(tokens), src, `${lang}: ${src}`);
  }
});

test('js comments beat regex and regex beats division', () => {
  const line = tokenize('js', '// c\nconst x = 1;');
  assert.equal(stylesOf(line, '// c')[0], 'comment');
  const block = tokenize('js', '/* c */ const x = 1;');
  assert.equal(stylesOf(block, '/* c */')[0], 'comment');
  const re = tokenize('js', 'const re = /ab+c/i;');
  assert.equal(stylesOf(re, '/ab+c/i')[0], 'regex');
  const div = tokenize('js', 'a / b');
  assert.equal(stylesOf(div, '/')[0], 'operator');
  const ret = tokenize('js', 'return /x/;');
  assert.equal(stylesOf(ret, '/x/')[0], 'regex');
});

test('js decorators templates and nested jsx keep styles', () => {
  const interp = ['$', '{'].join('');
  const dec = tokenize('js', '@dec class Foo {}');
  assert.equal(stylesOf(dec, '@dec')[0], 'decorator');
  assert.equal(stylesOf(dec, 'Foo')[0], 'className');
  const tpl = tokenize('js', `const t = \`a${interp}x}b\`;`);
  assert.ok(stylesOf(tpl, '`').includes('template'));
  assert.ok(stylesOf(tpl, interp).includes('interpolation'));
  assert.equal(stylesOf(tpl, 'x')[0], 'variable');
  const nested = tokenize('jsx', '<A><B>x</B></A>');
  assert.deepEqual(stylesOf(nested, 'A'), ['className', 'className']);
  assert.deepEqual(stylesOf(nested, 'B'), ['className', 'className']);
  assert.equal(stylesOf(nested, 'x')[0], 'plain');
});
