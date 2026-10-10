'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { spawnBase } = require('../common/utilities.js');
const { Screen } = require('../term/screen.js');
const { sawWork } = require('./approvals.js');
const { RunProcess } = require('../runs/process.js');

const COLS = 80;
const ROWS = 24;

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

class PtyProcess extends RunProcess {
  constructor(onData, onClose) {
    super(onData, onClose);
    this.screen = new Screen(COLS, ROWS);
    this.control = null;
    this.didWork = false;
  }

  start(python, cwd, launch, env) {
    const options = spawnBase({
      cwd,
      env: { ...env, RESLOP_ROWS: String(ROWS), RESLOP_COLS: String(COLS) },
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    const args = ['-c', HELPER, launch.cmd, ...launch.args];
    try {
      this.child = spawn(python, args, options);
    } catch {
      return false;
    }
    const { child } = this;
    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => this.take(chunk));
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        if (chunk.trim()) this.append(chunk);
      });
    }
    if (child.stdin) child.stdin.on('error', () => {});
    this.control = child.stdio[3];
    if (this.control) this.control.on('error', () => {});
    child.on('error', (error) => {
      if (!this.stopped) this.append(error.message);
      this.finish(1);
    });
    child.on('close', (status) => this.finish(status));
    return true;
  }

  take(chunk) {
    if (this.closed) return;
    if (sawWork(chunk)) this.didWork = true;
    this.screen.write(chunk);
    const next = this.screen.plain();
    if (next !== this.text) this.show(next);
  }

  append(text) {
    this.show(this.text ? `${this.text}\n${text}` : text);
  }

  write(data) {
    const { stdin } = this.child;
    if (!stdin || !stdin.writable || this.settled) return;
    stdin.write(data);
  }

  resize(cols, rows) {
    const width = Math.max(20, cols | 0);
    const height = Math.max(8, rows | 0);
    this.screen.resize(width, height);
    const { control } = this;
    if (!control || !control.writable || this.settled) return;
    control.write(`R ${height} ${width}\n`);
  }

  raw() {
    return this.screen.styled();
  }

  worked() {
    return this.didWork;
  }
}

const startPty = (cwd, launch, onData, onClose, env) => {
  const python = findPython(env);
  if (!python) return null;
  const proc = new PtyProcess(onData, onClose);
  return proc.start(python, cwd, launch, env) ? proc : null;
};

module.exports = { findPython, startPty };
