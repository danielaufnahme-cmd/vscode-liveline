#!/usr/bin/env python3
"""Live Line runner for MicroPython boards (runs on the PC).

    python mpy_run.py PORT FILE

Runs FILE on the board with mpremote (like `mpremote connect PORT resume run FILE`)
and tells VSCodium which line is running:

- Before sending, every simple statement gets `_LL[0]=<line>;` put in front of it,
  on the same line, so line numbers in errors stay right. That is one list store
  per line (about a microsecond on an ESP32-S3).
- A small thread on the board prints the current line every 40 ms (only when it
  changed) between \\x1e and \\x1f. This script removes those markers from the
  output and forwards them to the Live Line extension; the rest is printed as usual.
- If the script crashes, the traceback is sent too, and the line is marked red.
"""
import ast
import json
import os
import re
import signal
import socket
import subprocess
import sys
import tempfile

SKIP_DECORATORS = {"viper", "native", "asm_thumb", "asm_xtensa"}   # code emitters: leave alone
COMPOUND = tuple(getattr(ast, n) for n in (
    "FunctionDef", "AsyncFunctionDef", "ClassDef", "If", "For", "AsyncFor", "While",
    "With", "AsyncWith", "Try", "TryStar", "Match") if hasattr(ast, n))


def _deco_name(d):
    if isinstance(d, ast.Call):
        d = d.func
    return d.attr if isinstance(d, ast.Attribute) else getattr(d, "id", "")


def instrument(src):
    """Same code, same line numbers, with `_LL[0]=N;` before the first statement of each line."""
    src = src.replace("\r\n", "\n").replace("\r", "\n")
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return src   # the board reports the error; we mark it
    first = {}   # line -> byte column of the first simple statement on it

    def walk(node, skip):
        for child in ast.iter_child_nodes(node):
            s = skip
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)) and \
                    any(_deco_name(d) in SKIP_DECORATORS for d in child.decorator_list):
                s = True
            if isinstance(child, ast.stmt) and not isinstance(child, COMPOUND) and not s and \
                    not (isinstance(child, ast.ImportFrom) and child.module == "__future__"):
                ln, col = child.lineno, child.col_offset
                if ln not in first or col < first[ln]:
                    first[ln] = col
            walk(child, s)

    walk(tree, False)
    lines = src.split("\n")
    for ln, col in first.items():
        text = lines[ln - 1]
        prefix = text.encode("utf-8")[:col].decode("utf-8", "ignore")
        lines[ln - 1] = prefix + "_LL[0]=%d;" % ln + text[len(prefix):]
    return "\n".join(lines)


# Runs on the board. Your code is compiled under its own file name, so errors say
# File "main.py", line N exactly like before.
WRAPPER = r'''import sys, time
try:
    import _thread
except ImportError:
    _thread = None
_LL = [0, 1, 0]
def _ll_watch():
    last = 0
    try:
        while _LL[1]:
            n = _LL[0]
            if n != last:
                last = n
                sys.stdout.write('\x1eL%%d\x1f' %% n)
            time.sleep_ms(40)
    finally:
        _LL[2] = 1
def _ll_stop():
    _LL[1] = 0
    if _thread:
        t = time.ticks_ms()
        while not _LL[2] and time.ticks_diff(time.ticks_ms(), t) < 300:
            time.sleep_ms(5)
if _thread:
    try:
        _thread.start_new_thread(_ll_watch, ())
    except Exception:
        _thread = None
_ll_g = {'__name__': '__main__', '_LL': _LL}
_ll_c = %(src)s.decode()
try:
    try:
        _ll_c = compile(_ll_c, %(name)r, 'exec')
    except NameError:
        pass
    exec(_ll_c, _ll_g)
except KeyboardInterrupt:
    _ll_stop()
    raise
except BaseException as _ll_e:
    _ll_stop()
    import io
    _ll_b = io.StringIO()
    sys.print_exception(_ll_e, _ll_b)
    sys.stdout.write('\x1eE' + _ll_b.getvalue() + '\x1f')
    raise
_ll_stop()
'''


class Link:
    """Connection to the Live Line extension (does nothing outside VSCodium)."""

    def __init__(self, path):
        self.s = None
        if path:
            try:
                self.s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                self.s.connect(path)
            except OSError:
                self.s = None

    def send(self, obj):
        if self.s:
            try:
                self.s.sendall((json.dumps(obj) + "\n").encode())
            except OSError:
                self.s = None


STDIN_FRAME = re.compile(rb'  File "<stdin>", line \d+, in <module>\r?\n')
FILE_LINE = re.compile(r'File "([^"]*)", line (\d+)')


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    port, path = sys.argv[1], os.path.abspath(sys.argv[2])
    name = os.path.basename(path)
    with open(path, encoding="utf-8") as f:
        src = f.read()
    code = WRAPPER % {"src": repr(instrument(src).encode("utf-8")), "name": name}
    fd, tmp = tempfile.mkstemp(prefix="liveline-", suffix=".py")
    with os.fdopen(fd, "w") as f:
        f.write(code)

    link = Link(os.environ.get("LIVELINE_SOCK"))
    link.send({"t": "start", "file": path})

    env = dict(os.environ)
    env.pop("LIVELINE_SOCK", None)   # mpremote itself is not "your code"
    proc = subprocess.Popen([sys.executable, "-m", "mpremote", "connect", port, "resume", "run", tmp],
                            stdout=subprocess.PIPE, env=env)
    # Ctrl-C in the terminal reaches mpremote directly; just don't die before it.
    signal.signal(signal.SIGINT, lambda *a: None)
    for sig in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, lambda *a: (proc.terminate(), os._exit(1)))

    out = sys.stdout.buffer
    buf = b""
    try:
        while True:
            try:
                chunk = os.read(proc.stdout.fileno(), 4096)
            except InterruptedError:
                continue
            if not chunk:
                break
            buf += chunk
            text = bytearray()
            while buf:
                i = buf.find(b"\x1e")
                if i < 0:
                    # keep a partial `  File "<stdin>"...` line until it is complete
                    nl = buf.rfind(b"\n") + 1
                    tail = buf[nl:]
                    if len(tail) >= 3 and b'  File "<stdin>"'.startswith(tail[:16]) and len(tail) < 80:
                        text += buf[:nl]
                        buf = tail
                    else:
                        text += buf
                        buf = b""
                    break
                text += buf[:i]
                j = buf.find(b"\x1f", i)
                if j < 0:
                    buf = buf[i:]
                    break
                marker(buf[i + 1:j].decode("utf-8", "replace"), path, name, link)
                buf = buf[j + 1:]
            if text:
                out.write(STDIN_FRAME.sub(b"", bytes(text)))
                out.flush()
        if buf:
            out.write(buf)
            out.flush()
    finally:
        rc = proc.wait()
        link.send({"t": "end"})
        try:
            os.unlink(tmp)
        except OSError:
            pass
    sys.exit(rc)


def marker(m, path, name, link):
    if m.startswith("L"):
        try:
            link.send({"t": "pos", "p": [[path, int(m[1:])]]})
        except ValueError:
            pass
    elif m.startswith("E"):
        tb = m[1:].replace("\r\n", "\n").rstrip()
        lines = [int(n) for f, n in FILE_LINE.findall(tb) if f == name]
        if not lines:
            return
        tb = "\n".join(l for l in tb.split("\n") if '"<stdin>"' not in l)
        msg = tb.split("\n")[-1].strip() if tb else "Error"
        link.send({"t": "err", "file": path, "line": lines[-1], "msg": msg, "tb": tb})


if __name__ == "__main__":
    main()
