'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { spawnBase } = require('./utilities.js');
const { killTree } = require('./npm-commands.js');
const { createScreen, resizeScreen, screenWrite } = require('./term-screen.js');

const HELPER = [
  'import errno, os, select, signal, sys, struct, fcntl, termios',
  'def set_size(fd, rows, cols):',
  '    rows = 1 if rows < 1 else rows',
  '    cols = 1 if cols < 1 else cols',
  '    buf = struct.pack("HHHH", rows, cols, 0, 0)',
  '    fcntl.ioctl(fd, termios.TIOCSWINSZ, buf)',
  'rows = int(os.environ.get("RESLOP_ROWS") or "24")',
  'cols = int(os.environ.get("RESLOP_COLS") or "80")',
  'cmd = sys.argv[1:]',
  'if not cmd:',
  '    sys.exit(127)',
  'os.environ["LINES"] = str(rows)',
  'os.environ["COLUMNS"] = str(cols)',
  'pid, fd = os.forkpty()',
  'if pid == 0:',
  '    try:',
  '        os.execvp(cmd[0], cmd)',
  '    except OSError:',
  '        os._exit(127)',
  'def stop(signum, frame):',
  '    try:',
  '        os.kill(pid, signal.SIGKILL)',
  '    except OSError:',
  '        pass',
  '    sys.exit(128 + signum)',
  'signal.signal(signal.SIGTERM, stop)',
  'signal.signal(signal.SIGINT, stop)',
  'try:',
  '    set_size(fd, rows, cols)',
  '    os.kill(pid, signal.SIGWINCH)',
  'except OSError:',
  '    pass',
  'os.set_blocking(fd, False)',
  'os.set_blocking(0, False)',
  'ctrl, has_ctrl, stdin_open, buf = 3, True, True, b""',
  'try:',
  '    os.set_blocking(ctrl, False)',
  'except OSError:',
  '    has_ctrl = False',
  'while True:',
  '    watch = [fd]',
  '    if stdin_open:',
  '        watch.append(0)',
  '    if has_ctrl:',
  '        watch.append(ctrl)',
  '    try:',
  '        ready, _, _ = select.select(watch, [], [], None)',
  '    except InterruptedError:',
  '        continue',
  '    if fd in ready:',
  '        try:',
  '            data = os.read(fd, 65536)',
  '        except OSError as err:',
  '            if err.errno not in (errno.EIO, errno.EBADF):',
  '                raise',
  '            data = b""',
  '        if not data:',
  '            break',
  '        try:',
  '            os.write(1, data)',
  '        except OSError:',
  '            break',
  '    if stdin_open and 0 in ready:',
  '        try:',
  '            data = os.read(0, 65536)',
  '        except OSError:',
  '            data = b""',
  '        if not data:',
  '            stdin_open = False',
  '        else:',
  '            try:',
  '                os.write(fd, data)',
  '            except OSError:',
  '                break',
  '    if not has_ctrl or ctrl not in ready:',
  '        continue',
  '    try:',
  '        data = os.read(ctrl, 1024)',
  '    except OSError:',
  '        data = b""',
  '    if not data:',
  '        has_ctrl = False',
  '        continue',
  '    buf += data',
  '    while b"\\n" in buf:',
  '        line, buf = buf.split(b"\\n", 1)',
  '        parts = line.split()',
  '        if len(parts) != 3 or parts[0] != b"R":',
  '            continue',
  '        try:',
  '            set_size(fd, int(parts[1]), int(parts[2]))',
  '        except (OSError, ValueError):',
  '            pass',
  'status = 1',
  'try:',
  '    _, status = os.waitpid(pid, 0)',
  'except ChildProcessError:',
  '    status = 0',
  'code = os.waitstatus_to_exitcode(status)',
  'sys.exit(code if isinstance(code, int) and code >= 0 else 1)',
].join('\n');

const findPython = (env) => {
  const dirs = `${env.PATH ?? ''}`.split(path.delimiter).filter(Boolean);
  for (const name of ['python3', 'python']) {
    for (const dir of dirs) {
      const full = path.join(dir, name);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch {
        // try the next directory
      }
    }
  }
  return '';
};

const startPty = (cwd, launch, onData, onClose, env) => {
  const python = findPython(env);
  if (!python) return null;
  const cols = 80;
  const rows = 24;
  const screen = createScreen(cols, rows);
  let shown = '';
  let settled = false;
  let stopped = false;
  const finish = (status) => {
    if (settled) return;
    settled = true;
    onClose({ status, text: shown });
  };
  const childEnv = {
    ...env,
    RESLOP_ROWS: String(rows),
    RESLOP_COLS: String(cols),
  };
  const options = spawnBase({
    cwd,
    env: childEnv,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
  let child;
  try {
    child = spawn(python, ['-c', HELPER, launch.cmd, ...launch.args], options);
  } catch {
    return null;
  }
  const take = (chunk) => {
    if (stopped || settled) return;
    const next = screenWrite(screen, chunk);
    if (next === shown) return;
    shown = next;
    onData(shown);
  };
  if (child.stdout) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', take);
  }
  if (child.stderr) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (!chunk.trim()) return;
      shown = shown ? `${shown}\n${chunk}` : chunk;
      onData(shown);
    });
  }
  if (child.stdin) child.stdin.on('error', () => {});
  const control = child.stdio[3];
  if (control) control.on('error', () => {});
  child.on('error', (error) => {
    if (!stopped) {
      shown = shown ? `${shown}\n${error.message}` : error.message;
      onData(shown);
    }
    finish(1);
  });
  child.on('close', (status) => finish(status));
  return {
    kill() {
      if (stopped || settled) return;
      stopped = true;
      killTree(child);
    },
    write(data) {
      if (!child.stdin || !child.stdin.writable || settled) return;
      child.stdin.write(data);
    },
    resize(nextCols, nextRows) {
      const width = Math.max(20, nextCols | 0);
      const height = Math.max(8, nextRows | 0);
      resizeScreen(screen, width, height);
      if (!control || !control.writable || settled) return;
      control.write(`R ${height} ${width}\n`);
    },
  };
};

module.exports = { findPython, startPty };
