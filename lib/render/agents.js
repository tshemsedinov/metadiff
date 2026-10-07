'use strict';

const ansi = require('../ansi.js');
const { THEME, paint, visibleWidth, trimVisible, seq, EL } = ansi;
const { stampVisible } = ansi;
const primitives = require('./primitives.js');
const { MARK_W, markPrefix, editSpan, paintBodyFill } = primitives;
const { paintCursorList, fieldWindow, paintSplitRule, paneResult } = primitives;
const { seg } = require('./tiles.js');
const table = require('./dash-table.js');
const { waiting, cell, flexCell, tableLines, titleAside } = table;
const { paintNpmLog } = require('./npm.js');

const TAIL = 1;
const NAME_MAX = 10;
const MODEL_MAX = 32;
const EFFORT_MAX = 10;
const PLAN_MAX = 48;

const agentFields = (row) => {
  if (!row.bin) {
    return {
      name: row.name,
      model: '',
      effort: '',
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
    const open = (row.modelChoices ?? []).length ? 8 : 0;
    width = Math.max(width, shown, open);
  }
  return Math.min(MODEL_MAX, width);
};

const effortWidth = (rows) =>
  colWidth(rows, (row) => agentFields(row).effort, EFFORT_MAX);

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
  if (cols.planW && fields.plan) {
    x += gap.length;
    spans.push({ x0: x, x1: x + cols.planW, field: 'plan' });
  }
  return spans;
};

const paintAgentRow = (row, width, color, selected, cols, marked) => {
  const fields = agentFields(row);
  const showMark = marked !== false && selected;
  const prefix = markPrefix(showMark);
  const rest = Math.max(1, width - MARK_W - TAIL);
  const { nameW, modelW, effortW, planW } = cols;
  const gap = cols.gap || ' ';
  const name = trimVisible(fields.name, nameW);
  const namePad = ' '.repeat(Math.max(0, nameW - visibleWidth(name)));
  const model = trimVisible(fields.model, modelW);
  const modelPad = ' '.repeat(Math.max(0, modelW - visibleWidth(model)));
  const effort = trimVisible(fields.effort, effortW);
  const effortPad = ' '.repeat(Math.max(0, effortW - visibleWidth(effort)));
  const plan = trimVisible(fields.plan, planW);
  const planPad = ' '.repeat(Math.max(0, planW - visibleWidth(plan)));
  let mid = `${name}${namePad}`;
  if (modelW) mid += `${gap}${model}${modelPad}`;
  if (effortW) mid += `${gap}${effort}${effortPad}`;
  if (planW) mid += `${gap}${plan}${planPad}`;
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
  let out = `${seq(fgRgb, bgRgb)}${EL}`;
  out += paint(prefix, fgRgb, bgRgb, color);
  out += paint(`${name}${namePad}`, nameFg, bgRgb, color, Boolean(row.bin));
  if (modelW) out += paint(`${gap}${model}${modelPad}`, fgRgb, bgRgb, color);
  if (effortW) {
    out += paint(`${gap}${effort}${effortPad}`, fgRgb, bgRgb, color);
  }
  if (planW) out += paint(`${gap}${plan}${planPad}`, fgRgb, bgRgb, color);
  out += paint(`${after}${pad}${tail}`, fgRgb, bgRgb, color);
  return { row: out, spans };
};

const paintAgentEdit = (compose, width, color, nameW) => {
  const prefix = markPrefix(true);
  const rest = Math.max(1, width - MARK_W - TAIL);
  const name = 'args';
  const namePad = ' '.repeat(Math.max(0, nameW - visibleWidth(name)));
  const gap = rest > nameW + 2 ? '  ' : ' ';
  const textX = MARK_W + nameW + gap.length + 1;
  const fieldW = Math.max(1, width - textX - TAIL + 1);
  const text = `${compose.text ?? ''}`.replaceAll('\n', ' ');
  const win = fieldWindow(text, compose.cursor, compose.scrollCol, fieldW);
  const gapText = ' '.repeat(Math.max(0, fieldW - visibleWidth(win.text)));
  const tail = ' '.repeat(TAIL);
  const fg = THEME.chromeFg;
  const bg = THEME.buttonBg;
  const mid = `${name}${namePad}${gap}`;
  let row = `${prefix}${mid}${win.text}${gapText}${tail}`;
  if (color) {
    row = paint(prefix, fg, bg, color);
    row += paint(mid, THEME.buttonHotFg, bg, color, true);
    row += paint(win.text, THEME.buttonHotFg, bg, color);
    row += paint(`${gapText}${tail}`, fg, bg, color);
  }
  const edit = editSpan(1, textX, textX + fieldW, 0, text);
  const cursor = { x: textX + win.col, scroll: win.scroll };
  return { row, cursor, edits: [{ ...edit, scroll: win.scroll }] };
};

const fieldX = (cols, gap, field) => {
  let x = MARK_W + cols.nameW;
  if (field === 'model') return x + (cols.modelW ? gap.length : 0);
  if (cols.modelW) x += gap.length + cols.modelW;
  if (field === 'effort') return x + (cols.effortW ? gap.length : 0);
  if (cols.effortW) x += gap.length + cols.effortW;
  return x + (cols.planW ? gap.length : 0);
};

const menuBoxWidth = (options, columnW, room) => {
  let widest = Math.max(columnW, 4);
  for (const label of options) {
    widest = Math.max(widest, visibleWidth(`${label ?? ''}`));
  }
  return Math.max(4, Math.min(room, widest + 2));
};

const menuItem = (label, boxW, color, selected, mark) => {
  const barW = mark ? 1 : 0;
  const faceW = Math.max(1, boxW - barW);
  const room = Math.max(0, faceW - 1);
  const shown = trimVisible(`${label ?? ''}`, room);
  const pad = ' '.repeat(Math.max(0, room - visibleWidth(shown)));
  const face = ` ${shown}${pad}`;
  if (!color) return `${face}${' '.repeat(barW)}`;
  const fgRgb = selected ? THEME.buttonHotFg : THEME.chromeFg;
  const bgRgb = selected ? THEME.checkBg : THEME.noteBg;
  let row = paint(face, fgRgb, bgRgb, color, selected);
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
  const field =
    view.agentPick === 'effort' || view.agentPick === 'plan'
      ? view.agentPick
      : 'model';
  const columnW = cols[`${field}W`];
  let x = fieldX(cols, gap, field);
  const boxW = menuBoxWidth(options, columnW, width - x);
  if (x + boxW > width) x = Math.max(0, width - boxW);
  const origin = down ? rowAt + 1 : Math.max(0, rowAt - box.span);
  const lines = [];
  for (let i = 0; i < box.inner; i++) {
    const index = box.start + i;
    const label = options[index];
    const mark = scrollMark(i, box);
    const face =
      label === undefined
        ? menuItem('none', boxW, color, false, mark)
        : menuItem(label, boxW, color, index === box.focus, mark);
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
  const inner = Math.max(0, width - 1);
  const rightW = Math.min(36, Math.max(20, Math.floor(inner * 0.28)));
  const leftW = Math.max(0, inner - rightW);
  return { leftW, rightW };
};

const fitCols = (width, cols) => {
  const rest = Math.max(0, width - MARK_W - TAIL);
  let budget = rest;
  const take = (want, lead) => {
    if (want <= 0 || budget <= 0) return 0;
    const room = lead ? budget : budget - 1;
    if (room <= 0) return 0;
    const n = Math.min(want, room);
    budget -= (lead ? 0 : 1) + n;
    return n;
  };
  const nameW = take(cols.nameW, true);
  const modelW = take(cols.modelW, nameW === 0);
  const planW = take(cols.planW, nameW + modelW === 0);
  const effortW = take(cols.effortW, nameW + modelW + planW === 0);
  return { nameW, modelW, effortW, planW };
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

const paintRunRow = (row, width, color, selected, statusW) => {
  if (row.empty) {
    const prefix = markPrefix(false);
    const rest = Math.max(0, width - MARK_W);
    const label = trimVisible('none', rest);
    const pad = ' '.repeat(Math.max(0, rest - visibleWidth(label)));
    const line = `${prefix}${label}${pad}`;
    if (!color) return { row: line, hit: false };
    const face = paint(line, THEME.mutedFg, THEME.ctxBg, color);
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
    const shown = trimVisible(row.command || '', cmdW);
    command = `${shown}${' '.repeat(Math.max(0, cmdW - visibleWidth(shown)))}`;
  }
  const line = `${prefix}${status}${statusPad}${gap}${command}`;
  const pad = ' '.repeat(Math.max(0, width - visibleWidth(line)));
  const text = `${line}${pad}`;
  if (!color) return { row: text };
  const fgRgb = selected ? THEME.chromeFg : THEME.mutedFg;
  const bgRgb = selected ? THEME.buttonBg : THEME.ctxBg;
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
  const rule = paintSplitRule(color);
  const blankL = paintBodyFill(leftW, color, 'files');
  const blankR = paintBodyFill(rightW, color, 'files');
  const count = Math.max(left.body.length, right.body.length, bodyH);
  const body = [];
  for (let i = 0; i < count; i++) {
    const sideL = left.body[i] ?? blankL;
    const sideR = right.body[i] ?? blankR;
    body.push(`${sideL}${rule}${sideR}`);
  }
  const fileHits = [
    ...placeHits(left.fileHits, 0, leftW, 'cli'),
    ...placeHits(right.fileHits, leftW + 1, rightW, 'runs'),
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

const paintBodyAgents = (view, width, color, bodyH, headerLines) => {
  if (view.agentView) {
    return paintNpmLog(
      {
        npmOutput: view.agentOutput,
        npmRunning: view.agentRunning,
        npmFollow: view.agentFollow,
        npmScroll: view.agentScroll,
        progressFrame: view.progressFrame,
      },
      width,
      color,
      bodyH,
    );
  }
  const { leftW, rightW } = chooserSplit(width);
  const rows = view.agents ?? [];
  const cursor = view.agentCursor ?? 0;
  const editing = view.compose && view.compose.kind === 'agent';
  const typed = editing ? 'args' : '';
  const fitted = fitCols(leftW, {
    nameW: nameWidth(rows, typed),
    modelW: modelWidth(rows),
    effortW: effortWidth(rows),
    planW: planWidth(rows),
  });
  const cols = { ...fitted, gap: ' ' };
  const pane = {
    width: leftW,
    color,
    bodyH,
    headerLines,
    offset: view.listScroll,
  };
  const onCli = view.agentFocus !== 'runs';
  const paintRow = (entry, selected) =>
    paintAgentRow(entry, leftW, color, selected, cols, onCli);
  const extra = editing
    ? {
        ...paintAgentEdit(view.compose, leftW, color, cols.nameW),
        at: 'replace',
        index: cursor,
      }
    : null;
  const left = paintCursorList(rows, cursor, pane, paintRow, extra);
  const runs = view.agentRuns ?? [];
  const runRows = runs.length ? runs : [{ empty: true }];
  let runCursor = -1;
  if (runs.length) runCursor = view.agentRunCursor ?? 0;
  const onRuns = view.agentFocus === 'runs';
  const runW = statusWidth(runs);
  const paintRun = (entry, selected) =>
    paintRunRow(entry, rightW, color, onRuns && selected, runW);
  const runPane = {
    width: rightW,
    color,
    bodyH,
    headerLines,
    offset: 0,
  };
  const right = paintCursorList(runRows, runCursor, runPane, paintRun);
  const joined = joinPanes(left, right, width, color, bodyH);
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
