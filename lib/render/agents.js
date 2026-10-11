'use strict';

const { clamp, trimText } = require('../common/utilities.js');
const ansi = require('../term/ansi.js');
const { THEME, paint, visibleWidth, trimVisible, seq, EL } = ansi;
const { stampVisible } = ansi;
const primitives = require('./primitives.js');
const { scrollMark } = primitives;
const { placeHits } = primitives;
const { LIST_PAD, paintBodyFill, fill } = primitives;
const { paintCursorList, paneResult } = primitives;
const { seg } = require('./tiles.js');
const { menuBoxWidth, dropBox, menuFaces } = require('./menu.js');
const table = require('./table.js');
const { waiting, notice, cell, cellSegs } = table;
const { flexCell, tableLines, titleAside } = table;
const logPaint = require('./log.js');
const { LOG_PAD_X } = logPaint;
const { paintNpmLog, withLogScroller } = logPaint;
const { paintField } = require('./field.js');

const BUBBLE = '●';
const BUBBLE_PHASE = ['key', 'add', 'sha', 'warn'];
const PAD_W = 2;
const TAIL = 2;
const RUN_TAIL = 2;
const HEAD_GAP = 1;
const NAME_MAX = 10;
const MODEL_MAX = 32;
const EFFORT_MAX = 10;
const FAST_MAX = 4;
const CONTEXT_MAX = 8;
const PLAN_MAX = 48;
const COL_KEYS = ['name', 'model', 'effort', 'fast', 'context', 'plan'];
const VALUE_FIELDS = COL_KEYS.slice(1);
const COL_TITLES = {
  name: 'agent',
  model: 'model',
  effort: 'effort',
  fast: 'fast',
  context: 'context',
  plan: 'plan',
};

const agentFields = (row) => {
  if (!row.bin) {
    return {
      name: row.name,
      model: row.model || '',
      effort: '',
      fast: '',
      context: '',
      plan: 'not installed',
    };
  }
  const levels = row.efforts ?? [];
  return {
    name: row.name,
    model: row.model || '',
    effort: levels.length ? row.effort || '' : '',
    fast: row.fast || 'off',
    context: row.context || '',
    plan: row.plan || '',
  };
};

const colWidth = (rows, pick, max) => {
  let width = 0;
  for (const row of rows) {
    width = Math.max(width, visibleWidth(pick(row)));
  }
  return Math.min(max, width);
};

const nameWidth = (rows) =>
  colWidth(rows, (row) => agentFields(row).name, NAME_MAX);

const modelWidth = (rows) => {
  let width = 0;
  for (const row of rows) {
    if (!row.bin) continue;
    const shown = visibleWidth(agentFields(row).model);
    width = Math.max(width, shown, visibleWidth('model'));
  }
  if (width) return Math.min(MODEL_MAX, width);
  for (const row of rows) {
    if (agentFields(row).model) return visibleWidth('model');
  }
  return 0;
};

const effortWidth = (rows) => {
  let width = 0;
  for (const row of rows) {
    if (!row.bin) continue;
    width = Math.max(width, visibleWidth(agentFields(row).effort));
    for (const level of row.efforts ?? []) {
      const label = trimText(level);
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

const colW = (cols, field) => cols[`${field}W`] || 0;

const walkFields = (cols, gap, visit) => {
  let x = PAD_W + cols.nameW;
  for (const field of VALUE_FIELDS) {
    const width = colW(cols, field);
    if (!width) continue;
    x += gap.length;
    visit(field, x, width);
    x += width;
  }
};

const columnSpans = (row, fields, cols, gap) => {
  if (!row.bin) return [];
  const sizes = row.contexts ?? [];
  const spans = [];
  walkFields(cols, gap, (field, x, width) => {
    if (field === 'context' && !sizes.length) return;
    if (field === 'plan' && !fields.plan) return;
    spans.push({ x0: x, x1: x + width, field });
  });
  return spans;
};

const typedQuery = (search, field) => {
  if (!search || search.field !== field) return '';
  return `${search.query ?? ''}`;
};

const cellFace = (text, width, query, end = false) => {
  const body = query || text;
  const shown = trimVisible(body, width);
  const pad = ' '.repeat(Math.max(0, width - visibleWidth(shown)));
  return end && !query ? `${pad}${shown}` : `${shown}${pad}`;
};

const paintAgentRow = (row, width, color, selected, cols, search) => {
  const fields = agentFields(row);
  const prefix = ' '.repeat(PAD_W);
  const rest = Math.max(1, width - PAD_W - TAIL);
  const gap = cols.gap || ' ';
  const name = cellFace(fields.name, cols.nameW, '');
  const cells = {
    model: cellFace(fields.model, cols.modelW, typedQuery(search, 'model')),
    effort: cellFace(fields.effort, cols.effortW, typedQuery(search, 'effort')),
    fast: cellFace(fields.fast, cols.fastW, ''),
    context: cellFace(
      fields.context,
      cols.contextW,
      typedQuery(search, 'context'),
    ),
    plan: cellFace(fields.plan, cols.planW, typedQuery(search, 'plan'), true),
  };
  let mid = name;
  for (const field of VALUE_FIELDS) {
    if (colW(cols, field)) mid += `${gap}${cells[field]}`;
  }
  const pad = ' '.repeat(Math.max(0, rest - visibleWidth(mid)));
  const tail = ' '.repeat(TAIL);
  const spans = columnSpans(row, fields, cols, gap);
  const fgRgb = selected ? THEME.chromeFg : THEME.mutedFg;
  const bgRgb = selected ? THEME.buttonBg : THEME.ctxBg;
  if (!color) return { row: `${prefix}${mid}${pad}${tail}`, spans };
  const nameFg = row.bin ? THEME.buttonHotFg : THEME.mutedFg;
  const modelFg = row.bin ? THEME.shaFg : THEME.shaDarkFg;
  const valueFg = row.bin ? THEME.buttonHotFg : fgRgb;
  const tones = {
    model: { fg: modelFg, bold: Boolean(row.bin) },
    effort: { fg: valueFg, bold: false },
    fast: { fg: valueFg, bold: false, glue: true },
    context: { fg: valueFg, bold: false },
    plan: { fg: row.planBusy ? THEME.mutedFg : fgRgb, bold: false },
  };
  let out = `${seq(fgRgb, bgRgb)}${EL}`;
  out += paint(prefix, fgRgb, bgRgb, color);
  out += paint(name, nameFg, bgRgb, color, Boolean(row.bin));
  for (const field of VALUE_FIELDS) {
    const size = colW(cols, field);
    if (!size) continue;
    const face = cells[field];
    const tone = tones[field];
    const query = typedQuery(search, field);
    if (tone.glue) {
      out += paint(`${gap}${face}`, tone.fg, bgRgb, color);
      continue;
    }
    out += paint(gap, valueFg, bgRgb, color);
    if (query && search.editor) {
      search.editor.reveal(size);
      const queryTones = {
        plain: { fg: THEME.searchFg, bg: THEME.searchBg },
        select: { fg: THEME.chromeFg, bg: THEME.checkBg },
        caret: { fg: THEME.searchOnFg, bg: THEME.searchOnBg },
      };
      out += paintField(query, search.editor, size, color, queryTones);
    } else if (query) {
      out += paint(face, THEME.searchFg, THEME.searchBg, color, true);
    } else {
      out += paint(face, tone.fg, bgRgb, color, tone.bold);
    }
  }
  out += paint(`${pad}${tail}`, fgRgb, bgRgb, color);
  return { row: out, spans };
};

const fieldX = (cols, gap, field) => {
  let x = PAD_W + cols.nameW;
  for (const name of VALUE_FIELDS) {
    const width = colW(cols, name);
    if (name === field) return x + (width ? gap.length : 0);
    if (width) x += gap.length + width;
  }
  return x;
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
  const menus = new Set(['model', 'effort', 'context', 'plan']);
  const field = menus.has(view.agentPick) ? view.agentPick : 'model';
  const off = new Set(view.agentMenuOff ?? []);
  const columnW = cols[`${field}W`];
  let x = Math.max(0, fieldX(cols, gap, field) - 1);
  const boxW = menuBoxWidth(options, columnW, width - x);
  if (x + boxW > width) x = Math.max(0, width - boxW);
  const origin = down ? rowAt + 1 : Math.max(0, rowAt - box.span);
  const faces = menuFaces(options, box, boxW, color, off);
  const body = painted.body.slice();
  const fileHits = painted.fileHits.slice();
  for (let i = 0; i < faces.length && origin + i < body.length; i++) {
    const at = origin + i;
    body[at] = stampVisible(body[at], x, faces[i].face);
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
  let rightW = clamp(Math.floor(width * 0.3), 16, 36);
  let leftW = Math.max(0, width - rightW);
  const leftNeed = PAD_W + TAIL + 58;
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
  const rest = Math.max(0, width - PAD_W - TAIL);
  const wants = COL_KEYS.map((key) => Math.max(0, cols[`${key}W`] ?? 0));
  let gaps = 0;
  let seen = false;
  for (const want of wants) {
    if (want <= 0) continue;
    if (seen) gaps += 1;
    seen = true;
  }
  const room = Math.max(0, rest - gaps);
  const widths = shareWidths(wants, room);
  const fitted = {};
  for (let i = 0; i < COL_KEYS.length; i++) {
    fitted[`${COL_KEYS[i]}W`] = widths[i];
  }
  return fitted;
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

const buttonFill = (width, color) =>
  fill(width, THEME.chromeFg, THEME.buttonBg, color);

const paintRunRow = (row, width, color, selected, statusW) => {
  const bgRgb = selected ? THEME.checkBg : THEME.buttonBg;
  const fgRgb = selected ? THEME.buttonHotFg : THEME.chromeFg;
  const prefix = ' '.repeat(PAD_W);
  const tail = ' '.repeat(RUN_TAIL);
  if (row.empty || row.fresh || row.session) {
    const rest = Math.max(0, width - PAD_W - RUN_TAIL);
    const label = trimVisible(row.empty ? 'none' : row.name || '', rest);
    const pad = ' '.repeat(Math.max(0, rest - visibleWidth(label)));
    const line = `${prefix}${label}${pad}${tail}`;
    if (!color) {
      if (row.empty) return { row: line, hit: false };
      return { row: line };
    }
    const face = paint(line, fgRgb, bgRgb, color);
    if (row.empty) return { row: face, hit: false };
    return { row: face };
  }
  const budget = Math.max(0, width - PAD_W - RUN_TAIL);
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
  const pad = ' '.repeat(Math.max(0, width - RUN_TAIL - visibleWidth(line)));
  const text = `${line}${pad}${tail}`;
  if (!color) return { row: text };
  const tone = selected ? fgRgb : statusTone(row.status);
  let out = paint(prefix, fgRgb, bgRgb, color);
  out += paint(`${status}${statusPad}`, tone, bgRgb, color);
  out += paint(`${gap}${command}${pad}${tail}`, fgRgb, bgRgb, color);
  return { row: out };
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
  const prefix = ' '.repeat(PAD_W);
  let mid = titleCell(COL_TITLES.name, cols.nameW);
  for (const field of VALUE_FIELDS) {
    const size = colW(cols, field);
    if (!size) continue;
    mid += `${gap}${titleCell(COL_TITLES[field], size, field === 'plan')}`;
  }
  const room = Math.max(0, width - PAD_W - TAIL - visibleWidth(mid));
  const text = `${prefix}${mid}${' '.repeat(room)}${' '.repeat(TAIL)}`;
  if (!color) return text;
  return paint(text, THEME.mutedFg, THEME.ctxBg, color);
};

const logBanner = (text, width, color, fgRgb) => {
  const inner = Math.max(1, width - LOG_PAD_X * 2);
  const shown = trimVisible(text, inner);
  const lead = ' '.repeat(clamp(width, 0, LOG_PAD_X));
  const pad = Math.max(0, width - lead.length - visibleWidth(shown));
  const line = `${lead}${shown}${' '.repeat(pad)}`;
  if (!color) return line;
  return paint(line, fgRgb, THEME.ctxBg, color);
};

const paintAgentLog = (view, width, color, bodyH) => {
  const head = [fill(width, THEME.ctxFg, THEME.ctxBg, color)];
  const command = trimText(view.agentCommand);
  if (command) head.push(logBanner(command, width, color, THEME.chromeFg));
  const summary = [view.agentStatus, view.agentElapsed, view.agentProgress]
    .filter(Boolean)
    .join('  ');
  if (summary) {
    head.push(logBanner(summary, width, color, statusTone(view.agentStatus)));
  }
  const hint = trimText(view.agentHint);
  if (hint) head.push(logBanner(hint, width, color, THEME.warnFg));
  const logH = Math.max(0, bodyH - head.length);
  if (!logH) return paneResult({ body: head.slice(0, bodyH) });
  const log = paintNpmLog(
    {
      npmOutput: view.agentOutput,
      npmRunning: view.agentRunning,
      npmFollow: view.agentFollow,
      npmScroll: view.agentScroll,
      progressFrame: view.progressFrame,
      logScroller: true,
    },
    width,
    color,
    logH,
  );
  const bar = log.scrollBar;
  if (bar) log.scrollBar = { ...bar, row: bar.row + head.length };
  log.body.unshift(...head);
  return log;
};

const clipRunHits = (hits, width) => {
  const last = Math.max(0, width - 1);
  return hits.map((hit) => {
    if (hit.side !== 'runs') return hit;
    const x1 = Math.min(hit.x1 ?? last, last);
    return { ...hit, x1 };
  });
};

const withRunScroller = (painted, count, start, bodyH, width, color) => {
  const pad = bodyH >= LIST_PAD * 2 + 1 ? LIST_PAD : 0;
  const rows = Math.max(1, bodyH - pad * 2);
  const overflow = count > rows;
  const body = painted.body.map((line, index) => {
    const at = index - pad;
    const onText = at >= 0 && at < rows;
    let mark = '';
    if (overflow && onText) mark = scrollMark(at, count, rows, start);
    if (overflow && !onText) mark = 'track';
    return withLogScroller(line, mark, width, color);
  });
  const fileHits = clipRunHits(painted.fileHits, width);
  if (!overflow) return { ...painted, body, fileHits };
  const scrollBar = {
    col: width,
    row: 0,
    height: body.length,
    track: pad,
    rows,
    count,
    start,
  };
  return { ...painted, body, fileHits, scrollBar };
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
  const search =
    view.agentPick && view.agentQuery
      ? {
          field: view.agentPick,
          query: view.agentQuery,
          editor: view.agentEditor,
        }
      : null;
  const paintRow = (entry, selected) =>
    paintAgentRow(entry, leftW, color, selected, cols, selected && search);
  const left = paintCursorList(rows, cursor, pane, paintRow);
  left.body.unshift(paintTitles(leftW, cols, color));
  left.body.unshift(paintBodyFill(leftW, color, 'files'));
  const runs = view.agentRuns ?? [];
  const runRows = runs.length ? runs : [{ fresh: true, name: '<new session>' }];
  const runCursor = view.agentRunCursor ?? 0;
  const onRuns = view.agentFocus === 'runs';
  const runW = statusWidth(runs);
  const paintRun = (entry, selected) =>
    paintRunRow(entry, rightW, color, onRuns && selected, runW);
  const runPane = {
    width: rightW,
    color,
    bodyH,
    headerLines,
    offset: view.agentRunScroll ?? 0,
    blank: buttonFill(rightW, color),
  };
  const right = paintCursorList(runRows, runCursor, runPane, paintRun);
  const joined = joinPanes(left, right, width, color, bodyH);
  joined.runScroll = right.listScroll;
  const menu = view.agentMenu
    ? overlayMenu(joined, view, cols, cols.gap, width, color, headerLines)
    : joined;
  return withRunScroller(
    menu,
    runRows.length,
    right.listScroll,
    bodyH,
    width,
    color,
  );
};

const bubbleTone = (running, frame) => {
  if (!running) return 'muted';
  const index = Math.abs(frame ?? 0) % BUBBLE_PHASE.length;
  return BUBBLE_PHASE[index];
};

const agentLead = (item, frame) => {
  const segs = [seg(BUBBLE, bubbleTone(item.running, frame))];
  if (item.running) segs.push(seg(` ${item.running}`, 'key', true));
  return cellSegs(segs);
};

const agentsBlock = (model, width, height, ctx, tile) => {
  const data = model.agents;
  if (!data || !data.ready) return waiting('detecting clis…');
  const aside = [seg(`${data.running || 0}`, 'key', true)];
  const titleLine = titleAside(tile, aside, width);
  const items = data.items ?? [];
  if (!items.length) return notice('no agents', titleLine);
  const shown = items.slice(0, Math.max(0, height));
  const rows = shown.map((item) => [
    agentLead(item, ctx.frame),
    flexCell(item.name, item.bin ? 'text' : 'muted'),
    cell(item.bin ? item.model : 'missing', item.bin ? 'sha' : 'muted', 'r'),
  ]);
  return { titleLine, lines: tableLines(rows, width) };
};

module.exports = { paintBodyAgents, agentsBlock };
