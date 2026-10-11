'use strict';

const matchesIn = (text, query) => {
  const spans = [];
  if (!query || !text) return spans;
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  const step = needle.length;
  let from = 0;
  while (from <= hay.length - step) {
    const at = hay.indexOf(needle, from);
    if (at < 0) break;
    spans.push({ start: at, end: at + step });
    from = at + step;
  }
  return spans;
};

const fileMatches = (entries, query) => {
  const hits = [];
  if (!query) return hits;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const path = entry && entry.path ? entry.path : '';
    if (!path) continue;
    for (const span of matchesIn(path, query)) {
      hits.push({ index, path, start: span.start, end: span.end });
    }
  }
  return hits;
};

const activeHit = (entries, find) => {
  if (!find || !find.query) return null;
  const hits = fileMatches(entries, find.query);
  if (!hits.length) return null;
  const count = hits.length;
  let at = find.at % count;
  if (at < 0) at += count;
  return hits[at];
};

const keptPrefix = (shown, full) => {
  const mark = shown.endsWith('…') && shown !== full ? 1 : 0;
  const keep = shown.length - mark;
  if (!full.startsWith(shown.slice(0, keep))) return -1;
  return keep;
};

const spansFor = (shown, full, query, hit) => {
  const spans = matchesIn(shown, query);
  if (!hit || hit.path !== full) return spans;
  const keep = keptPrefix(shown, full);
  if (keep < 0 || hit.start >= keep) return spans;
  return spans.map((span) => ({
    ...span,
    on: span.start === hit.start,
  }));
};

module.exports = { fileMatches, activeHit, spansFor };
