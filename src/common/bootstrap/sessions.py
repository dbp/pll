# Sessions and output.
#
# Each Python file gets its own session, keyed by an opaque string the host
# chooses (typically the document URI). Sessions hold their own globals
# dict, so file A's `data = ...` doesn't leak into file B's REPL prompt.
# `_pll_run_file` resets the addressed session's globals to the baseline
# template before executing; `_pll_repl_eval` does NOT reset, so REPL
# input keeps the names defined by the most recent Run File of the same
# session. The host ends a session, with `_pll_end_session`, when its file
# is closed.
#
# Output - text, images, tables - goes through `_pll_push`, live to the host
# during a file run and collected otherwise, so it arrives in the order the
# program produced it.

import json as _pll_json
import sys as _sys

# Must match PLL_WORK_DIR in memfsWorkspace.ts. Sibling files are mounted
# here and it is cwd, so open("cars.csv") works. It must not sit first on
# sys.path or a neighboring pandas.py wins over the real package.
_PLL_WORK_DIR = "/home/pyodide/pll_workspace"

def _pll_protect_import_path():
    """Keep sibling .py files from shadowing installed packages.

    Python puts '' (cwd) first on sys.path. After chdir to the work dir,
    import pandas would load a mounted pandas.py. Drop the empty entry,
    append the work dir so unique sibling modules still import, and evict
    anything already loaded from that folder (a failed pandas.py import
    leaves a poisoned sys.modules entry).
    """
    while "" in _sys.path:
        _sys.path.remove("")
    while _PLL_WORK_DIR in _sys.path:
        _sys.path.remove(_PLL_WORK_DIR)
    _sys.path.append(_PLL_WORK_DIR)
    prefix = _PLL_WORK_DIR + "/"
    for name, mod in list(_sys.modules.items()):
        filename = getattr(mod, "__file__", None)
        if isinstance(filename, str) and filename.startswith(prefix):
            _sys.modules.pop(name, None)

# Per-session globals dicts, keyed by session_key (e.g. document URI).
# Created lazily; initialized from `_pll_initial_globals`.
_pll_sessions = {}

# The "template" globals used to seed each new session and to reset a
# session at the start of every Run File. Populated by PYODIDE_INSTALL_PY
# at the end of bootstrap so the template includes the PLL image
# library + the auto-display helper.
_pll_initial_globals = {"__name__": "__main__", "__builtins__": __builtins__}

# Display emissions captured during the most recent `_pll_run_file` /
# `_pll_repl_eval` call. The host drains this list after the call.
# Each entry is a typed dict (`{"type": "stdout"|"stderr", "text": ...}`,
# `{"type": "image", ...}`, or `{"type": "table", ...}`) so the host can
# dispatch by kind while preserving the *exact* order in which the user's
# code produced them - that way a `print()` followed by a top-level table
# shows up as text-then-table in the interactions view, even though
# stdout and image/table emissions take different paths inside Python.
# Pyodide is single-threaded, so a single shared list is fine.
_pll_displays = []

# When set (by either host during a file run), this is a JS callback taking
# one JSON string. Every display payload — each stdout/stderr write, image,
# and table — is emitted through it as it is produced, so the interactions
# view updates *during* the run instead of only at the end. This is what
# lets an interactive program print a prompt before input() blocks.
# Left as None during REPL/tests, where output is delivered in one batch.
_pll_live_emit = None


def _pll_push(payload):
    """Emit a display payload live, or record it for the end of the run.

    Exactly one of the two: when a live hook is installed the host streams
    each payload as it happens and then discards `result["displays"]`
    (see `withLiveEmit` / the `runFile` case in workerHost.ts), so also
    accumulating them costs memory and a large FFI conversion for a list
    nobody reads. A program printing in a loop built a multi-million entry
    list that was copied and converted to JS purely to be dropped.
    """
    emit = _pll_live_emit
    if emit is None:
        _pll_displays.append(payload)
        return
    try:
        emit(_pll_json.dumps(payload))
    except Exception:
        pass


class _PllStream:
    """Drop-in replacement for `sys.stdout` / `sys.stderr` during a run.

    Each `write` pushes a typed entry onto `_pll_displays` so text
    output interleaves with image/table emissions. We also keep the
    aggregate string so `result["stdout"]` / `result["stderr"]` can
    still be inspected by smoke tests and any caller that just wants
    "what did the program print?".
    """

    __slots__ = ("_kind", "_chunks")

    def __init__(self, kind):
        self._kind = kind  # "stdout" or "stderr"
        self._chunks = []

    def write(self, s):
        if not isinstance(s, str):
            s = str(s)
        if s:
            _pll_push({"type": self._kind, "text": s})
            self._chunks.append(s)
        return len(s)

    def writelines(self, lines):
        for line in lines:
            self.write(line)

    def flush(self):
        pass

    def isatty(self):
        return False

    def getvalue(self):
        return "".join(self._chunks)


def _pll_extract_display(value):
    """Try every known display protocol on `value`.

    Returns a typed payload (`{"type": "image"|"table", ...}`) or None if
    `value` doesn't know how to display itself.
    """
    if hasattr(value, "_pll_table_data"):
        try:
            data = value._pll_table_data()
        except Exception:
            return None
        if isinstance(data, dict):
            data = dict(data)
            data["type"] = "table"
            return data
    if hasattr(value, "_pll_image_data"):
        try:
            data = value._pll_image_data()
        except Exception:
            return None
        # _pll_image_data historically uses {"type": "svg", ...}
        # internally; promote to the unified outer type.
        if isinstance(data, dict):
            payload = dict(data)
            payload["type"] = "image"
            payload["format"] = data.get("type", "svg")
            return payload
    return None


def _pll_show_top_level(value):
    """Emit a value produced by a top-level expression statement.

    Mirrors the behavior of Python's interactive shell: `None` is suppressed,
    PLL images and tables are captured for the host to render, anything
    else is printed via `repr` so bare expressions like `1 + 2` still display.
    """
    if value is None:
        return
    # A reactor pushed its own card when it was started; printing its repr
    # as well would be noise. Duck-typed like the display protocols, so the
    # bootstrap still knows nothing about reactorLib.
    if getattr(value, "_pll_already_displayed", False):
        return
    payload = _pll_extract_display(value)
    if payload is not None:
        _pll_push(payload)
        return
    print(repr(value))


# Seed the template with the auto-display helper. The image library names
# get added later by PYODIDE_INSTALL_PY.
_pll_initial_globals["_pll_show_top_level"] = _pll_show_top_level


def _pll_get_session(session_key):
    """Get-or-create the globals dict for `session_key`.

    Newly-created sessions start as a copy of `_pll_initial_globals`
    (so all baseline names like the image primitives are present).
    """
    g = _pll_sessions.get(session_key)
    if g is None:
        g = dict(_pll_initial_globals)
        _pll_sessions[session_key] = g
    return g


def _pll_end_session(session_key):
    """Forget `session_key` and everything its runs defined: its file is closed."""
    _pll_sessions.pop(session_key, None)


def _pll_reset_session(session_key):
    """Reset the globals for `session_key` to the baseline template.

    Mutates the existing dict in place (`clear` + `update`) so any cached
    reference to it (e.g. from `_pll_show_top_level`'s closure or from
    Pyodide's `globals.get(...)`) remains valid.
    """
    g = _pll_get_session(session_key)
    g.clear()
    g.update(_pll_initial_globals)
    return g
