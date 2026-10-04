'use strict';

const ansi = require('../ansi.js');
const { THEME, paint, visibleWidth, trimVisible, seq, EL } = ansi;
const primitives = require('./primitives.js');
const { MARK_W, markPrefix, editSpan } = primitives;
const { paintCursorList, fieldWindow } = primitives;
const tiles = require('./tiles.js');
const { seg } = tiles;
const table = require('./dash-table.js');
const { waiting, cell, flexCell, tableLines, titleAside } = table;
const npmView = require('./npm.js');
const { paintNpmLog } = npmView;

const TAIL = 1;
const NAME_MAX = 10;
const MODEL_MAX = 16;
const EFFORT_MAX = 8;

const agentFields = (row) => {
  if (!row.bin) {
    return { name: row.name, model: '', effort: '', detail: 'not installed' };
  }
  const levels = row.efforts ?? [];
  const effort = levels.length ? row.effort || '' : '';
  const bits = [row.status, row.plan].filter(Boolean);
  return {
    name: row.name,
    model: row.model || '',
    effort,
    detail: bits.join('  '),
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

const modelWidth = (rows) =>
  colWidth(rows, (row) => agentFields(row).model, MODEL_MAX);

const effortWidth = (rows) =>
  colWidth(rows, (row) => agentFields(row).effort, EFFORT_MAX);

const paintAgentRow = (row, width, color, selected, cols) => {
  const fields = agentFields(row);
  const prefix = markPrefix(selected);
  const rest = Math.max(1, width - MARK_W - TAIL);
  const { nameW, modelW, effortW } = cols;
  const span = nameW + modelW + effortW;
  const gap = rest > span + 6 ? '  ' : ' ';
  const name = trimVisible(fields.name, nameW);
  const namePad = ' '.repeat(Math.max(0, nameW - visibleWidth(name)));
  const model = trimVisible(fields.model, modelW);
  const modelPad = ' '.repeat(Math.max(0, modelW - visibleWidth(model)));
  const effort = trimVisible(fields.effort, effortW);
  const effortPad = ' '.repeat(Math.max(0, effortW - visibleWidth(effort)));
  let mid = `${name}${namePad}${gap}${model}${modelPad}`;
  if (effortW) mid += `${gap}${effort}${effortPad}`;
  const detailW = Math.max(0, rest - visibleWidth(mid) - gap.length);
  const detail = trimVisible(fields.detail, detailW);
  const after = fields.detail ? `${gap}${detail}` : '';
  const pad = ' '.repeat(Math.max(0, rest - visibleWidth(mid + after)));
  const tail = ' '.repeat(TAIL);
  const fgRgb = selected ? THEME.chromeFg : THEME.mutedFg;
  const bgRgb = selected ? THEME.buttonBg : THEME.ctxBg;
  if (!color) return `${prefix}${mid}${after}${pad}${tail}`;
  const nameFg = row.bin ? THEME.buttonHotFg : THEME.mutedFg;
  let out = `${seq(fgRgb, bgRgb)}${EL}`;
  out += paint(prefix, fgRgb, bgRgb, color);
  out += paint(`${name}${namePad}`, nameFg, bgRgb, color, Boolean(row.bin));
  out += paint(`${gap}${model}${modelPad}`, fgRgb, bgRgb, color);
  if (effortW) {
    out += paint(`${gap}${effort}${effortPad}`, fgRgb, bgRgb, color);
  }
  return out + paint(`${after}${pad}${tail}`, fgRgb, bgRgb, color);
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
  const rows = view.agents ?? [];
  const cursor = view.agentCursor ?? 0;
  const editing = view.compose && view.compose.kind === 'agent';
  const typed = editing ? 'args' : '';
  const nameW = nameWidth(rows, typed);
  const modelW = modelWidth(rows);
  const effortW = effortWidth(rows);
  const cols = { nameW, modelW, effortW };
  const pane = { width, color, bodyH, headerLines, offset: view.listScroll };
  const paintRow = (entry, selected) =>
    paintAgentRow(entry, width, color, selected, cols);
  const extra = editing
    ? {
        ...paintAgentEdit(view.compose, width, color, nameW),
        at: 'replace',
        index: cursor,
      }
    : null;
  return paintCursorList(rows, cursor, pane, paintRow, extra);
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
