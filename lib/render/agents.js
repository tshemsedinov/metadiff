'use strict';

const ansi = require('../ansi.js');
const { THEME, paint, visibleWidth, trimVisible, seq, EL } = ansi;
const { stampVisible } = ansi;
const primitives = require('./primitives.js');
const { MARK_W, markPrefix, paintBodyFill } = primitives;
const { paintCursorList, paneResult } = primitives;
const { seg } = require('./tiles.js');
const table = require('./dash-table.js');
const { waiting, cell, flexCell, tableLines, titleAside } = table;
const { paintNpmLog } = require('./npm.js');

const TAIL = 2;
const HEAD_GAP = 1;
const NAME_MAX = 10;
const MODEL_MAX = 32;
const EFFORT_MAX = 10;
const FAST_MAX = 4;
const CONTEXT_MAX = 8;
const PLAN_MAX = 48;

const agentFields = (row) => {
  if (!row.bin) {
    return {
      name: row.name,
      model: row.model || '',
      effort: '',
      fast: '',
      context: '',
      plan: 'not installed',
      detail: '',
    };
  }
  const levels = row.efforts ?? [];
  const effort = levels.length ? row.effort || '' : '';
  return {
    name: row.name,
    model: row.model || '',
    effort,
    fast: row.fast || 'off',
    context: row.context || '',
    plan: row.plan || '',
    detail: '',
  };
};

const colWidth = (rows, pick, max) => {
  let width = 0;
  for (const row of rows) {
    width = Math.max(width, visibleWidth(pick(row)));
  }
  return Math.min(max, width);
};

const nameWidth = (rows, typed = '') => {
  const width = colWidth(rows, (row) => agentFields(row).name, NAME_MAX);
  return Math.max(width, Math.min(NAME_MAX, visibleWidth(typed)));
};

const modelWidth = (rows) => {
  let width = 0;
  for (const row of rows) {
    if (!row.bin) continue;
    const shown = visibleWidth(agentFields(row).model);
    const open = (row.modelChoices ?? []).length ? 4 : 0;
    const title = visibleWidth('model');
    width = Math.max(width, shown, open, title);
  }
  if (width) return Math.min(MODEL_MAX, width);
  for (const row of rows) {
    if (!agentFields(row).model) continue;
    return visibleWidth('model');
  }
  return 0;
};

const effortWidth = (rows) => {
  let width = 0;
  for (const row of rows) {
    if (!row.bin) continue;
    width = Math.max(width, visibleWidth(agentFields(row).effort));
    for (const level of row.efforts ?? []) {
      const label = `${level ?? ''}`.trim();
      if (!label || label === 'default') continue;
      width = Math.max(width, visibleWidth(label));
    }
  }
  return Math.min(EFFORT_MAX, width);
};

const fastWidth = (rows) => {
  for (const row of rows) {
    if (row.bin) return FAST_MAX;
  }
  return 0;
};

const contextWidth = (rows) => {
  let width = 0;
  for (const row of rows) {
    if (!row.bin) continue;
    const choices = row.contexts ?? [];
    if (!choices.length) continue;
    width = Math.max(width, visibleWidth('context'));
    width = Math.max(width, visibleWidth(agentFields(row).context));
    for (const size of choices) {
      width = Math.max(width, visibleWidth(`${size ?? ''}`));
    }
  }
  return Math.min(CONTEXT_MAX, width);
};

const planWidth = (rows) =>
  colWidth(rows, (row) => agentFields(row).plan, PLAN_MAX);

const columnSpans = (row, fields, cols, gap) => {
  const spans = [];
  if (!row.bin) return spans;
  let x = MARK_W + cols.nameW;
  if (cols.modelW) {
    x += gap.length;
    spans.push({ x0: x, x1: x + cols.modelW, field: 'model' });
    x += cols.modelW;
  }
  if (cols.effortW) {
    x += gap.length;
    spans.push({ x0: x, x1: x + cols.effortW, field: 'effort' });
    x += cols.effortW;
  }
  if (cols.fastW) {
    x += gap.length;
    spans.push({ x0: x, x1: x + cols.fastW, field: 'fast' });
    x += cols.fastW;
  }
  const sizes = row.contexts ?? [];
  if (cols.contextW && sizes.length) {
    x += gap.length;
    spans.push({ x0: x, x1: x + cols.contextW, field: 'context' });
    x += cols.contextW;
  } else if (cols.contextW) {
    x += gap.length + cols.contextW;
  }
  if (cols.planW && fields.plan) {
    x += gap.length;
    spans.push({ x0: x, x1: x + cols.planW, field: 'plan' });
  }
  return spans;
};

const typedQuery = (search, field) => {
  if (!search || search.field !== field) return '';
  return `${search.query ?? ''}`;
};

const cellText = (text, width, query) => {
  const body = query || text;
  const shown = trimVisible(body, width);
  const pad = ' '.repeat(Math.max(0, width - visibleWidth(shown)));
  return { shown, pad };
};

const paintAgentRow = (row, width, color, selected, cols, marked, search) => {
  const fields = agentFields(row);
  const showMark = marked !== false && selected;
  const prefix = markPrefix(showMark);
  const rest = Math.max(1, width - MARK_W - TAIL);
  const { nameW, modelW, effortW, fastW, contextW, planW } = cols;
  const gap = cols.gap || ' ';
  const name = trimVisible(fields.name, nameW);
  const namePad = ' '.repeat(Math.max(0, nameW - visibleWidth(name)));
  const modelQuery = typedQuery(search, 'model');
  const modelCell = cellText(fields.model, modelW, modelQuery);
  const model = modelCell.shown;
  const modelPad = modelCell.pad;
  const effortQuery = typedQuery(search, 'effort');
  const effortCell = cellText(fields.effort, effortW, effortQuery);
  const effort = effortCell.shown;
  const effortPad = effortCell.pad;
  const fast = trimVisible(fields.fast, fastW);
  const fastPad = ' '.repeat(Math.max(0, fastW - visibleWidth(fast)));
  const contextQuery = typedQuery(search, 'context');
  const contextCell = cellText(fields.context, contextW, contextQuery);
  const context = contextCell.shown;
  const contextPad = contextCell.pad;
  const planQuery = typedQuery(search, 'plan');
  const planCell = cellText(fields.plan, planW, planQuery);
  const plan = planQuery
    ? `${planCell.shown}${planCell.pad}`
    : `${planCell.pad}${planCell.shown}`;
  let mid = `${name}${namePad}`;
  if (modelW) mid += `${gap}${model}${modelPad}`;
  if (effortW) mid += `${gap}${effort}${effortPad}`;
  if (fastW) mid += `${gap}${fast}${fastPad}`;
  if (contextW) mid += `${gap}${context}${contextPad}`;
  if (planW) mid += `${gap}${plan}`;
  const detailW = Math.max(0, rest - visibleWidth(mid) - gap.length);
  const detail = trimVisible(fields.detail, detailW);
  const after = fields.detail ? `${gap}${detail}` : '';
  const pad = ' '.repeat(Math.max(0, rest - visibleWidth(mid + after)));
  const tail = ' '.repeat(TAIL);
  const spans = columnSpans(row, fields, cols, gap);
  const fgRgb = selected ? THEME.chromeFg : THEME.mutedFg;
  const bgRgb = selected ? THEME.buttonBg : THEME.ctxBg;
  if (!color) return { row: `${prefix}${mid}${after}${pad}${tail}`, spans };
  const nameFg = row.bin ? THEME.buttonHotFg : THEME.mutedFg;
  const modelFg = row.bin ? THEME.shaFg : THEME.shaDarkFg;
  let out = `${seq(fgRgb, bgRgb)}${EL}`;
  out += paint(prefix, fgRgb, bgRgb, color);
  out += paint(`${name}${namePad}`, nameFg, bgRgb, color, Boolean(row.bin));
  const valueFg = row.bin ? THEME.buttonHotFg : fgRgb;
  const paintValue = (face, query, fg, bold) => {
    if (!query) return paint(face, fg, bgRgb, color, bold);
    return paint(face, THEME.searchFg, THEME.searchBg, color, true);
  };
  if (modelW) {
    out += paint(gap, valueFg, bgRgb, color);
    const face = `${model}${modelPad}`;
    out += paintValue(face, modelQuery, modelFg, Boolean(row.bin));
  }
  if (effortW) {
    out += paint(gap, valueFg, bgRgb, color);
    out += paintValue(`${effort}${effortPad}`, effortQuery, valueFg, false);
  }
  if (fastW) out += paint(`${gap}${fast}${fastPad}`, valueFg, bgRgb, color);
  if (contextW) {
    out += paint(gap, valueFg, bgRgb, color);
    const face = `${context}${contextPad}`;
    out += paintValue(face, contextQuery, valueFg, false);
  }
  const planFg = row.planBusy ? THEME.mutedFg : fgRgb;
  if (planW) {
    out += paint(gap, valueFg, bgRgb, color);
    out += paintValue(plan, planQuery, planFg, false);
  }
  out += paint(`${after}${pad}${tail}`, fgRgb, bgRgb, color);
  return { row: out, spans };
};

const fieldX = (cols, gap, field) => {
  let x = MARK_W + cols.nameW;
  if (field === 'model') return x + (cols.modelW ? gap.length : 0);
  if (cols.modelW) x += gap.length + cols.modelW;
  if (field === 'effort') return x + (cols.effortW ? gap.length : 0);
  if (cols.effortW) x += gap.length + cols.effortW;
  if (cols.fastW) x += gap.length + cols.fastW;
  if (field === 'context') return x + (cols.contextW ? gap.length : 0);
  if (cols.contextW) x += gap.length + cols.contextW;
  return x + (cols.planW ? gap.length : 0);
};

const menuBoxWidth = (options, columnW, room) => {
  let widest = Math.max(columnW, 4);
  for (const label of options) {
    widest = Math.max(widest, visibleWidth(`${label ?? ''}`));
  }
  return Math.max(4, Math.min(room, widest + 2));
};

const menuItem = (label, boxW, color, selected, mark, disabled) => {
  const barW = mark ? 1 : 0;
  const faceW = Math.max(1, boxW - barW);
  const room = Math.max(0, faceW - 1);
  const shown = trimVisible(`${label ?? ''}`, room);
  const pad = ' '.repeat(Math.max(0, room - visibleWidth(shown)));
  const face = ` ${shown}${pad}`;
  if (!color) return `${face}${' '.repeat(barW)}`;
  const hot = selected && !disabled;
  const fgRgb = disabled ? THEME.mutedFg : THEME.chromeFg;
  const hotFg = hot ? THEME.buttonHotFg : fgRgb;
  const bgRgb = hot ? THEME.checkBg : THEME.noteBg;
  let row = paint(face, hotFg, bgRgb, color, hot);
  if (!mark) return row;
  const barBg = mark === 'thumb' ? THEME.taskHeadBg : THEME.buttonBg;
  row += paint(' ', fgRgb, barBg, color);
  return row;
};

const menuWindow = (focus, offset, size, count) => {
  let start = offset ?? 0;
  if (focus < start) start = focus;
  if (focus >= start + size) start = focus - size + 1;
  return Math.max(0, Math.min(start, Math.max(0, count - size)));
};

const dropBox = (options, cursor, scroll, room) => {
  const count = options.length;
  const focus = count ? Math.max(0, Math.min(cursor ?? 0, count - 1)) : 0;
  const inner = Math.max(1, Math.min(count || 1, room, 8));
  const start = count ? menuWindow(focus, scroll, inner, count) : 0;
  return { focus, inner, span: inner, start, count };
};

const scrollMark = (index, box) => {
  if (box.count <= box.inner) return '';
  let size = Math.max(1, Math.round((box.inner * box.inner) / box.count));
  if (box.inner > 1) size = Math.min(size, box.inner - 1);
  const travel = box.inner - size;
  const maxStart = box.count - box.inner;
  const at = maxStart <= 0 ? 0 : Math.round((box.start * travel) / maxStart);
  return index >= at && index < at + size ? 'thumb' : 'track';
};

const overlayMenu = (painted, view, cols, gap, width, color, headerLines) => {
  const options = view.agentMenu ?? [];
  const selected = view.agentCursor ?? 0;
  const rowHit = painted.fileHits.find(
    (hit) =>
      hit.cursor === selected && hit.field === undefined && hit.side !== 'runs',
  );
  if (!rowHit) return painted;
  const rowAt = rowHit.y - headerLines - 1;
  const below = painted.body.length - rowAt - 1;
  const above = rowAt;
  const down = below >= above;
  const room = Math.max(1, down ? below : above);
  const box = dropBox(
    options,
    view.agentPickCursor,
    view.agentMenuScroll,
    room,
  );
  const known = ['effort', 'plan', 'context'];
  const field = known.includes(view.agentPick) ? view.agentPick : 'model';
  const off = new Set(view.agentMenuOff ?? []);
  const columnW = cols[`${field}W`];
  let x = Math.max(0, fieldX(cols, gap, field) - 1);
  const boxW = menuBoxWidth(options, columnW, width - x);
  if (x + boxW > width) x = Math.max(0, width - boxW);
  const origin = down ? rowAt + 1 : Math.max(0, rowAt - box.span);
  const lines = [];
  for (let i = 0; i < box.inner; i++) {
    const index = box.start + i;
    const label = options[index];
    const mark = scrollMark(i, box);
    const disabled = label !== undefined && off.has(label);
    const face =
      label === undefined
        ? menuItem('none', boxW, color, false, mark, false)
        : menuItem(label, boxW, color, index === box.focus, mark, disabled);
    lines.push(face);
  }
  const body = painted.body.slice();
  const fileHits = painted.fileHits.slice();
  for (let i = 0; i < lines.length && origin + i < body.length; i++) {
    const at = origin + i;
    body[at] = stampVisible(body[at], x, lines[i]);
    const option = box.start + i;
    if (options[option] === undefined) continue;
    fileHits.unshift({
      y: headerLines + at + 1,
      cursor: option,
      x0: x,
      x1: x + boxW,
      field: 'menu',
    });
  }
  return { ...painted, body, fileHits, menuScroll: box.start };
};

const chooserSplit = (width) => {
  let rightW = Math.min(36, Math.max(16, Math.floor(width * 0.3)));
  let leftW = Math.max(0, width - rightW);
  const leftNeed = MARK_W + TAIL + 58;
  if (leftW < leftNeed && rightW > 12) {
    const give = Math.min(rightW - 12, leftNeed - leftW);
    rightW -= give;
    leftW += give;
  }
  return { leftW, rightW };
};

const shareWidths = (weights, room) => {
  const count = weights.length;
  const out = new Array(count).fill(0);
  const total = weights.reduce((sum, n) => sum + n, 0);
  if (!total || room <= 0) return out;
  let used = 0;
  for (let i = 0; i < count; i++) {
    if (!weights[i]) continue;
    out[i] = Math.floor((weights[i] * room) / total);
    used += out[i];
  }
  let left = room - used;
  const rank = [];
  for (let i = 0; i < count; i++) {
    if (!weights[i]) continue;
    const exact = (weights[i] * room) / total;
    rank.push({ i, frac: exact - out[i] });
  }
  rank.sort((a, b) => b.frac - a.frac || weights[b.i] - weights[a.i]);
  for (const item of rank) {
    if (left <= 0) break;
    out[item.i] += 1;
    left -= 1;
  }
  return out;
};

const fitCols = (width, cols) => {
  const rest = Math.max(0, width - MARK_W - TAIL);
  const wants = [
    cols.nameW,
    cols.modelW,
    cols.effortW,
    cols.fastW,
    cols.contextW,
    cols.planW,
  ].map((size) => Math.max(0, size ?? 0));
  let gaps = 0;
  let seen = false;
  for (const want of wants) {
    if (want <= 0) continue;
    if (seen) gaps += 1;
    seen = true;
  }
  const room = Math.max(0, rest - gaps);
  const widths = shareWidths(wants, room);
  return {
    nameW: widths[0],
    modelW: widths[1],
    effortW: widths[2],
    fastW: widths[3],
    contextW: widths[4],
    planW: widths[5],
  };
};

const statusTone = (status) => {
  if (status === 'running') return THEME.warnFg;
  if (status === 'exit 0') return THEME.pkgDepFg;
  if (status === 'stopped' || `${status ?? ''}`.startsWith('exit')) {
    return THEME.errorFg;
  }
  return THEME.mutedFg;
};

const statusWidth = (rows) => {
  let width = 7;
  for (const row of rows) {
    width = Math.max(width, visibleWidth(row.status || ''));
  }
  return Math.min(10, width);
};

const buttonFill = (width, color) => {
  const text = ' '.repeat(Math.max(0, width));
  if (!color) return text;
  return paint(text, THEME.chromeFg, THEME.buttonBg, color);
};

const paintRunRow = (row, width, color, selected, statusW) => {
  const bgRgb = selected ? THEME.checkBg : THEME.buttonBg;
  const fgRgb = selected ? THEME.buttonHotFg : THEME.chromeFg;
  if (row.empty) {
    const prefix = markPrefix(selected);
    const rest = Math.max(0, width - MARK_W);
    const label = trimVisible('none', rest);
    const pad = ' '.repeat(Math.max(0, rest - visibleWidth(label)));
    const line = `${prefix}${label}${pad}`;
    if (!color) return { row: line, hit: false };
    const face = paint(line, fgRgb, bgRgb, color);
    return { row: face, hit: false };
  }
  const prefix = markPrefix(selected);
  const budget = Math.max(0, width - MARK_W);
  const statusRoom = Math.min(statusW, budget);
  const status = trimVisible(row.status || '', statusRoom);
  const statusPad = ' '.repeat(statusRoom - visibleWidth(status));
  let gap = '';
  let command = '';
  if (budget > statusRoom) {
    gap = ' ';
    const cmdW = budget - statusRoom - gap.length;
    const detail = [row.elapsed, row.progress, row.command]
      .filter(Boolean)
      .join(' ');
    const shown = trimVisible(detail, cmdW);
    command = `${shown}${' '.repeat(Math.max(0, cmdW - visibleWidth(shown)))}`;
  }
  const line = `${prefix}${status}${statusPad}${gap}${command}`;
  const pad = ' '.repeat(Math.max(0, width - visibleWidth(line)));
  const text = `${line}${pad}`;
  if (!color) return { row: text };
  const tone = selected ? fgRgb : statusTone(row.status);
  let out = paint(prefix, fgRgb, bgRgb, color);
  out += paint(`${status}${statusPad}`, tone, bgRgb, color);
  out += paint(`${gap}${command}${pad}`, fgRgb, bgRgb, color);
  return { row: out };
};

const placeHits = (hits, origin, width, side) => {
  const placed = [];
  for (const hit of hits) {
    const x0 = (hit.x0 ?? 0) + origin;
    const x1 = (hit.x1 ?? width) + origin;
    placed.push({ ...hit, x0, x1, side });
  }
  return placed;
};

const joinPanes = (left, right, width, color, bodyH) => {
  const { leftW, rightW } = chooserSplit(width);
  const blankL = paintBodyFill(leftW, color, 'files');
  const blankR = buttonFill(rightW, color);
  const count = Math.max(left.body.length, right.body.length, bodyH);
  const body = [];
  for (let i = 0; i < count; i++) {
    const sideL = left.body[i] ?? blankL;
    const sideR = right.body[i] ?? blankR;
    body.push(`${sideL}${sideR}`);
  }
  const fileHits = [
    ...placeHits(left.fileHits, 0, leftW, 'cli'),
    ...placeHits(right.fileHits, leftW, rightW, 'runs'),
  ];
  return paneResult({
    body,
    fileHits,
    editHits: left.editHits,
    cursor: left.cursor,
    splitBody: true,
    listScroll: left.listScroll,
  });
};

const titleCell = (title, width, end) => {
  const shown = trimVisible(title, width);
  const pad = ' '.repeat(Math.max(0, width - visibleWidth(shown)));
  return end ? `${pad}${shown}` : `${shown}${pad}`;
};

const paintTitles = (width, cols, color) => {
  const gap = cols.gap || ' ';
  const prefix = ' '.repeat(MARK_W);
  let mid = titleCell('agent', cols.nameW);
  if (cols.modelW) mid += `${gap}${titleCell('model', cols.modelW)}`;
  if (cols.effortW) mid += `${gap}${titleCell('effort', cols.effortW)}`;
  if (cols.fastW) mid += `${gap}${titleCell('fast', cols.fastW)}`;
  if (cols.contextW) mid += `${gap}${titleCell('context', cols.contextW)}`;
  if (cols.planW) mid += `${gap}${titleCell('review', cols.planW, true)}`;
  const room = Math.max(0, width - MARK_W - TAIL - visibleWidth(mid));
  const text = `${prefix}${mid}${' '.repeat(room)}${' '.repeat(TAIL)}`;
  if (!color) return text;
  return paint(text, THEME.mutedFg, THEME.ctxBg, color);
};

const paintRunHead = (width, color) => {
  const prefix = ' '.repeat(MARK_W);
  const rest = Math.max(0, width - MARK_W);
  const label = trimVisible('status', rest);
  const pad = ' '.repeat(Math.max(0, rest - visibleWidth(label)));
  const text = `${prefix}${label}${pad}`;
  if (!color) return text;
  return paint(text, THEME.mutedFg, THEME.buttonBg, color);
};

const logBanner = (text, width, color, fgRgb) => {
  const shown = trimVisible(text, width);
  const pad = ' '.repeat(Math.max(0, width - visibleWidth(shown)));
  const line = `${shown}${pad}`;
  if (!color) return line;
  return paint(line, fgRgb, THEME.ctxBg, color);
};

const paintAgentLog = (view, width, color, bodyH) => {
  const head = [];
  const command = `${view.agentCommand ?? ''}`.trim();
  if (command) head.push(logBanner(command, width, color, THEME.chromeFg));
  const summary = [view.agentStatus, view.agentElapsed, view.agentProgress]
    .filter(Boolean)
    .join('  ');
  if (summary) {
    head.push(logBanner(summary, width, color, statusTone(view.agentStatus)));
  }
  const logH = Math.max(0, bodyH - head.length);
  if (!logH) return paneResult({ body: head.slice(0, bodyH) });
  const log = paintNpmLog(
    {
      npmOutput: view.agentOutput,
      npmRunning: view.agentRunning,
      npmFollow: view.agentFollow,
      npmScroll: view.agentScroll,
      progressFrame: view.progressFrame,
    },
    width,
    color,
    logH,
  );
  log.body.unshift(...head);
  return log;
};

const paintBodyAgents = (view, width, color, bodyH, headerLines) => {
  if (view.agentView) return paintAgentLog(view, width, color, bodyH);
  const { leftW, rightW } = chooserSplit(width);
  const rows = view.agents ?? [];
  const cursor = view.agentCursor ?? 0;
  const fitted = fitCols(leftW, {
    nameW: nameWidth(rows),
    modelW: modelWidth(rows),
    effortW: effortWidth(rows),
    fastW: fastWidth(rows),
    contextW: contextWidth(rows),
    planW: planWidth(rows),
  });
  const cols = { ...fitted, gap: ' ' };
  const listH = Math.max(0, bodyH - 1 - HEAD_GAP);
  const pane = {
    width: leftW,
    color,
    bodyH: listH,
    headerLines: headerLines + 1 + HEAD_GAP,
    offset: view.listScroll,
  };
  const onCli = view.agentFocus !== 'runs';
  const search =
    view.agentPick && view.agentQuery
      ? { field: view.agentPick, query: view.agentQuery }
      : null;
  const paintRow = (entry, selected) =>
    paintAgentRow(
      entry,
      leftW,
      color,
      selected,
      cols,
      onCli,
      selected && search,
    );
  const left = paintCursorList(rows, cursor, pane, paintRow);
  left.body.unshift(paintTitles(leftW, cols, color));
  left.body.unshift(paintBodyFill(leftW, color, 'files'));
  const runs = view.agentRuns ?? [];
  const runRows = runs.length ? runs : [{ empty: true }];
  const runCursor = view.agentRunCursor ?? 0;
  const onRuns = view.agentFocus === 'runs';
  const runW = statusWidth(runs);
  const paintRun = (entry, selected) =>
    paintRunRow(entry, rightW, color, onRuns && selected, runW);
  const runPane = {
    width: rightW,
    color,
    bodyH: listH,
    headerLines: headerLines + 1 + HEAD_GAP,
    offset: view.agentRunScroll ?? 0,
    blank: buttonFill(rightW, color),
  };
  const right = paintCursorList(runRows, runCursor, runPane, paintRun);
  right.body.unshift(paintRunHead(rightW, color));
  right.body.unshift(buttonFill(rightW, color));
  const joined = joinPanes(left, right, width, color, bodyH);
  joined.runScroll = right.listScroll;
  if (!view.agentMenu) return joined;
  return overlayMenu(joined, view, cols, cols.gap, width, color, headerLines);
};

const agentsBlock = (model, width, height, ctx, tile) => {
  const data = model.agents;
  if (!data || !data.ready) return waiting('detecting clis…');
  const aside = [seg(`${data.installed}/${data.total}`, 'muted')];
  if (data.running) aside.unshift(seg(`${data.running} run`, 'warn'));
  const titleLine = titleAside(tile, aside, width);
  const items = data.items ?? [];
  if (!items.length) return { titleLine, lines: [[seg('none', 'muted')]] };
  const shown = items.slice(0, Math.max(0, height));
  const rows = shown.map((item) => [
    flexCell(item.name, item.bin ? 'text' : 'muted'),
    cell(item.bin ? item.model : 'missing', item.bin ? 'sha' : 'muted', 'r'),
  ]);
  return { titleLine, lines: tableLines(rows, width) };
};

module.exports = { paintBodyAgents, agentsBlock };
