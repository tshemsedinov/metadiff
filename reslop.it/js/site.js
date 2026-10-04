'use strict';

const INSTALL = 'npm i -g reslop';

const FILES = [
  {
    path: 'lib/auth.js',
    origin: 'unstaged',
    todo: 'reject missing Bearer tokens',
    feedback: 'use strict equality',
    loc: 'lib/auth.js:12:14:0',
    unified: [
      { k: 'ctx', g: ' ', html: '  <span class="kw">function</span> <span class="fn">verify</span>(token, users) {' },
      { k: 'ctx', g: ' ', html: '    <span class="kw">if</span> (!token) <span class="kw">return</span> <span class="kw">null</span>;' },
      {
        k: 'del',
        g: '-',
        html: '    <span class="kw">const</span> user = users.<span class="fn">find</span>(u =&gt; u.token <span class="ch">==</span> token)',
      },
      {
        k: 'add',
        g: '+',
        html: '    <span class="kw">const</span> user = users.<span class="fn">find</span>((u) =&gt; u.token <span class="ch">===</span> token);',
      },
      {
        k: 'del',
        g: '-',
        html: '    <span class="kw">if</span> (!user) <span class="kw">throw</span> <span class="ch">"unauthorized"</span>',
      },
      {
        k: 'add',
        g: '+',
        html: '    <span class="kw">if</span> (!user) {',
      },
      {
        k: 'add',
        g: '+',
        html: '      <span class="kw">throw</span> <span class="ch">new Error(\'unauthorized\')</span>;',
      },
      {
        k: 'add',
        g: '+',
        html: '    }',
      },
      { k: 'ctx', g: ' ', html: '    <span class="kw">return</span> user;' },
      { k: 'ctx', g: ' ', html: '  }' },
    ],
    left: [
      { k: 'ctx', g: ' ', html: '  <span class="kw">function</span> <span class="fn">verify</span>(token, users) {' },
      { k: 'ctx', g: ' ', html: '    <span class="kw">if</span> (!token) <span class="kw">return</span> <span class="kw">null</span>;' },
      {
        k: 'del',
        g: '-',
        html: '    <span class="kw">const</span> user = users.<span class="fn">find</span>(u =&gt; u.token <span class="ch">==</span> token)',
      },
      {
        k: 'del',
        g: '-',
        html: '    <span class="kw">if</span> (!user) <span class="kw">throw</span> <span class="ch">"unauthorized"</span>',
      },
      { k: 'ctx', g: ' ', html: '' },
      { k: 'ctx', g: ' ', html: '' },
      { k: 'ctx', g: ' ', html: '    <span class="kw">return</span> user;' },
      { k: 'ctx', g: ' ', html: '  }' },
    ],
    right: [
      { k: 'ctx', g: ' ', html: '  <span class="kw">function</span> <span class="fn">verify</span>(token, users) {' },
      { k: 'ctx', g: ' ', html: '    <span class="kw">if</span> (!token) <span class="kw">return</span> <span class="kw">null</span>;' },
      {
        k: 'add',
        g: '+',
        html: '    <span class="kw">const</span> user = users.<span class="fn">find</span>((u) =&gt; u.token <span class="ch">===</span> token);',
      },
      { k: 'add', g: '+', html: '    <span class="kw">if</span> (!user) {' },
      {
        k: 'add',
        g: '+',
        html: '      <span class="kw">throw</span> <span class="ch">new Error(\'unauthorized\')</span>;',
      },
      { k: 'add', g: '+', html: '    }' },
      { k: 'ctx', g: ' ', html: '    <span class="kw">return</span> user;' },
      { k: 'ctx', g: ' ', html: '  }' },
    ],
  },
  {
    path: 'lib/session.js',
    origin: 'staged',
    todo: 'do not keep week-long cookies',
    feedback: 'session maxAge is 15 minutes',
    loc: 'lib/session.js:28:28:0',
    unified: [
      { k: 'ctx', g: ' ', html: '  <span class="kw">const</span> session = {' },
      { k: 'ctx', g: ' ', html: '    httpOnly: <span class="kw">true</span>,' },
      { k: 'ctx', g: ' ', html: '    sameSite: <span class="st">\'lax\'</span>,' },
      {
        k: 'del',
        g: '-',
        html: '    maxAge: <span class="ch">86400000</span>,',
      },
      {
        k: 'add',
        g: '+',
        html: '    maxAge: <span class="ch">15 * 60 * 1000</span>,',
      },
      { k: 'ctx', g: ' ', html: '    secure: <span class="kw">true</span>,' },
      { k: 'ctx', g: ' ', html: '  };' },
    ],
    left: [
      { k: 'ctx', g: ' ', html: '  <span class="kw">const</span> session = {' },
      { k: 'ctx', g: ' ', html: '    httpOnly: <span class="kw">true</span>,' },
      { k: 'ctx', g: ' ', html: '    sameSite: <span class="st">\'lax\'</span>,' },
      { k: 'del', g: '-', html: '    maxAge: <span class="ch">86400000</span>,' },
      { k: 'ctx', g: ' ', html: '    secure: <span class="kw">true</span>,' },
      { k: 'ctx', g: ' ', html: '  };' },
    ],
    right: [
      { k: 'ctx', g: ' ', html: '  <span class="kw">const</span> session = {' },
      { k: 'ctx', g: ' ', html: '    httpOnly: <span class="kw">true</span>,' },
      { k: 'ctx', g: ' ', html: '    sameSite: <span class="st">\'lax\'</span>,' },
      { k: 'add', g: '+', html: '    maxAge: <span class="ch">15 * 60 * 1000</span>,' },
      { k: 'ctx', g: ' ', html: '    secure: <span class="kw">true</span>,' },
      { k: 'ctx', g: ' ', html: '  };' },
    ],
  },
  {
    path: 'test/auth.test.js',
    origin: 'untracked',
    todo: 'cover expired tokens',
    feedback: 'assert 401 without a Bearer header',
    loc: 'test/auth.test.js:1:1:0',
    unified: [
      {
        k: 'add',
        g: '+',
        html: '<span class="st">\'use strict\'</span>;',
      },
      { k: 'add', g: '+', html: '' },
      {
        k: 'add',
        g: '+',
        html: '<span class="kw">const</span> test = <span class="fn">require</span>(<span class="st">\'node:test\'</span>);',
      },
      {
        k: 'add',
        g: '+',
        html: '<span class="kw">const</span> assert = <span class="fn">require</span>(<span class="st">\'node:assert/strict\'</span>);',
      },
      { k: 'add', g: '+', html: '' },
      {
        k: 'add',
        g: '+',
        html: 'test(<span class="st">\'verify rejects a missing token\'</span>, () =&gt; {',
      },
      {
        k: 'add',
        g: '+',
        html: '  assert.<span class="fn">equal</span>(<span class="fn">verify</span>(<span class="kw">null</span>, []), <span class="kw">null</span>);',
      },
      { k: 'add', g: '+', html: '});' },
    ],
    left: [
      { k: 'ctx', g: ' ', html: '' },
      { k: 'ctx', g: ' ', html: '' },
      { k: 'ctx', g: ' ', html: '' },
      { k: 'ctx', g: ' ', html: '' },
      { k: 'ctx', g: ' ', html: '' },
      { k: 'ctx', g: ' ', html: '' },
      { k: 'ctx', g: ' ', html: '' },
      { k: 'ctx', g: ' ', html: '' },
    ],
    right: [
      { k: 'add', g: '+', html: '<span class="st">\'use strict\'</span>;' },
      { k: 'add', g: '+', html: '' },
      {
        k: 'add',
        g: '+',
        html: '<span class="kw">const</span> test = <span class="fn">require</span>(<span class="st">\'node:test\'</span>);',
      },
      {
        k: 'add',
        g: '+',
        html: '<span class="kw">const</span> assert = <span class="fn">require</span>(<span class="st">\'node:assert/strict\'</span>);',
      },
      { k: 'add', g: '+', html: '' },
      {
        k: 'add',
        g: '+',
        html: 'test(<span class="st">\'verify rejects a missing token\'</span>, () =&gt; {',
      },
      {
        k: 'add',
        g: '+',
        html: '  assert.<span class="fn">equal</span>(<span class="fn">verify</span>(<span class="kw">null</span>, []), <span class="kw">null</span>);',
      },
      { k: 'add', g: '+', html: '});' },
    ],
  },
];

const MODES = ['unified', 'mixed', 'side'];

const state = {
  index: 0,
  mode: 0,
  files: false,
  note: true,
  noteKind: 'feedback',
  msg: 'click or focus, then type',
};

const line = (row) =>
  `<div class="dl ${row.k}"><span class="g">${row.g}</span><span class="src">${row.html}</span></div>`;

const cell = (row) =>
  `<div class="cell ${row.k}"><span class="g">${row.g}</span><span class="src">${row.html || ' '}</span></div>`;

const pair = (left, right) =>
  `<div class="tui-pair">${cell(left)}<div class="split"></div>${cell(right)}</div>`;

const renderDiff = (file, mode) => {
  if (mode === 'unified') return file.unified.map(line).join('');
  const rows = [];
  const n = Math.max(file.left.length, file.right.length);
  for (let i = 0; i < n; i++) {
    const left = file.left[i] ?? { k: 'ctx', g: ' ', html: '' };
    const right = file.right[i] ?? { k: 'ctx', g: ' ', html: '' };
    if (mode === 'mixed' && left.k === 'ctx' && right.k === 'ctx') {
      rows.push(line(left.html ? left : right));
    } else {
      rows.push(pair(left, right));
    }
  }
  return rows.join('');
};

const pathBits = (rel) => {
  const bits = rel.split('/');
  return bits
    .map((part, i) => {
      const slash = i ? `<span class="chrome">/</span>` : '';
      const cls = i === bits.length - 1 ? 'file' : 'dir';
      return `${slash}<span class="${cls}">${part}</span>`;
    })
    .join('');
};

const render = () => {
  const tui = document.getElementById('tui');
  if (!tui) return;
  const file = FILES[state.index];
  const mode = MODES[state.mode];
  tui.dataset.mode = mode;
  tui.dataset.files = state.files ? '1' : '0';
  tui.dataset.note = state.note ? '1' : '0';

  const pathEl = tui.querySelector('[data-path]');
  const metaEl = tui.querySelector('[data-meta]');
  const diffEl = tui.querySelector('[data-diff]');
  const filesEl = tui.querySelector('[data-files]');
  const noteEl = tui.querySelector('[data-note]');
  const msgEl = tui.querySelector('[data-msg]');

  if (pathEl) pathEl.innerHTML = pathBits(file.path);
  if (metaEl) {
    metaEl.textContent = ` ${file.origin} ${state.index + 1}/${FILES.length}`;
  }
  if (diffEl) diffEl.innerHTML = renderDiff(file, mode);
  if (filesEl) {
    filesEl.innerHTML = FILES.map((entry, i) => {
      const current = i === state.index;
      const mark = current ? '▶' : '▷';
      return `<button type="button" data-file="${i}" aria-current="${current}">` +
        `<span class="mark">${mark}</span>` +
        `<span>${entry.path}</span>` +
        `<span class="st">${entry.origin}</span>` +
        `</button>`;
    }).join('');
  }
  if (noteEl) {
    const text = state.noteKind === 'todo'
      ? file.todo
      : `${file.feedback} - ${file.loc}`;
    const cap = state.noteKind === 'todo' ? 'TODO' : 'FEEDBACK';
    noteEl.innerHTML =
      `<div class="cap">${cap}</div>` +
      `<div><span class="check">[ ]</span>${text}</div>`;
  }
  if (msgEl) msgEl.textContent = state.msg;

  tui.querySelectorAll('[data-mode-btn]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.modeBtn === mode));
  });
  tui.querySelectorAll('[data-files-btn]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(state.files));
  });
};

const setMsg = (text) => {
  state.msg = text;
  const msgEl = document.querySelector('#tui [data-msg]');
  if (msgEl) msgEl.textContent = text;
};

const nextFile = (delta) => {
  state.index = (state.index + delta + FILES.length) % FILES.length;
  const file = FILES[state.index];
  setMsg(`${file.origin} ${state.index + 1}/${FILES.length}`);
  render();
};

const cycleMode = () => {
  state.mode = (state.mode + 1) % MODES.length;
  setMsg(MODES[state.mode] === 'side' ? 'side-by-side' : MODES[state.mode]);
  render();
};

const toggleFiles = () => {
  state.files = !state.files;
  setMsg(state.files ? 'files' : FILES[state.index].origin);
  render();
};

const showNote = (kind) => {
  if (state.note && state.noteKind === kind) {
    state.note = false;
    setMsg('saved');
  } else {
    state.note = true;
    state.noteKind = kind;
    setMsg(kind === 'todo' ? 'todo' : 'feedback');
  }
  render();
};

const copyText = async (text, button) => {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.left = '-9999px';
    document.body.appendChild(field);
    field.select();
    document.execCommand('copy');
    field.remove();
  }
  if (!button) return;
  button.dataset.copied = 'true';
  const prev = button.textContent;
  button.textContent = 'copied';
  window.setTimeout(() => {
    button.dataset.copied = 'false';
    button.textContent = prev;
  }, 1400);
};

const onTuiKey = (event) => {
  const key = event.key;
  if (key === 'm' || key === 'M') {
    event.preventDefault();
    cycleMode();
    return;
  }
  if (key === 'l' || key === 'L') {
    event.preventDefault();
    toggleFiles();
    return;
  }
  if (key === 'ArrowRight' || key === 'n' || key === 'N') {
    event.preventDefault();
    nextFile(1);
    return;
  }
  if (key === 'ArrowLeft' || key === 'p' || key === 'P') {
    event.preventDefault();
    nextFile(-1);
    return;
  }
  if (key === 'f' || key === 'F') {
    event.preventDefault();
    showNote('feedback');
    return;
  }
  if (key === 't' || key === 'T') {
    event.preventDefault();
    showNote('todo');
    return;
  }
  if (key === '?' || key === 'h' || key === 'H') {
    event.preventDefault();
    setMsg('m mode  l files  f feedback  t todo  ← → files');
  }
};

const bindTui = () => {
  const tui = document.getElementById('tui');
  if (!tui) return;
  tui.addEventListener('keydown', onTuiKey);
  tui.addEventListener('click', (event) => {
    const fileBtn = event.target.closest('[data-file]');
    if (fileBtn) {
      state.index = Number(fileBtn.dataset.file);
      setMsg(`${FILES[state.index].origin} ${state.index + 1}/${FILES.length}`);
      render();
      return;
    }
    const action = event.target.closest('[data-action]');
    if (!action) return;
    const id = action.dataset.action;
    if (id === 'mode') cycleMode();
    if (id === 'files') toggleFiles();
    if (id === 'next') nextFile(1);
    if (id === 'prev') nextFile(-1);
    if (id === 'feedback') showNote('feedback');
    if (id === 'todo') showNote('todo');
    if (id === 'add') setMsg('staged');
    if (id === 'unstage') setMsg('unstaged');
    if (id === 'revert') setMsg('reverted');
    if (id === 'skip') setMsg('skipped');
    if (id === 'quit') setMsg('f finish as ready   c continue next time');
  });
  render();
};

const bindCopy = () => {
  document.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', () => {
      const text = button.getAttribute('data-copy') || INSTALL;
      copyText(text, button);
    });
  });
};

const params = new URLSearchParams(location.search);
if (MODES.includes(params.get('mode'))) {
  state.mode = MODES.indexOf(params.get('mode'));
}
if (params.get('files') === '1') state.files = true;
if (params.get('file')) {
  const n = Number(params.get('file'));
  if (Number.isInteger(n) && n >= 0 && n < FILES.length) state.index = n;
}

bindTui();
bindCopy();
