"""Live Line hook for CPython (loaded by sitecustomize.py in VSCodium terminals).

Every 50 ms a background thread looks at where each thread of your program is
(sys._current_frames, the same thing py-spy does) and reports the deepest line
that belongs to your project. Nothing is traced, so your code runs at full speed.
Uncaught exceptions are reported with the exact line and columns.
"""
import os
import sys

_sock = None
_lock = None
_roots = []
_here = os.path.dirname(os.path.abspath(__file__))
_EXCLUDE = tuple(os.sep + d + os.sep for d in ("site-packages", "dist-packages", ".venv", "venv", "node_modules", "__pypackages__"))
_cache = {}
_started = False


def _under_roots(p):
    return any(p == r or p.startswith(r.rstrip(os.sep) + os.sep) for r in _roots)


def _mine(filename):
    """Absolute path if this file is part of the user's project, else False."""
    r = _cache.get(filename)
    if r is None:
        r = False
        if filename and not filename.startswith("<"):
            p = os.path.abspath(filename)
            if not p.startswith(_here + os.sep) and not any(e in p for e in _EXCLUDE) and _under_roots(p):
                r = p
        _cache[filename] = r
    return r


def _send(obj):
    global _sock
    s = _sock
    if s is None:
        return
    import json
    data = (json.dumps(obj) + "\n").encode("utf-8", "replace")
    with _lock:
        try:
            s.sendall(data)
        except OSError:
            _sock = None


def _start_once():
    global _started
    if not _started:
        _started = True
        _send({"t": "start", "file": _mine(sys.argv[0]) or os.path.abspath(sys.argv[0] or "."), "pid": os.getpid()})


def _sampler():
    import threading
    import time
    me = threading.get_ident()
    last = None
    while _sock is not None:
        time.sleep(0.05)
        try:
            frames = sys._current_frames()
        except Exception:
            return
        pos = set()
        for tid, f in frames.items():
            if tid == me:
                continue
            while f is not None:
                p = _mine(f.f_code.co_filename)
                if p:
                    pos.add((p, f.f_lineno))
                    break
                f = f.f_back
        del frames, f
        if not pos and not _started:
            continue
        pos = sorted(pos)
        if pos != last:
            _start_once()
            _send({"t": "pos", "p": pos})
            last = pos


def _char_col(file, lineno, byte_col):
    import linecache
    line = linecache.getline(file, lineno)
    return len(line.encode("utf-8")[:byte_col].decode("utf-8", "ignore"))


def _report(etype, value, tb, thread=None):
    if etype is None or issubclass(etype, (KeyboardInterrupt, SystemExit)):
        return
    import traceback
    best = None
    t = tb
    while t is not None:
        if _mine(t.tb_frame.f_code.co_filename):
            best = t
        t = t.tb_next
    msg = "".join(traceback.format_exception_only(etype, value)).strip().splitlines()[-1]
    err = {"t": "err", "msg": msg, "thread": thread,
           "tb": "".join(traceback.format_exception(etype, value, tb)).rstrip()}
    if best is not None:
        file = _mine(best.tb_frame.f_code.co_filename)
        err.update(file=file, line=best.tb_lineno)
        try:  # Python 3.11+: exact columns of the failing expression
            pos = list(best.tb_frame.f_code.co_positions())[best.tb_lasti // 2]
            ln, end_ln, col, end_col = pos
            if ln == best.tb_lineno and col is not None and end_col is not None:
                err.update(col=_char_col(file, ln, col), endLine=end_ln, endCol=_char_col(file, end_ln, end_col))
        except Exception:
            pass
    elif isinstance(value, SyntaxError) and value.filename and _mine(value.filename) and value.lineno:
        err.update(file=_mine(value.filename), line=value.lineno)
        if value.offset:
            err.update(col=value.offset - 1, endLine=getattr(value, "end_lineno", None) or value.lineno,
                       endCol=(getattr(value, "end_offset", None) or value.offset + 1) - 1)
    else:
        return
    _start_once()
    _send(err)


def install():
    global _sock, _lock, _roots
    sock_path = os.environ.get("LIVELINE_SOCK")
    _roots = [os.path.abspath(r) for r in os.environ.get("LIVELINE_ROOTS", "").split(os.pathsep) if r]
    if not sock_path or not _roots:
        return
    argv0 = sys.argv[0] if sys.argv else ""
    if argv0 == "-m":
        if not _under_roots(os.getcwd()):
            return
    elif not (argv0.endswith(".py") and _mine(argv0)) and os.environ.get("LIVELINE_FORCE") != "1":
        return   # REPL, python -c, tools outside the project ...
    os.environ.pop("LIVELINE_FORCE", None)

    import socket
    import threading
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.connect(sock_path)
    except OSError:
        return
    _sock, _lock = s, threading.Lock()

    def after_fork_child():
        global _sock
        _sock = None   # the child keeps running without Live Line

    os.register_at_fork(after_in_child=after_fork_child)

    old_hook = sys.excepthook

    def excepthook(etype, value, tb):
        try:
            _report(etype, value, tb)
        except Exception:
            pass
        old_hook(etype, value, tb)

    sys.excepthook = excepthook

    old_thook = threading.excepthook

    def thread_hook(args):
        try:
            _report(args.exc_type, args.exc_value, args.exc_traceback, thread=getattr(args.thread, "name", "thread"))
        except Exception:
            pass
        old_thook(args)

    threading.excepthook = thread_hook

    import atexit

    @atexit.register
    def _end():
        if _started:
            _send({"t": "end"})

    threading.Thread(target=_sampler, name="liveline", daemon=True).start()
