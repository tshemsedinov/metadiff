import errno, os, select, signal, sys, struct, fcntl, termios
def set_size(fd, rows, cols):
    rows = 1 if rows < 1 else rows
    cols = 1 if cols < 1 else cols
    buf = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, buf)
rows = int(os.environ.get("RESLOP_ROWS") or "24")
cols = int(os.environ.get("RESLOP_COLS") or "80")
cmd = sys.argv[1:]
if not cmd:
    sys.exit(127)
os.environ["LINES"] = str(rows)
os.environ["COLUMNS"] = str(cols)
pid, fd = os.forkpty()
if pid == 0:
    try:
        os.execvp(cmd[0], cmd)
    except OSError:
        os._exit(127)
def stop(signum, frame):
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass
    sys.exit(128 + signum)
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    set_size(fd, rows, cols)
    os.kill(pid, signal.SIGWINCH)
except OSError:
    pass
os.set_blocking(fd, False)
os.set_blocking(0, False)
ctrl, has_ctrl, stdin_open, buf = 3, True, True, b""
try:
    os.set_blocking(ctrl, False)
except OSError:
    has_ctrl = False
while True:
    watch = [fd]
    if stdin_open:
        watch.append(0)
    if has_ctrl:
        watch.append(ctrl)
    try:
        ready, _, _ = select.select(watch, [], [], None)
    except InterruptedError:
        continue
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError as err:
            if err.errno not in (errno.EIO, errno.EBADF):
                raise
            data = b""
        if not data:
            break
        try:
            os.write(1, data)
        except OSError:
            break
    if stdin_open and 0 in ready:
        try:
            data = os.read(0, 65536)
        except OSError:
            data = b""
        if not data:
            stdin_open = False
        else:
            try:
                os.write(fd, data)
            except OSError:
                break
    if not has_ctrl or ctrl not in ready:
        continue
    try:
        data = os.read(ctrl, 1024)
    except OSError:
        data = b""
    if not data:
        has_ctrl = False
        continue
    buf += data
    while b"\n" in buf:
        line, buf = buf.split(b"\n", 1)
        parts = line.split()
        if len(parts) != 3 or parts[0] != b"R":
            continue
        try:
            set_size(fd, int(parts[1]), int(parts[2]))
        except (OSError, ValueError):
            pass
status = 1
try:
    _, status = os.waitpid(pid, 0)
except ChildProcessError:
    status = 0
code = os.waitstatus_to_exitcode(status)
sys.exit(code if isinstance(code, int) and code >= 0 else 1)
