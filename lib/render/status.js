'use strict';

const ansi = require('../term/ansi.js');
const keys = require('../input/keys.js');
const files = require('../common/files.js');
const primitives = require('./primitives.js');
const { fill, branchLabel } = primitives;
const { npmStatus } = require('./dashboard/blocks.js');
const { menuBoxWidth, dropBox, menuFaces } = require('./menu.js');
const field = require('./field.js');
const { paintPlanFace, paintImportStatus, paintFindStatus } = field;
const { fileTotals } = files;
const { CONFIRM, confirmPrefix, promptFromChoices } = keys;
const { THEME, paint, visibleWidth } = ansi;
const { truncateVisible } = ansi;
const { paintMarkedWord, QUIT_MARK } = require('./footer.js');

const WAVE = '·•●•·';

const BUSY_BAR = Array.from(WAVE, (_, frame) => {
  const start = (WAVE.length - frame) % WAVE.length;
  return WAVE.slice(start) + WAVE.slice(0, start);
});

const BUSY_PROGRESS = [
  'pulling',
  'pushing',
  'loading',
  'importing',
  'checking npm',
  'updating reslop',
  'npm i',
  'npm uninstall',
  'npm audit fix',
  'running',
  'checking out',
  'creating branch',
  'rebasing',
  'dropping',
  'committing',
  'updating',
  'rewording',
  'force pushing',
];

const formatBusyStatus = (status, frame = 0) => {
  const kind = `${status ?? ''}`;
  if (!BUSY_PROGRESS.includes(kind)) return kind;
  const i = Math.abs(frame) % BUSY_BAR.length;
  return `${kind}  ${BUSY_BAR[i]}`;
};

const INFO_STATUS = [
  'copied',
  'staged',
  'unstaged',
  'not staged',
  'dropped',
  'already staged',
  'read only',
  'transitive',
  'nothing to review',
  'nothing to commit',
  'not installed',
  'no plan',
  'returned',
  'stopped',
  'started',
  'unified',
  'mixed',
  'side-by-side',
  'line numbers',
  'no line numbers',
  'dark',
  'light',
  'saved',
  'reloaded',
  'not a diff block',
  'file scope',
  'diff mode',
  'committed',
  'amended',
  'reworded',
  'fixup',
  'updated',
  'updating reslop',
  'loading',
  'importing',
  'imported',
  'checking npm',
  'npm i',
  'npm uninstall',
  'npm audit fix',
  'pulling',
  'pushing',
  'pulled',
  'pushed',
  'force pushing',
  'force pushed',
  'checking out',
  'creating branch',
  'rebasing',
  'dropping',
  'committing',
  'checked out',
  'created',
  'empty branch name',
  'empty commit message',
];

const INFO_PREFIX = [
  'checked out ',
  'created ',
  'rebased onto ',
  'dropped ',
  'exit ',
  'model ',
];

const STATUS_MARK = /(\+[0-9]+(?:\/[0-9]+)?|-[0-9]+(?:\/[0-9]+)?)/g;

const OLD_LOGS = /old logs \S+/;

const isInfoStatus = (status) =>
  INFO_STATUS.includes(status) ||
  INFO_PREFIX.some((prefix) => status.startsWith(prefix));

const joinStatus = (parts) => parts.filter(Boolean).join('  ');

const countsKind = (sourceKind, revShort) => {
  const remote = sourceKind === 'pr' || sourceKind === 'mr';
  if (remote || sourceKind === 'issue') return sourceKind;
  return revShort ? 'commit' : 'worktree';
};

const isWorktree = (view) =>
  countsKind(view.sourceKind, view.revShort) === 'worktree';

const notesLine = (counts) => {
  const done = counts.tasksDone ?? 0;
  const total = counts.tasks ?? 0;
  return `tasks ${done}/${total}`;
};

const PLAN_LEAD = 'Plan file: ';

const closedPlan = (view) => `${view.planName ?? ''}`;

const planLabel = (view) => {
  const closed = closedPlan(view);
  if (!closed) return '';
  const query = view.planOpen ? `${view.planQuery ?? ''}` : '';
  if (!query) return closed;
  const room = Math.max(visibleWidth(closed), visibleWidth(query));
  const shown = truncateVisible(query, room);
  const pad = Math.max(0, room - visibleWidth(shown));
  return `${shown}${' '.repeat(pad)}`;
};

const statusLead = (view) => {
  if (view.pane === 'repos') {
    const tiles = view.repos && view.repos.tiles ? view.repos.tiles : [];
    const count = tiles.length;
    if (!count) return 'repos';
    const at = (view.repos.cursor ?? 0) + 1;
    return `${at}/${count}`;
  }
  if (view.pane === 'agents') {
    if (view.agentView) return view.agentStatus || 'log';
    const list = view.agents ?? [];
    let found = 0;
    for (const row of list) {
      if (row.bin) found += 1;
    }
    return `${found}/${list.length}`;
  }
  const counts = view.counts ?? {};
  const kind = countsKind(view.sourceKind, view.revShort);
  if (kind === 'worktree') return branchLabel(view.branch);
  if (kind === 'commit') {
    return `commit ${view.revShort}  ${counts.commit ?? 0}`;
  }
  const label = view.sourceLabel || kind;
  return `${kind} ${label}  ${counts.pr ?? 0}`;
};

const STATUS_QUIET = new Set(['npm', 'packages', 'branches', 'agents']);

const planStatus = (view) => {
  const combo = planLabel(view);
  if (!combo) return '';
  return `${PLAN_LEAD}${combo}`;
};

const statusLeft = (view) => {
  if (view.pane === 'repos') return ` ${statusLead(view)}`;
  if (view.pane === 'tasks') {
    const lead = joinStatus([statusLead(view), planStatus(view)]);
    return ` ${lead}`;
  }
  const notes = STATUS_QUIET.has(view.pane) ? '' : notesLine(view.counts ?? {});
  return ` ${joinStatus([statusLead(view), notes])}`;
};

const planAt = (view, text) => {
  const combo = planLabel(view);
  if (!combo) return -1;
  const lead = statusLead(view);
  const head = lead ? ` ${lead}  ${PLAN_LEAD}` : ` ${PLAN_LEAD}`;
  const line = `${text ?? ''}`;
  if (!line.startsWith(head)) return -1;
  const rest = line.slice(head.length);
  if (rest.startsWith(combo) || combo.startsWith(rest)) return head.length;
  return -1;
};

const planFace = (view, text) => {
  const at = planAt(view, text);
  if (at < 0) return null;
  const combo = planLabel(view);
  const rest = text.slice(at);
  const face = rest.startsWith(combo) ? combo : rest;
  return { at, face, x: visibleWidth(text.slice(0, at)) };
};

const statusDelta = (total) => {
  const stagedAdd = total.stagedAdded ?? 0;
  const unstagedAdd = total.unstagedAdded ?? 0;
  const stagedDel = total.stagedRemoved ?? 0;
  const unstagedDel = total.unstagedRemoved ?? 0;
  const hasDelta =
    stagedAdd || unstagedAdd || stagedDel || unstagedDel || total.added;
  if (!hasDelta && !total.removed) return '';
  const plus = `+${stagedAdd}/${stagedAdd + unstagedAdd}`;
  const minus = `-${stagedDel}/${stagedDel + unstagedDel}`;
  return `${plus}  ${minus}`;
};

const DIFF_QUIET = new Set(['npm', 'packages', 'tasks', 'branches', 'agents']);

const statusStats = (view) => {
  if (view.pane === 'tasks') return notesLine(view.counts ?? {});
  const counts = view.counts ?? {};
  const staged = counts.staged ?? 0;
  const total = fileTotals(view.files ?? []);
  const hasGit =
    total.remaining || total.staged || total.added || total.removed;
  const n = hasGit ? total.staged : staged;
  const m = hasGit ? total.remaining : staged + (counts.unstaged ?? 0);
  const delta = DIFF_QUIET.has(view.pane) ? '' : statusDelta(total);
  const ratio = STATUS_QUIET.has(view.pane) ? '' : `${n}/${m}`;
  const packages = view.pane === 'packages' ? npmStatus(view.packages) : '';
  return joinStatus([view.npmLogs, delta, ratio, packages]);
};

const statusLayout = (view, status, width) => {
  const msg = formatBusyStatus(status, view.progressFrame ?? 0);
  const isError = msg && !isInfoStatus(status);
  const msgFg = isError ? THEME.errorFg : THEME.chromeFg;
  const stats = statusStats(view);
  const right = stats ? `${stats} ` : '';
  const rightW = visibleWidth(right);
  const msgW = visibleWidth(msg);
  const side = msg ? 1 : 0;
  const room = Math.max(0, width - rightW - msgW - side * 2);
  const clipped = truncateVisible(statusLeft(view), room);
  const leftW = visibleWidth(clipped);
  const extra = Math.max(0, width - leftW - rightW - msgW);
  const padLeft = msg ? Math.floor(extra / 2) : extra;
  const padRight = msg ? extra - padLeft : 0;
  return { clipped, msg, msgFg, right, padLeft, padRight };
};

const choiceHits = (choices, prefix, y) => {
  let x = visibleWidth(prefix);
  return choices.map((choice) => {
    const w = visibleWidth(`${choice.lead}${choice.label}`);
    const hit = { id: choice.letter, y, x0: x, x1: x + w };
    x += w;
    return hit;
  });
};

const paintChoicePrompt = (choices, width, color, prefix) => {
  const bgRgb = THEME.chromeBg;
  const body = `${prefix}${promptFromChoices(choices)}`;
  const pad = Math.max(0, width - visibleWidth(body));
  if (!color) return body + ' '.repeat(pad);
  let out = paint(prefix, THEME.mutedFg, bgRgb, color);
  for (const choice of choices) {
    const label = `${choice.lead}${choice.label}`;
    out += paintMarkedWord(label, choice.letter, color, QUIT_MARK);
  }
  return out + fill(pad, THEME.mutedFg, bgRgb, color);
};

const paintStatusLeft = (text, color) => {
  if (!color) return text;
  const bgRgb = THEME.chromeBg;
  const found = text.match(OLD_LOGS);
  if (found) {
    const token = found[0];
    const before = text.slice(0, found.index);
    const after = text.slice(found.index + token.length);
    return (
      paintStatusLeft(before, color) +
      paint(token, THEME.shaFg, bgRgb, color) +
      paintStatusLeft(after, color)
    );
  }
  let out = '';
  let last = 0;
  for (const match of text.matchAll(STATUS_MARK)) {
    const token = match[0];
    const tokenFg = token.startsWith('+') ? THEME.addLineFg : THEME.delLineFg;
    out += paint(text.slice(last, match.index), THEME.mutedFg, bgRgb, color);
    out += paint(token, tokenFg, bgRgb, color);
    last = match.index + token.length;
  }
  return out + paint(text.slice(last), THEME.mutedFg, bgRgb, color);
};

const paintBranchHead = (text, branch, color) => {
  const name = branchLabel(branch);
  if (!name || !text.startsWith(' ')) return null;
  const shown = text.startsWith(` ${name}`) ? name : text.slice(1);
  if (!shown || !name.startsWith(shown)) return null;
  const rest = text.slice(1 + shown.length);
  const bgRgb = THEME.chromeBg;
  return (
    paint(' ', THEME.mutedFg, bgRgb, color) +
    paint(shown, THEME.buttonHotFg, bgRgb, color, true) +
    paintStatusLeft(rest, color)
  );
};

const paintTasksLeft = (view, text, color) => {
  const place = planFace(view, text);
  if (!place) {
    const head = paintBranchHead(text, view.branch, color);
    return head ?? paintStatusLeft(text, color);
  }
  const before = text.slice(0, place.at);
  const after = text.slice(place.at + place.face.length);
  const searching = Boolean(view.planOpen && view.planQuery);
  const comboFg = searching ? THEME.searchFg : THEME.shaFg;
  const comboBg = searching ? THEME.searchBg : THEME.chromeBg;
  const branch = paintBranchHead(before, view.branch, color);
  const head = branch ?? paintStatusLeft(before, color);
  const face = paintPlanFace(view, place.face, comboFg, comboBg, color);
  return head + face + paintStatusLeft(after, color);
};

const statusHead = (view, clipped, color) => {
  if (view.pane === 'tasks') return paintTasksLeft(view, clipped, color);
  if (isWorktree(view)) return paintBranchHead(clipped, view.branch, color);
  return null;
};

const paintStatusLine = (view, status, width, color) => {
  if (view.import) return paintImportStatus(view, width, color);
  if (view.find) return paintFindStatus(view, width, color);
  const confirm = CONFIRM[view.mode];
  if (confirm) {
    const prefix = confirmPrefix(confirm, view);
    return paintChoicePrompt(confirm.choices, width, color, prefix);
  }
  const layout = statusLayout(view, status, width);
  const leftGap = ' '.repeat(layout.padLeft);
  const rightGap = ' '.repeat(layout.padRight);
  if (!color) {
    return layout.clipped + leftGap + layout.msg + rightGap + layout.right;
  }
  const bgRgb = THEME.chromeBg;
  const head = statusHead(view, layout.clipped, color);
  const left = head ?? paintStatusLeft(layout.clipped, color);
  return (
    left +
    paint(leftGap, THEME.mutedFg, bgRgb, color) +
    paint(layout.msg, layout.msgFg, bgRgb, color) +
    paint(rightGap, THEME.mutedFg, bgRgb, color) +
    paintStatusLeft(layout.right, color)
  );
};

const statusChoiceHits = (view, y) => {
  const spec = CONFIRM[view.mode];
  if (!spec) return [];
  return choiceHits(spec.choices, confirmPrefix(spec, view), y);
};

const statusPlanHit = (view, width, y) => {
  if (view.pane !== 'tasks' || view.find || view.import) return null;
  if (CONFIRM[view.mode]) return null;
  const layout = statusLayout(view, view.status ?? '', width);
  const place = planFace(view, layout.clipped);
  if (!place) return null;
  const x0 = place.x;
  return { id: 'plan', y, x0, x1: x0 + visibleWidth(place.face) };
};

const planMenu = (view, width, color, statusY) => {
  if (view.pane !== 'tasks' || !view.planOpen || statusY < 3) return null;
  const names = view.planNames ?? [];
  const layout = statusLayout(view, view.status ?? '', width);
  const place = planFace(view, layout.clipped);
  if (!place) return null;
  const x = Math.max(0, place.x - 1);
  const room = Math.max(1, statusY - 2);
  const box = dropBox(names, view.planCursor, view.planScroll, room);
  const boxW = menuBoxWidth(names, visibleWidth(place.face), width - x);
  const faces = menuFaces(names, box, boxW, color);
  const lines = [];
  const hits = [];
  for (let i = 0; i < faces.length; i++) {
    const y = statusY - box.inner + i;
    lines.push({ y, text: faces[i].face });
    if (names[faces[i].index] === undefined) continue;
    hits.push({
      id: 'plan-item',
      y,
      x0: x,
      x1: x + boxW,
      cursor: faces[i].index,
    });
  }
  return { x, lines, hits, scroll: box.start };
};

const statusBranchHit = (view, width, y) => {
  if (view.find || view.import || CONFIRM[view.mode]) return null;
  const name = branchLabel(view.branch);
  if (!name || !isWorktree(view)) return null;
  const layout = statusLayout(view, view.status ?? '', width);
  const at = layout.clipped.indexOf(name);
  if (at < 0) return null;
  return { id: 'branch', y, x0: at, x1: at + visibleWidth(name) };
};

module.exports = {
  formatBusyStatus,
  paintStatusLine,
  statusChoiceHits,
  statusBranchHit,
  statusPlanHit,
  planMenu,
};
