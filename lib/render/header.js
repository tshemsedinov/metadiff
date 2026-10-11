'use strict';

const ansi = require('../term/ansi.js');
const files = require('../common/files.js');
const primitives = require('./primitives.js');
const { isTaskView, paintPathText } = primitives;
const { itemPath, REPO_TASKS_LABEL, isTasksEntry } = files;
const { THEME, visibleWidth } = ansi;
const { truncateVisible, fg, RESET, EL, seq } = ansi;
const { activeHit, spansFor } = require('../common/find.js');

const LOGO = '👁️';

const HEADER_LEAD = ` ${LOGO}  reslop: `;

const HEADER_ROLE_FG = {
  chrome: THEME.headerChromeFg,
  repo: THEME.headerRepoFg,
  dir: THEME.headerDirFg,
  slash: THEME.headerSlashFg,
  file: THEME.headerFileFg,
};

const selectedFile = (view) => (view.files ?? [])[view.fileCursor ?? 0];

const selectedBranch = (view) => (view.branches ?? [])[view.branchCursor ?? 0];

const selectedCommit = (view) => (view.commits ?? [])[view.commitCursor ?? 0];

const piecesText = (pieces) => pieces.map((piece) => piece.text).join('');

const pathSegments = (rel) => {
  const segs = [];
  if (!rel) return segs;
  const bits = rel.split('/');
  for (let i = 0; i < bits.length; i++) {
    if (i) segs.push({ text: '/', role: 'slash' });
    const role = i === bits.length - 1 ? 'file' : 'dir';
    if (bits[i]) segs.push({ text: bits[i], role });
  }
  return segs;
};

const headerScreen = (view) => {
  const { pane } = view;
  if (pane === 'agents') return view.agentView ? 'agents log' : 'agents';
  if (
    pane === 'dashboard' ||
    pane === 'repos' ||
    pane === 'branches' ||
    pane === 'npm' ||
    pane === 'packages' ||
    pane === 'tasks'
  ) {
    return pane;
  }
  if (pane === 'commits') {
    return view.commitView === 'full' ? 'commits full' : 'commits brief';
  }
  if (pane === 'files') {
    return isTasksEntry(selectedFile(view)) ? REPO_TASKS_LABEL : '';
  }
  return isTaskView(view) ? REPO_TASKS_LABEL : '';
};

const headerTarget = (view) => {
  if (view.pane === 'files') {
    const entry = selectedFile(view);
    if (!entry || isTasksEntry(entry)) return '';
    return entry.path;
  }
  if (view.pane === 'unit') return view.reviewPath ?? '';
  if (isTaskView(view)) return '';
  return itemPath(view.item);
};

const headerLead = (view) => {
  const screen = headerScreen(view);
  const label = screen || headerTarget(view);
  const repo = view.repoName || '';
  const pieces = [{ text: HEADER_LEAD, role: 'chrome' }];
  if (repo) {
    pieces.push({ text: repo, role: 'repo' });
    if (!label) pieces.push({ text: ' ', role: 'chrome' });
    else if (screen) pieces.push({ text: ': ', role: 'chrome' });
    else pieces.push({ text: '/', role: 'slash' });
  }
  return { pieces, label };
};

const headerText = (view) => {
  const { pieces, label } = headerLead(view);
  return `${piecesText(pieces)}${label}`;
};

const headerFind = (view, label, clipped) => {
  const query = view.find && view.find.query ? view.find.query : '';
  const target = headerTarget(view);
  if (!query || label !== target || !label) return [];
  const hit = activeHit(view.files ?? [], view.find);
  return spansFor(clipped, label, query, hit);
};

const paintHeaderRoles = (pieces) => {
  let out = `${seq(THEME.headerChromeFg, THEME.headerBg)}${EL}`;
  for (const piece of pieces) {
    out += `${fg(HEADER_ROLE_FG[piece.role])}${piece.text}`;
  }
  return out;
};

const paintHeaderHits = (clipped, spans, color) => {
  let out = '';
  let offset = 0;
  for (const seg of pathSegments(clipped)) {
    const local = [];
    const end = offset + seg.text.length;
    for (const span of spans) {
      const start = Math.max(span.start, offset);
      const stop = Math.min(span.end, end);
      if (start >= stop) continue;
      local.push({
        start: start - offset,
        end: stop - offset,
        on: span.on === true,
      });
    }
    const roleFg = HEADER_ROLE_FG[seg.role];
    out += paintPathText(seg.text, roleFg, THEME.headerBg, color, false, local);
    offset = end;
  }
  return out;
};

const paintHeader = (view, width, color) => {
  const { pieces, label } = headerLead(view);
  const right = ' ';
  const used = visibleWidth(piecesText(pieces)) + visibleWidth(right);
  const room = Math.max(0, width - used);
  const clipped = truncateVisible(label, room);
  const pad = ' '.repeat(Math.max(0, room - visibleWidth(clipped)));
  const spans = headerFind(view, label, clipped);
  if (!color || !spans.length) {
    pieces.push(...pathSegments(clipped));
    if (pad) pieces.push({ text: pad, role: 'chrome' });
    pieces.push({ text: right, role: 'chrome' });
    if (!color) return piecesText(pieces);
    return `${paintHeaderRoles(pieces)}${RESET}`;
  }
  let out = paintHeaderRoles(pieces);
  out += paintHeaderHits(clipped, spans, color);
  out += `${fg(HEADER_ROLE_FG.chrome)}${pad}${right}`;
  return `${out}${RESET}`;
};

module.exports = {
  selectedFile,
  selectedBranch,
  selectedCommit,
  headerText,
  paintHeader,
};
