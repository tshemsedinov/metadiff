'use strict';

const { THEME, paint } = require('../ansi.js');

const paintPathText = (text, fg, bg, color, bold, spans) => {
  if (!spans.length) return paint(text, fg, bg, color, bold);
  let out = '';
  let at = 0;
  for (const span of spans) {
    if (span.start > at) {
      out += paint(text.slice(at, span.start), fg, bg, color, bold);
    }
    const on = span.on === true;
    const markFg = on ? THEME.searchOnFg : THEME.searchFg;
    const markBg = on ? THEME.searchOnBg : THEME.searchBg;
    const slice = text.slice(span.start, span.end);
    out += paint(slice, markFg, markBg, color, true);
    at = span.end;
  }
  if (at < text.length) out += paint(text.slice(at), fg, bg, color, bold);
  return out;
};

module.exports = { paintPathText };
