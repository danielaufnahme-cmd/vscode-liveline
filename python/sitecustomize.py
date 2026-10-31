# Live Line (VSCodium extension): VSCodium terminals put this folder on PYTHONPATH.
# For your own scripts it reports which line runs right now, and where it crashed.
# Does nothing outside VSCodium. Any other sitecustomize.py is still loaded after it.
def _liveline():
    import os
    import sys
    if os.environ.get("LIVELINE_SOCK"):
        try:
            import _liveline_cpy
            _liveline_cpy.install()
        except Exception:
            pass
    # Chain to the next sitecustomize on sys.path, if any (venvs, distro builds).
    try:
        import importlib.machinery
        import importlib.util
        here = os.path.dirname(os.path.abspath(__file__))
        rest = [p for p in sys.path if os.path.abspath(p or ".") != here]
        spec = importlib.machinery.PathFinder.find_spec("sitecustomize", rest)
        if spec and spec.origin and os.path.abspath(spec.origin) != os.path.abspath(__file__):
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
    except Exception:
        pass


_liveline()
del _liveline
