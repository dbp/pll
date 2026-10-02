# Python Language Levels runtime bootstrap.
#
# This module is loaded into Pyodide once when the runtime initializes.
# It exposes four entry points used by the TypeScript host:
#
#   _pll_run_file(code, filename, session_key, level="raw")      -> dict
#   _pll_repl_eval(code, session_key, level="raw")               -> dict
#   _pll_repl_check(source)                      -> dict
#   _pll_has_tests(code)                         -> bool
#   _pll_run_tests(code, filename, level="raw")                  -> dict
#   _pll_static_analyze(code, level, filename, session_key=None) -> list[dict]
#
# The level is the only knob: it decides both the static checks and whether
# annotations are instrumented. `raw` is plain Python plus PLL's libraries.
#
# Each returns a JSON-friendly dict / list of dicts so the JS side can
# consume the result via `proxy.toJs({ dict_converter: Object.fromEntries })`.
#
# Sessions
# --------
# Each Python file gets its own session, keyed by an opaque string the host
# chooses (typically the document URI). Sessions hold their own globals
# dict, so file A's `data = ...` doesn't leak into file B's REPL prompt.
# `_pll_run_file` resets the addressed session's globals to the baseline
# template before executing; `_pll_repl_eval` does NOT reset, so REPL
# input keeps the names defined by the most recent Run File of the same
# session.

import traceback as _tb_mod
import ast as _ast
import copy as _pll_copy
import codeop as _codeop
import contextlib
import json as _pll_json
import sys as _sys
import types as _pll_types
import builtins as _builtins_mod
import warnings as _pll_warnings
import re as _pll_src_re

# Must match PLL_WORK_DIR in memfsWorkspace.ts. Sibling files are mounted
# here and it is cwd, so open("cars.csv") works. It must not sit first on
# sys.path or a neighboring pandas.py wins over the real package.
_PLL_WORK_DIR = "/home/pyodide/pll_workspace"

# Vendored pure-Python wheels (typeguard + typing_extensions) that the
# worker writes into MEMFS before calling `_pll_enable_type_checking`.
# Must match PLL_VENDOR_DIR in pythonVendor.ts.
_PLL_VENDOR_DIR = "/pll_vendor"

# Set by `_pll_enable_type_checking`. While False, `_pll_instrument_types`
# leaves code untouched, so a program still runs - just unchecked.
_PLL_TYPEGUARD_READY = False
_pll_typeguard_transformer = None
_pll_type_check_error = None

# Whether a bool is rejected where int / float is annotated. Set per run
# from the language level; see `levelRejectsBoolAsNumber` in level.ts.
# Python counts True as 1 and both mypy and typeguard follow it, which is a
# hole at the teaching levels: a student who annotates `int` and passes
# `True` has almost always made a mistake. `advanced` keeps Python's rule.
_PLL_STRICT_NUMBERS = False

# Whether annotations are instrumented at all. Set per run from the language
# level; see `levelHasTypeChecking` in level.ts. False only at `#level raw`,
# which exists so a file can opt out. There is no separate setting: the level
# is the single input, so nothing can disagree with it.
_PLL_TYPE_CHECK = False


def _pll_check_strict_int(value, origin_type, args, memo):
    """Replaces typeguard's `int` check; bools are not whole numbers here.

    The wording matches typeguard's own so the host-side explainer needs
    no special case: it sees the actual type (bool) and the expected one.
    """
    if isinstance(value, bool) or not isinstance(value, int):
        raise _pll_type_check_error("is not an instance of int")


def _pll_check_strict_float(value, origin_type, args, memo):
    """As `_pll_check_strict_int`, for the int-or-float numeric tower."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _pll_type_check_error("is neither float or int")


def _pll_strict_number_lookup(origin_type, args, extras):
    """typeguard checker lookup; consulted on every check, so the flag
    can be flipped per run without re-registering."""
    if not _PLL_STRICT_NUMBERS:
        return None
    if origin_type is int:
        return _pll_check_strict_int
    if origin_type is float:
        return _pll_check_strict_float
    return None


def _pll_apply_level(level):
    """Set the per-run strictness implied by the language level.

    The level is the only input. `raw` checks nothing; `advanced` checks
    annotations by Python's own rules; the two teaching levels additionally
    reject a bool where a number is annotated. Must agree with level.ts.
    """
    global _PLL_STRICT_NUMBERS, _PLL_TYPE_CHECK
    _PLL_TYPE_CHECK = level != "raw"
    _PLL_STRICT_NUMBERS = level in ("beginner", "intermediate")


def _pll_enable_type_checking():
    """Put the vendored wheels on sys.path and import typeguard.

    Returns True when runtime type checking is available. A failure here
    is deliberately not fatal: students' code must still run, so the
    feature degrades to "no type checks" rather than breaking the editor.
    """
    global _PLL_TYPEGUARD_READY, _pll_typeguard_transformer, _pll_type_check_error
    if _PLL_TYPEGUARD_READY:
        return True
    try:
        for name in ("typing_extensions.whl", "typeguard.whl"):
            path = _PLL_VENDOR_DIR + "/" + name
            # Appended, not prepended: a real package in site-packages
            # (Pyodide ships typing_extensions too) should still win.
            if path not in _sys.path:
                _sys.path.append(path)
        from typeguard import TypeCheckError, TypeCheckMemo
        from typeguard._checkers import checker_lookup_functions
        from typeguard._config import CollectionCheckStrategy, global_config
        from typeguard._functions import check_variable_assignment
        from typeguard._transformer import TypeguardTransformer

        # `list[int]` should mean *every* item is an int. typeguard only
        # checks the first item by default, which silently accepts
        # [1, 2, "three"] - confusing when the annotation says otherwise.
        global_config.collection_check_strategy = CollectionCheckStrategy.ALL_ITEMS

        # Referenced by name in the AST that `_PllTopLevelAnnAssign`
        # injects, so they have to be visible in user globals.
        _pll_initial_globals["_pll_tg_memo"] = TypeCheckMemo
        _pll_initial_globals["_pll_tg_check_assign"] = check_variable_assignment
        # Referenced by name in the AST that `_PllDataclassChecks` injects.
        _pll_initial_globals["_pll_check_dataclass_fields"] = _pll_check_dataclass_fields
        # Consulted before typeguard's builtin lookup, and gated on
        # `_PLL_STRICT_NUMBERS` so it is a no-op at `advanced`.
        _pll_type_check_error = TypeCheckError
        if _pll_strict_number_lookup not in checker_lookup_functions:
            checker_lookup_functions.insert(0, _pll_strict_number_lookup)

        _pll_typeguard_transformer = TypeguardTransformer
        _PLL_TYPEGUARD_READY = True
    except BaseException:
        _PLL_TYPEGUARD_READY = False
    return _PLL_TYPEGUARD_READY


def _pll_is_vendor_frame(filename):
    return isinstance(filename, str) and filename.startswith(_PLL_VENDOR_DIR)


#: An element failure on an argument: `item 0 of argument "lst" (list) ...`
#: or `value of key 'a' of argument "d" (dict) ...`.
_PLL_ELEMENT_FAILURE_RE = _pll_src_re.compile(
    r'^(item (\d+)|value of key (.+?)) of argument "(\w+)" '
)


def _pll_enrich_index_error(exc, code):
    """Add how long the list really is to an `IndexError`.

    "list index out of range" says nothing about the list, and the
    explanation was left to illustrate with a made-up list of 3. The frame
    the error was raised in holds the real one, and the line says which
    name was subscripted.
    """
    if type(exc) is not IndexError or "out of range" not in str(exc):
        return
    tb = exc.__traceback__
    frame = lineno = None
    while tb is not None:
        filename = tb.tb_frame.f_code.co_filename
        if not _pll_is_vendor_frame(filename) and filename != "<exec>":
            frame, lineno = tb.tb_frame, tb.tb_lineno
        tb = tb.tb_next
    if frame is None or not code:
        return
    lines = code.split("\n")
    if not 0 < lineno <= len(lines):
        return
    for name in _pll_src_re.findall(r"([A-Za-z_]\w*)\s*\[", lines[lineno - 1]):
        value = frame.f_locals.get(name, frame.f_globals.get(name))
        if isinstance(value, (list, tuple, str)):
            exc.args = (
                "%s\n  -> %s has %d item%s" % (
                    exc.args[0] if exc.args else str(exc),
                    name,
                    len(value),
                    "" if len(value) == 1 else "s",
                ),
            )
            return


def _pll_enrich_type_check(exc):
    """Add what the offending element actually is to an element failure.

    typeguard names the element that failed - "item 0 of argument "lst"
    (list) is not an instance of float" - but not what it is, which is the
    one thing a student needs to see: here, the string "1". The value is
    only reachable from the frame the check fired in, so it is read from
    there and added as an indented `->` line, which the host reads and
    which cannot be mistaken for one of a union's member lines.

    Only frames from the student's own file are searched: typeguard's own
    functions have locals with ordinary names like `value`, and finding one
    of those first would describe the wrong thing.
    """
    if type(exc).__name__ != "TypeCheckError" or not exc.args:
        return
    match = _PLL_ELEMENT_FAILURE_RE.match(str(exc))
    if match is None:
        return
    name = match.group(4)
    frames = []
    tb = exc.__traceback__
    while tb is not None:
        frames.append(tb.tb_frame)
        tb = tb.tb_next
    container = None
    found = False
    for frame in reversed(frames):
        filename = frame.f_code.co_filename
        if _pll_is_vendor_frame(filename) or filename == "<exec>":
            continue
        if name in frame.f_locals:
            container = frame.f_locals[name]
            found = True
            break
    if not found:
        return
    try:
        if match.group(2) is not None:
            element = container[int(match.group(2))]
        else:
            element = container[_ast.literal_eval(match.group(3))]
    except Exception:
        return
    describe = globals().get("_pll_describe")
    if describe is None:
        return
    exc.args = (
        "%s\n  -> %s is %s" % (exc.args[0], match.group(1), describe(element)),
    ) + tuple(exc.args[1:])


def _pll_format_exception(exc):
    """`format_exception`, minus frames inside the vendored type checker.

    A typeguard failure otherwise ends in several frames of typeguard's
    own checker, burying the student's line under machinery they did not
    write. When nothing is dropped this returns the stdlib formatting
    unchanged, so ordinary errors look exactly as they did before.
    """
    try:
        frames = _tb_mod.extract_tb(exc.__traceback__)
        kept = [f for f in frames if not _pll_is_vendor_frame(f.filename)]
        if len(kept) == len(frames):
            return "".join(_tb_mod.format_exception(type(exc), exc, exc.__traceback__))
        parts = ["Traceback (most recent call last):\n"]
        parts.extend(_tb_mod.StackSummary.from_list(kept).format())
        parts.extend(_tb_mod.format_exception_only(type(exc), exc))
        return "".join(parts)
    except BaseException:
        return "".join(_tb_mod.format_exception(type(exc), exc, exc.__traceback__))


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


# -----------------------------------------------------------------------------
# Stop
# -----------------------------------------------------------------------------

#: The worker's view of the interrupt buffer, set after this file loads, or
#: None when the host has no shared memory (and so no Stop at all). See
#: `interruptBuffer.ts` for the layout: byte 1 is the acknowledgement.
_pll_interrupt_view = None


def _pll_on_sigint(signum, frame):
    """Deliver a Stop as `KeyboardInterrupt`, once, and say it was delivered.

    Pyodide's check can overwrite a Stop that arrives at the wrong moment,
    so the host re-asserts it until it is acknowledged. Two jobs follow:

      - acknowledge, by setting byte 1, so the host stops re-asserting;
      - ignore a repeat of a Stop already delivered. The host can store one
        more signal just before it sees the acknowledgement, and raising it
        would land a second `KeyboardInterrupt` in PLL's own clean-up after
        the first, turning a clean stop into an internal error.

    A new press clears byte 1 first, so a program that caught the first
    `KeyboardInterrupt` and carried on can still be stopped.
    """
    view = _pll_interrupt_view
    if view is not None:
        try:
            if view[1]:
                return
            view[1] = 1
        except Exception:
            # A buffer without the second byte: an older host. Behave as
            # Python always has.
            pass
    raise KeyboardInterrupt


def _pll_install_sigint():
    """Route SIGINT through `_pll_on_sigint`. Called once, at load."""
    try:
        import signal as _pll_signal

        _pll_signal.signal(_pll_signal.SIGINT, _pll_on_sigint)
    except Exception:
        # No signal support: the default handler still raises.
        pass


_pll_install_sigint()


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


class _PllTopLevelAnnAssign(_ast.NodeTransformer):
    """Type-check annotated assignments outside functions.

    typeguard instruments function arguments, return values, and
    annotated assignments *inside* functions, but leaves
    `total: int = "oops"` at module level unchecked. Students write those,
    so we wrap the value in typeguard's own check to get the same wording.

    Function and class bodies are skipped: typeguard already covers
    functions, and a bare `name: str` in a class body is a field
    declaration (dataclasses, etc.) rather than an assignment.
    """

    def visit_FunctionDef(self, node):
        return node

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_ClassDef(self, node):
        return node

    def visit_AnnAssign(self, node):
        if node.value is None or not isinstance(node.target, _ast.Name):
            return node
        node.value = self._checked(node.target.id, node.value, node.annotation)
        return node

    def _checked(self, name, value, annotation):
        """`value` -> `_pll_tg_check_assign(value, [(name, ann)], memo)`."""
        memo = _ast.Call(
            func=_ast.Name(id="_pll_tg_memo", ctx=_ast.Load()),
            args=[
                _ast.Call(func=_ast.Name(id="globals", ctx=_ast.Load()), args=[], keywords=[]),
                _ast.Call(func=_ast.Name(id="locals", ctx=_ast.Load()), args=[], keywords=[]),
            ],
            keywords=[],
        )
        target = _ast.Tuple(
            elts=[_ast.Constant(value=name), _pll_copy.deepcopy(annotation)],
            ctx=_ast.Load(),
        )
        call = _ast.Call(
            func=_ast.Name(id="_pll_tg_check_assign", ctx=_ast.Load()),
            args=[value, _ast.List(elts=[target], ctx=_ast.Load()), memo],
            keywords=[],
        )
        _ast.copy_location(call, value)
        _ast.fix_missing_locations(call)
        return call


def _pll_is_dataclass_decorator(node):
    """True for `@dataclass`, `@dataclasses.dataclass` and calls to either."""
    if isinstance(node, _ast.Call):
        node = node.func
    if isinstance(node, _ast.Name):
        return node.id == "dataclass"
    if isinstance(node, _ast.Attribute):
        return node.attr == "dataclass"
    return False


class _PllDataclassChecks(_ast.NodeTransformer):
    """Have every `@dataclass` check its field types when constructed.

    typeguard instruments what it can see in the source, but `@dataclass`
    writes `__init__` *afterwards* - so `Dog(5, 3)` with `name: str` was
    accepted without a word, which is the opposite of the point at
    `#level beginner`.

    The checker goes on the front of the decorator list, which makes it the
    outermost one and therefore the last to run, so it sees the `__init__`
    that `@dataclass` generated rather than the class before it existed.
    """

    def visit_ClassDef(self, node):
        self.generic_visit(node)
        if any(_pll_is_dataclass_decorator(d) for d in node.decorator_list):
            node.decorator_list.insert(
                0, _ast.Name(id="_pll_check_dataclass_fields", ctx=_ast.Load())
            )
        return node


def _pll_hint_name(hint):
    """An annotation as it was written, as near as can be recovered."""
    name = getattr(hint, "__name__", None)
    if isinstance(name, str):
        return name
    return str(hint).replace("typing.", "")


def _pll_swapped_field(instance, hints, field_name):
    """Another field whose value fits here, while this value fits there.

    `ITunesSong("Yesterday", 2015, "The Beatles")` gives `singer` a number
    and `year` a string. Advising `str(...)` for the singer would make the
    error go away and the song wrong; what happened is that two values were
    written in each other's places.
    """
    import typing as _pll_typing

    def fits(value, hint):
        origin = _pll_typing.get_origin(hint) or hint
        if not isinstance(origin, type):
            return False
        if origin is float and isinstance(value, int) and not isinstance(value, bool):
            return True
        return isinstance(value, origin) and not (
            origin is int and isinstance(value, bool)
        )

    mine = getattr(instance, field_name)
    for other, other_hint in hints.items():
        if other == field_name or not hasattr(instance, other):
            continue
        theirs = getattr(instance, other)
        if fits(mine, other_hint) and fits(theirs, hints[field_name]):
            return other
    return None


def _pll_check_dataclass_fields(cls):
    """Wrap a dataclass's `__init__` so its fields are checked.

    Checked after the original `__init__` has run, so defaults,
    `field(default_factory=...)` and `__post_init__` have all had their
    say and the values checked are the ones the instance really holds.

    Annotations are resolved at construction rather than at decoration,
    because a recursive definition names a class that does not exist yet
    (`rest: "NumList"`). A resolution that fails is not cached: it may well
    succeed once the rest of the file has run.

    The namespace to resolve them in is taken from the frame that applied
    the decorator - the student's own globals - and not left to
    `get_type_hints`, which would look up `sys.modules[cls.__module__]`.
    That is Pyodide's `__main__`, a different dict from the session's, so
    every recursive annotation failed to resolve and its field went
    unchecked.
    """
    if not _PLL_TYPE_CHECK or not _PLL_TYPEGUARD_READY:
        return cls
    memo_type = _pll_initial_globals.get("_pll_tg_memo")
    check = _pll_initial_globals.get("_pll_tg_check_assign")
    if memo_type is None or check is None:
        return cls

    try:
        defining_globals = _sys._getframe(1).f_globals
    except Exception:
        defining_globals = getattr(_sys.modules.get(cls.__module__), "__dict__", {})

    original = cls.__init__
    cache = []

    def __init__(self, *args, **kwargs):
        original(self, *args, **kwargs)
        if not cache:
            import typing as _pll_typing

            try:
                cache.append(
                    _pll_typing.get_type_hints(cls, globalns=dict(defining_globals))
                )
            except Exception:
                # Not resolvable yet (or at all). Construct without
                # checking rather than failing on the annotation.
                return
        memo = memo_type(defining_globals, {})
        for field_name, hint in cache[0].items():
            if not hasattr(self, field_name):
                continue
            try:
                check(getattr(self, field_name), [(field_name, hint)], memo)
            except _pll_type_check_error:
                # typeguard words this as an assignment ("value assigned to
                # singer"), because that is the check being reused. Nobody
                # assigned anything: a field of a value was the wrong type,
                # and the value is only known here.
                bad = getattr(self, field_name)
                shown = '"%s"' % bad if isinstance(bad, str) and '"' not in bad else repr(bad)
                swapped = _pll_swapped_field(self, cache[0], field_name)
                raise _pll_type_check_error(
                    "field %r of %r got %s (%s), not %s%s"
                    % (
                        field_name,
                        cls.__name__,
                        shown,
                        type(bad).__name__,
                        _pll_hint_name(hint),
                        "\n  -> swapped with %s" % swapped if swapped else "",
                    )
                ) from None

    __init__.__name__ = "__init__"
    __init__.__qualname__ = "%s.__init__" % cls.__qualname__
    cls.__init__ = __init__
    return cls


#: Compile-time warnings for the current file: `(line, message)`, each once.
_pll_compile_warnings = []


@contextlib.contextmanager
def _pll_recording_compile_warnings():
    """Record `SyntaxWarning`s from PLL's own compiles instead of printing them.

    Every phase compiles the file more than once - the type-check
    instrumentation is validated by compiling it, then the real compile
    follows, and the test phase does both again - and Python prints a
    `SyntaxWarning` on every one. A missing comma between two table rows
    came out four times, beside a finding that already explained it.

    Recorded here and said once, after the run, by
    `_pll_say_compile_warnings`. Any other kind of warning is not PLL's to
    swallow, and is issued again exactly as it was.
    """
    caught = []
    try:
        with _pll_warnings.catch_warnings(record=True) as log:
            _pll_warnings.simplefilter("always", SyntaxWarning)
            try:
                yield
            finally:
                # Copied before `catch_warnings` restores the filters, so a
                # compile that raises still has its warnings kept.
                caught.extend(log)
    finally:
        for warning in caught:
            if issubclass(warning.category, SyntaxWarning):
                entry = (warning.lineno, str(warning.message))
                if entry not in _pll_compile_warnings:
                    _pll_compile_warnings.append(entry)
            else:
                _pll_warnings.warn_explicit(
                    warning.message, warning.category, warning.filename, warning.lineno
                )


def _pll_say_compile_warnings(stream, error_message, source=""):
    """Say each recorded warning once - unless the run's error already did.

    A warning that predicts the error the run then raised (`'int' object is
    not callable; perhaps you missed a comma?` before `TypeError: 'int'
    object is not callable`) is covered by the finding for that error, and
    printing it beside the finding says the same thing worse. One whose
    line never ran is the only sign of the mistake, so that one is said.
    """
    lines = source.split("\n") if source else []
    for lineno, message in _pll_compile_warnings:
        if error_message and message.startswith(error_message):
            continue
        text = lines[lineno - 1] if isinstance(lineno, int) and 0 < lineno <= len(lines) else ""
        stream.write("warning: line %s: %s\n" % (lineno, _pll_reword_warning(message, text)))
    del _pll_compile_warnings[:]


def _pll_reword_warning(message, line=""):
    """Python's wording, except where it points the wrong way.

    "'int' object is not callable; perhaps you missed a comma?" is Python's
    guess for `3(width)`, and for a number the guess is wrong: what is
    missing is a `*`. For a string or a tuple the comma guess is usually
    right - a list of rows with one comma left out - so those stay.

    The example is taken from the student's own line when it can be read,
    rather than one fixed example shown whatever they wrote.
    """
    if not _pll_src_re.match(
        r"'(int|float)' object is not callable; perhaps you missed a comma\?", message
    ):
        return message
    written = _pll_src_re.search(r"(\d+(?:\.\d+)?)\s*\(([^()]*)\)", line)
    if written is None:
        return (
            "brackets after a number are a function call, not multiplication. "
            "To multiply, write a `*` between them."
        )
    number, inside = written.group(1), written.group(2).strip()
    return (
        "brackets after a number are a function call, not multiplication. "
        "To multiply, write the `*`: `%s * %s`, not `%s`."
        % (number, inside or "...", written.group(0))
    )


def _pll_parse_and_instrument(code, filename):
    """Parse `code`, adding runtime type checks when they are available.

    Whether to check at all comes from `_PLL_TYPE_CHECK`, which
    `_pll_apply_level` sets from the level before this is called.

    Instrumentation is attempted on a second parse and validated by
    compiling it, so anything typeguard cannot handle falls back to the
    plain tree rather than failing the run.
    """
    tree = _ast.parse(code, filename=filename, mode="exec")
    if not _PLL_TYPE_CHECK or not _PLL_TYPEGUARD_READY:
        return tree
    try:
        instrumented = _ast.parse(code, filename=filename, mode="exec")
        _pll_typeguard_transformer().visit(instrumented)
        _PllTopLevelAnnAssign().visit(instrumented)
        _PllDataclassChecks().visit(instrumented)
        _ast.fix_missing_locations(instrumented)
        with _pll_recording_compile_warnings():
            compile(instrumented, filename, "exec")
        return instrumented
    except BaseException:
        return tree


class _PllTopLevelExprWrapper(_ast.NodeTransformer):
    """Wrap module-level expression statements so they auto-display.

    Skips the conventional module docstring (a string literal as the first
    statement) and bare `None` / `...` constants which are usually noise.
    """

    def visit_Module(self, node):
        new_body = []
        for i, stmt in enumerate(node.body):
            if isinstance(stmt, _ast.Expr) and not _pll_should_skip_expr(stmt, i):
                call = _ast.Call(
                    func=_ast.Name(id="_pll_show_top_level", ctx=_ast.Load()),
                    args=[stmt.value],
                    keywords=[],
                )
                wrapped = _ast.Expr(value=call)
                _ast.copy_location(wrapped, stmt)
                _ast.fix_missing_locations(wrapped)
                new_body.append(wrapped)
            else:
                new_body.append(stmt)
        node.body = new_body
        return node


def _pll_should_skip_expr(stmt, index):
    value = stmt.value
    if isinstance(value, _ast.Constant):
        if index == 0 and isinstance(value.value, str):
            return True  # module docstring
        if value.value is None or value.value is Ellipsis:
            return True
    return False


# -----------------------------------------------------------------------------
# Reading a source that is either a URL or a file next to the program
# -----------------------------------------------------------------------------
#
# Shared by `load_table` and `load_image`, so "https:// means the network,
# anything else means a file" is decided in exactly one place and both report
# the same way when it goes wrong. It lives in the bootstrap because the
# libraries are exec'd into these globals afterwards, in the same way
# examplarLib borrows `_pll_fix_ast_ranges`. (`re` itself is imported at the
# top of the file, with the rest.)

def _pll_describe(value):
    """A value as a student would name it, for a message about it.

    One copy, here, because the image and table libraries are exec'd into
    these same globals: two definitions meant the second silently replaced
    the first, and whichever lost its turn stopped recognising its own
    types. An image was then described as `a _Rectangle`, naming a class
    nobody wrote.

    Images and tables are recognised by the same duck-typing the display
    code uses, so the bootstrap still does not depend on either library.
    """
    if value is None:
        return "None"
    if isinstance(value, bool):
        return "%s" % value
    if isinstance(value, str):
        return 'the string "%s"' % value
    if isinstance(value, (int, float)):
        return "the number %s" % _pll_number(value)
    if hasattr(value, "_pll_image_data"):
        return "an image"
    if hasattr(value, "_pll_table_data"):
        return "a table"
    if isinstance(value, dict):
        return "a row" if type(value).__name__ == "Row" else "a dictionary"
    if isinstance(value, (list, tuple)):
        return "a list of %d" % len(value)
    if callable(value):
        return "the function `%s`" % getattr(value, "__name__", "given")
    name = type(value).__name__
    # A private class is PLL's own; a student has no name for it but the
    # thing it is.
    return "a value" if name.startswith("_") else "a %s" % name


def _pll_number(value):
    """`20`, not `20.0`, for a number in a message."""
    if isinstance(value, float) and value == int(value):
        return "%d" % int(value)
    return "%s" % value


def _pll_edit_distance(a, b):
    """Edit distance, counting a swap of two neighbours as one mistake.

    Plain Levenshtein charges two for `yaer` -> `year`, which is enough to
    push the commonest typo of all past any threshold tight enough to be
    useful. Lives here because the bootstrap is loaded before the image,
    table and reactor libraries, all of which suggest a name the student
    probably meant.
    """
    previous = list(range(len(b) + 1))
    two_back = []
    for i in range(1, len(a) + 1):
        current = [i] + [0] * len(b)
        for j in range(1, len(b) + 1):
            current[j] = min(
                previous[j] + 1,
                current[j - 1] + 1,
                previous[j - 1] + (0 if a[i - 1] == b[j - 1] else 1),
            )
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                current[j] = min(current[j], two_back[j - 2] + 1)
        two_back = previous
        previous = current
    return previous[len(b)]


def _pll_closest_name(name, candidates):
    """The candidate `name` was probably meant to be, or None.

    Close enough to be a misspelling rather than a different word: a third
    of the name's length, which covers `yaer` and `outilne` without
    turning an unrelated word into a confident guess.
    """
    if not isinstance(name, str):
        return None
    best = None
    best_distance = None
    # Sorted, so two candidates the same distance away always give the same
    # answer: a set's own order is arbitrary and can differ between runs.
    for candidate in sorted(candidates):
        distance = _pll_edit_distance(name.lower(), candidate.lower())
        if best_distance is None or distance < best_distance:
            best = candidate
            best_distance = distance
    if best is None:
        return None
    return best if best_distance <= max(1, len(best) // 3) else None


_PLL_SCHEME_RE = _pll_src_re.compile(r"^([A-Za-z][A-Za-z0-9+.\-]*)://")


def _pll_source_is_url(source):
    """True when `source` names an address rather than a file."""
    match = _PLL_SCHEME_RE.match(source)
    return match is not None and match.group(1).lower() in ("http", "https")


def _pll_fetch_bytes(url, what):
    """GET `url` synchronously and return the body as bytes.

    Uses `XMLHttpRequest` rather than `pyodide.http.open_url`, because that
    decodes to text and an image is bytes - one path has to serve both.
    Synchronous XHR is fine here: Pyodide runs in a worker, never on a
    page's main thread.

    `overrideMimeType` is what keeps this portable. A browser would decode
    the body as UTF-8 and mangle every byte above 0x7f, so it is asked for
    `x-user-defined`, which maps bytes 0x80-0xff to U+F780-U+F7FF; masking
    with 0xff undoes that. On the desktop the polyfill ignores the call and
    hands back latin-1, where the mask is the identity. Same two lines of
    Python either way.
    """
    try:
        from js import XMLHttpRequest as _Xhr
    except ImportError:
        raise OSError(
            "%s cannot reach the network, so it cannot read %s." % (what, url)
        ) from None
    xhr = _Xhr.new()
    try:
        xhr.open("GET", url, False)
        xhr.overrideMimeType("text/plain; charset=x-user-defined")
        xhr.send(None)
    except Exception as e:
        # A failed cross-origin request looks like this, and it is the most
        # likely cause by far, so say so rather than repeating the browser's
        # famously unhelpful wording.
        raise OSError(
            "%s could not reach %s (%s). If that address is not your own, it "
            "may not allow other sites to read it." % (what, url, e)
        ) from None
    if xhr.status != 200:
        raise OSError(
            "%s could not read %s: the server answered %d."
            % (what, url, xhr.status)
        )
    return bytes(ord(c) & 0xFF for c in xhr.responseText)


def _pll_nearby_files(wanted):
    """" The files here are: cars.csv, trips.csv.", when there are any.

    A missing file is usually a misspelling or a file in another folder,
    and both are obvious the moment the actual names are in front of you.
    Only files with the same extension are listed, so asking for a CSV
    does not produce a directory listing of the whole project.
    """
    import os as _pll_os

    folder = _pll_os.path.dirname(wanted) or "."
    _, extension = _pll_os.path.splitext(wanted)
    try:
        names = sorted(
            name
            for name in _pll_os.listdir(folder)
            if not extension or name.lower().endswith(extension.lower())
        )
    except OSError:
        return ""
    if not names:
        return ""
    # A misspelling is the usual reason, and then one name is the answer.
    close = _pll_closest_name(_pll_os.path.basename(wanted), names)
    if close is not None:
        return ' Did you mean "%s"?' % close
    shown = names[:8]
    label = extension.lstrip(".").upper() + " " if extension else ""
    return " The %sfiles next to your program are: %s%s." % (
        label,
        ", ".join(shown),
        ", ..." if len(names) > len(shown) else "",
    )


def _pll_read_source(source, what, binary=False):
    """Read `source` - a URL or a path beside the program - and return it.

    Returns bytes when `binary`, otherwise text decoded as UTF-8.
    """
    if not isinstance(source, str):
        raise TypeError(
            "%s needs a file name or a URL as a string, not %r"
            % (what, type(source).__name__)
        )
    stripped = source.strip()
    if not stripped:
        raise ValueError("%s needs a file name or a URL; got an empty string" % what)

    if _pll_source_is_url(stripped):
        data = _pll_fetch_bytes(stripped, what)
    else:
        scheme = _PLL_SCHEME_RE.match(stripped)
        if scheme is not None:
            raise ValueError(
                "%s can read an https:// address or a file next to your "
                "program, but not a %s:// one." % (what, scheme.group(1))
            )
        try:
            with open(stripped, "rb") as handle:
                data = handle.read()
        except FileNotFoundError:
            nearby = _pll_nearby_files(stripped)
            raise FileNotFoundError(
                'There is no file called "%s" next to your program.%s'
                % (
                    stripped,
                    # A close name answers it; otherwise, say what to check.
                    nearby
                    if nearby.startswith(" Did you mean")
                    else nearby + " Check the spelling, or pass an https:// address instead.",
                )
            ) from None
        except IsADirectoryError:
            raise IsADirectoryError('"%s" is a folder, not a file.' % stripped) from None
    if binary:
        return data
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        raise ValueError(
            "%s could not read %r as text - it does not look like a text file."
            % (what, source)
        ) from None


# -----------------------------------------------------------------------------
# REPL syntax check (codeop.compile_command in 'single' mode)
# -----------------------------------------------------------------------------

def _pll_repl_check(source):
    """Return whether 'source' is a complete REPL input.

    Mirrors what CPython's interactive shell does: uses codeop.compile_command
    in 'single' mode, which returns None for incomplete input (e.g. open
    parens, unfinished block) and raises SyntaxError for actually-broken code.
    """
    try:
        result = _codeop.compile_command(source, "<repl>", "single")
    except (SyntaxError, OverflowError, ValueError) as e:
        return {
            "status": "invalid",
            "error_type": type(e).__name__,
            "message": str(e),
            "lineno": getattr(e, "lineno", None) or 0,
            "offset": (e.offset - 1) if isinstance(e, SyntaxError) and e.offset else 0,
        }
    if result is None:
        return {"status": "incomplete"}
    return {"status": "complete"}


# -----------------------------------------------------------------------------
# Run a whole file (with output capture and traceback extraction)
# -----------------------------------------------------------------------------

def _pll_extract_loc(tb_str, fallback_filename):
    line_no = None
    col = None
    for raw in reversed(tb_str.splitlines()):
        line = raw.strip()
        if line.startswith('File "') and ", line " in line:
            try:
                rest = line.split(", line ", 1)[1]
                num_part = rest.split(",", 1)[0].strip()
                line_no = int(num_part)
            except Exception:
                line_no = None
            break
    if line_no is None and fallback_filename:
        for raw in tb_str.splitlines():
            if fallback_filename in raw and ", line " in raw:
                try:
                    rest = raw.split(", line ", 1)[1]
                    num_part = rest.split(",", 1)[0].strip()
                    line_no = int(num_part)
                except Exception:
                    pass
                break
    return line_no, col


def _pll_reset_notes():
    """Forget anything the last run had to say at the end of it."""
    reset = globals().get("_pll_reset_reactor_notes")
    if reset is not None:
        reset()


def _pll_run_notes():
    """Things worth saying once the program has finished, as stderr text.

    These are not errors: the program ran. They are the cases where it ran
    and visibly did nothing, and the student has no other evidence of why.
    The libraries that have something to say provide a `_pll_*_note`
    function; the bootstrap loads before them, so each is looked up here
    rather than imported.
    """
    notes = []
    for name in ("_pll_reactor_note",):
        note = globals().get(name)
        if note is None:
            continue
        try:
            text = note()
        except Exception:
            # A note is a courtesy; it must never take the run down with it.
            continue
        if text:
            notes.append(text)
    return "".join(notes)


def _pll_stopped_run():
    """A run's result when Stop landed before any of the student's code ran."""
    return {
        "ok": False,
        "stdout": "",
        "stderr": "",
        "result_repr": None,
        "error_type": "KeyboardInterrupt",
        "error_message": "",
        "traceback": None,
        "line_number": None,
        "column": None,
        "displays": [],
    }


def _pll_stopped_tests():
    """A test phase's result when Stop landed before the file was loaded."""
    return {
        "ok": False,
        "internal_error": False,
        "passed": 0,
        "failed": 0,
        "skipped": 0,
        "errors": 0,
        "tests": [],
        "stdout": "",
        "stderr": "",
        "error_type": None,
        "error_message": None,
        "traceback": None,
        "line_number": None,
        "column": None,
        "displays": [],
        "stopped": True,
        "stopped_in": None,
    }


def _pll_stoppable(stopped):
    """Report a Stop that lands while PLL prepares the file as a Stop.

    A Stop is retried until Python takes it, so one pressed just as a run
    begins can be taken while the file is still being parsed and
    instrumented - outside the `except` that reports a Stop in the
    student's code. From there it escaped as an internal error. `stopped()`
    is the result to give instead: none of the student's code has run, so
    there is no output and no line to report.
    """
    def decorate(fn):
        def run(*args, **kwargs):
            try:
                return fn(*args, **kwargs)
            except KeyboardInterrupt:
                return stopped()
        run.__name__ = fn.__name__
        run.__doc__ = fn.__doc__
        return run
    return decorate


@_pll_stoppable(_pll_stopped_run)
def _pll_run_file(code, filename, session_key, level="raw"):
    stdout = _PllStream("stdout")
    stderr = _PllStream("stderr")
    result = {
        "ok": False,
        "stdout": "",
        "stderr": "",
        "result_repr": None,
        "error_type": None,
        "error_message": None,
        "traceback": None,
        "line_number": None,
        "column": None,
        "displays": [],
    }
    # Each Run File starts with a clean slate for this session: discard any
    # names defined by a previous Run File of the same session or by REPL
    # exploration since then.
    _pll_apply_level(level)
    _pll_protect_import_path()
    user_globals = _pll_reset_session(session_key)
    _pll_displays.clear()
    _pll_reset_notes()
    del _pll_compile_warnings[:]
    try:
        tree = _pll_parse_and_instrument(code, filename)
        _PllTopLevelExprWrapper().visit(tree)
        _ast.fix_missing_locations(tree)
        with _pll_recording_compile_warnings():
            compiled = compile(tree, filename, "exec")
    except SyntaxError as e:
        tb_text = "".join(_tb_mod.format_exception(type(e), e, e.__traceback__))
        result["error_type"] = type(e).__name__
        result["error_message"] = str(e)
        result["traceback"] = tb_text
        result["line_number"] = e.lineno
        result["column"] = (e.offset - 1) if e.offset else None
        result["stdout"] = stdout.getvalue()
        result["stderr"] = stderr.getvalue()
        result["displays"] = list(_pll_displays)
        return result

    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            exec(compiled, user_globals)
            # Only once the program has finished: building a reactor and
            # starting it further down is perfectly ordinary.
            stderr.write(_pll_run_notes())
        result["ok"] = True
    except SystemExit:
        result["ok"] = True
    except BaseException as e:
        _pll_enrich_type_check(e)
        _pll_enrich_index_error(e, code)
        formatted = _pll_format_exception(e)
        result["error_type"] = type(e).__name__
        result["error_message"] = str(e)
        result["traceback"] = formatted
        line_no, col = _pll_extract_loc(formatted, filename)
        result["line_number"] = line_no
        result["column"] = col
    finally:
        # After the run, so a warning the run's own error explains can be
        # left out, and one about a line that never ran can be said.
        _pll_say_compile_warnings(stderr, result["error_message"], code)
        result["stdout"] = stdout.getvalue()
        result["stderr"] = stderr.getvalue()
        result["displays"] = list(_pll_displays)
    return result


# -----------------------------------------------------------------------------
# Tests (pytest, same-file test_* / Test* collection)
# -----------------------------------------------------------------------------

def _pll_has_tests(code):
    """Return True if `code` looks like it contains pytest tests.

    Mirrors pytest's default collection: module-level `test_*` functions
    and `test_*` methods on `Test*` classes. Used so we can skip loading
    pytest for files that have no tests.
    """
    try:
        tree = _ast.parse(code)
    except (SyntaxError, ValueError):
        return False
    for node in tree.body:
        if isinstance(node, (_ast.FunctionDef, _ast.AsyncFunctionDef)):
            if node.name.startswith("test_"):
                return True
        elif isinstance(node, _ast.ClassDef) and node.name.startswith("Test"):
            for item in node.body:
                if isinstance(item, (_ast.FunctionDef, _ast.AsyncFunctionDef)):
                    if item.name.startswith("test_"):
                        return True
    return False


_PLL_TRACE_SKIP = (
    _PLL_VENDOR_DIR,
    "_pytest",
    "pluggy",
    "site-packages",
    "/lib/python",
    "get_terminal_writer",
    "pyio.py",
    "pathlib",
)


def _pll_is_internal_frame(line):
    return any(tok in line for tok in _PLL_TRACE_SKIP)


def _pll_fix_ast_ranges(tree):
    """Make rewritten asserts compile on Python 3.12+.

    `rewrite_asserts` can leave `end_lineno` < `lineno` on injected nodes.
    CPython then raises `ValueError: AST node line range (...) is not valid`.
    """
    for child in _ast.walk(tree):
        lineno = getattr(child, "lineno", None)
        end_lineno = getattr(child, "end_lineno", None)
        if lineno is not None and end_lineno is not None and end_lineno < lineno:
            child.end_lineno = lineno
        col = getattr(child, "col_offset", None)
        end_col = getattr(child, "end_col_offset", None)
        if (
            col is not None
            and end_col is not None
            and lineno is not None
            and end_lineno is not None
            and lineno == end_lineno
            and end_col < col
        ):
            child.end_col_offset = col


def _pll_test_locations(tree):
    """Map collected test names to 1-based source lines."""
    locs = {}
    for node in tree.body:
        if isinstance(node, (_ast.FunctionDef, _ast.AsyncFunctionDef)):
            if node.name.startswith("test_"):
                locs[node.name] = node.lineno
        elif isinstance(node, _ast.ClassDef) and node.name.startswith("Test"):
            for item in node.body:
                if isinstance(item, (_ast.FunctionDef, _ast.AsyncFunctionDef)):
                    if item.name.startswith("test_"):
                        locs[node.name + "::" + item.name] = item.lineno
    return locs


def _pll_friendly_assert_message(exc, tb_text):
    """Short explanation of a failed assert, with pytest internals stripped."""
    msg = str(exc).strip()
    lines = []
    for raw in msg.split("\n"):
        stripped = raw.strip()
        if not stripped:
            continue
        if _pll_is_internal_frame(stripped):
            continue
        if stripped.startswith("+"):
            stripped = stripped.lstrip("+ ").strip()
        lines.append(stripped)
    if lines:
        return "\n".join(lines) + _pll_float_note("\n".join(lines))
    for raw in reversed((tb_text or "").splitlines()):
        stripped = raw.strip()
        if stripped.startswith("assert "):
            return stripped + _pll_float_note(stripped)
    return "This test failed."


#: Two decimal numbers in a failed `assert ... == ...`.
_PLL_FLOAT_PAIR_RE = _pll_src_re.compile(
    r"(-?\d+\.\d+(?:e[-+]?\d+)?)\s*==\s*(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)"
)


def _pll_float_note(text):
    """" ... use pytest.approx", when two numbers differ only in the dust.

    `0.9299999999999999 == 0.93` is how floating point works, not a bug in
    the student's arithmetic, and nothing in the failure says so.
    """
    match = _PLL_FLOAT_PAIR_RE.search(text)
    if match is None:
        return ""
    try:
        left = float(match.group(1))
        right = float(match.group(2))
    except ValueError:
        return ""
    if left == right:
        return ""
    scale = max(abs(left), abs(right), 1e-12)
    if abs(left - right) / scale > 1e-6:
        return ""
    return (
        "\nThese differ only in the last few digits, which is how decimals "
        "work in any computer. Compare them with `pytest.approx`: "
        "`assert value == pytest.approx(%s)`." % match.group(2)
    )


def _pll_is_async(fn):
    try:
        import inspect
        return inspect.iscoroutinefunction(fn)
    except Exception:
        return False


def _pll_call_test(fn, code=""):
    """Run one test function.

    Returns `(outcome, message, stdout, traceback)`. The traceback is for
    the host, not the student: the message is one line by design, and the
    frames are what say which of *their* functions the error came from.
    """
    import io

    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            if _pll_is_async(fn):
                return (
                    "error",
                    "async tests are not supported.",
                    buf.getvalue().strip() or None,
                    None,
                )
            fn()
        return ("passed", None, buf.getvalue().strip() or None, None)
    except KeyboardInterrupt:
        # A Stop, not something this test did wrong. Recording it as an
        # error and moving on ran every remaining test - and then the
        # program - after the student had asked for it all to stop.
        raise
    except AssertionError as e:
        tb_text = "".join(_tb_mod.format_exception(type(e), e, e.__traceback__))
        return (
            "failed",
            _pll_friendly_assert_message(e, tb_text),
            buf.getvalue().strip() or None,
            tb_text,
        )
    except BaseException as e:
        _pll_enrich_type_check(e)
        _pll_enrich_index_error(e, code)
        name = type(e).__name__
        if name == "Skipped":
            return (
                "skipped",
                str(e).strip() or None,
                buf.getvalue().strip() or None,
                None,
            )
        return (
            "error",
            name + ": " + (str(e) or "this test raised an exception."),
            buf.getvalue().strip() or None,
            "".join(_tb_mod.format_exception(type(e), e, e.__traceback__)),
        )


def _pll_iter_tests(ns):
    """Yield (name, callable) for pytest-style tests in namespace `ns`."""
    items = list(ns.items())
    for name, obj in items:
        if name.startswith("test_") and callable(obj) and not isinstance(obj, type):
            yield name, obj
    for name, obj in items:
        if not (isinstance(obj, type) and name.startswith("Test")):
            continue
        # pytest skips classes with a custom constructor.
        try:
            obj()
        except TypeError:
            continue
        for meth_name in dir(obj):
            if not meth_name.startswith("test_"):
                continue
            attr = getattr(obj, meth_name, None)
            if not callable(attr):
                continue

            def _bound(cls=obj, method=meth_name):
                return getattr(cls(), method)()

            yield name + "::" + meth_name, _bound


def _pll_syntax_result(result, error):
    """Fill in `result` for a syntax error, wherever it was noticed.

    Parsing and compiling both raise `SyntaxError`, and a student cannot
    tell the two apart - nor should they have to.
    """
    result["internal_error"] = True
    result["error_type"] = type(error).__name__
    result["error_message"] = str(error)
    result["line_number"] = error.lineno
    result["column"] = (error.offset - 1) if error.offset else None
    return result


@_pll_stoppable(_pll_stopped_tests)
def _pll_run_tests(code, filename, level="raw"):
    """Run same-file tests (`test_*` / `Test*`) in an isolated namespace.

    Uses pytest only to rewrite assertions so failures show `assert 4 == 5`
    instead of an empty AssertionError. Does **not** call `pytest.main()`,
    which is not safe to invoke repeatedly in one Pyodide interpreter.
    """
    display_name = filename.rsplit("/", 1)[-1].rsplit("\\", 1)[-1] or "user_script.py"
    stdout = _PllStream("stdout")
    stderr = _PllStream("stderr")
    result = {
        "ok": False,
        "internal_error": False,
        "passed": 0,
        "failed": 0,
        "skipped": 0,
        "errors": 0,
        "tests": [],
        "stdout": "",
        "stderr": "",
        "error_type": None,
        "error_message": None,
        "traceback": None,
        "line_number": None,
        "column": None,
        "displays": [],
    }
    _pll_displays.clear()
    _pll_apply_level(level)
    _pll_protect_import_path()

    try:
        tree = _pll_parse_and_instrument(code, display_name)
    except SyntaxError as e:
        return _pll_syntax_result(result, e)

    locs = _pll_test_locations(tree)
    try:
        from _pytest.assertion.rewrite import rewrite_asserts
        rewrite_asserts(tree, code.encode("utf-8"), module_path=display_name)
        # Do not call ast.fix_missing_locations here: it copies parent
        # positions onto pytest's injected nodes and yields ranges that
        # Python 3.12+ rejects (`end_lineno` < `lineno`).
        _pll_fix_ast_ranges(tree)
    except Exception:
        # Assert rewriting failed. It mutates the tree as it goes, so what
        # is compiled below is whatever it managed; a failure then shows an
        # empty AssertionError, which is worse than nothing but still runs.
        pass

    # Some code parses and does not compile. `case Boa:` is the one that
    # matters here - "name capture 'Boa' makes remaining patterns
    # unreachable" - and this is where it surfaces. Before, it escaped
    # `_pll_run_tests` altogether (the old `except` re-ran the same
    # `compile`, raising from inside the handler), the CLI exited 64 with a
    # doubled traceback, and the file never ran at all.
    try:
        # Recorded and dropped: the run that follows compiles the same file
        # and says its warnings once, which is once more than enough.
        with _pll_recording_compile_warnings():
            compiled = compile(tree, display_name, "exec")
    except SyntaxError as e:
        return _pll_syntax_result(result, e)
    finally:
        del _pll_compile_warnings[:]

    # The tests run inside a real module, registered under the name their
    # classes will report as `__module__`.
    #
    # `dataclasses` resolves a *string* annotation - `rest: "NumList"`, the
    # shape of every recursive data definition - by looking that module up:
    # `sys.modules.get(cls.__module__).__dict__`. With nothing registered
    # that is `None.__dict__`, and the whole test phase died with
    # `AttributeError: 'NoneType' object has no attribute '__dict__'`.
    #
    # The module's own `__dict__` is used as the globals, rather than a copy
    # of them, so a forward reference resolves to the student's class as
    # soon as they define it.
    module = _pll_types.ModuleType("__pll_test__")
    ns = module.__dict__
    ns.update(_pll_initial_globals)
    ns["__name__"] = "__pll_test__"
    ns["__file__"] = display_name
    _sys.modules["__pll_test__"] = module

    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            exec(compiled, ns)
    except KeyboardInterrupt:
        # Stopped in the file's own top-level code, before any test ran.
        result["stopped"] = True
        result["stopped_in"] = None
        result["stdout"] = stdout.getvalue()
        result["stderr"] = stderr.getvalue()
        result["displays"] = list(_pll_displays)
        return result
    except BaseException as e:
        formatted = _pll_format_exception(e)
        result["internal_error"] = True
        result["error_type"] = type(e).__name__
        result["error_message"] = str(e)
        result["traceback"] = formatted
        line_no, col = _pll_extract_loc(formatted, display_name)
        result["line_number"] = line_no
        result["column"] = col
        result["stdout"] = stdout.getvalue()
        result["stderr"] = stderr.getvalue()
        result["displays"] = list(_pll_displays)
        return result

    rows = []
    passed = failed = errors = skipped = 0
    current = None
    try:
        for name, fn in _pll_iter_tests(ns):
            current = name
            outcome, message, cap, tb_text = _pll_call_test(fn, code)
            if outcome == "passed":
                passed += 1
            elif outcome == "failed":
                failed += 1
            elif outcome == "skipped":
                skipped += 1
            else:
                errors += 1
            rows.append({
                "name": name,
                "outcome": outcome,
                "line_number": locs.get(name),
                "message": message,
                "stdout": cap,
                # For the host's explainers only; never shown to a student.
                "traceback": tb_text,
            })
    except KeyboardInterrupt:
        # A Stop ends the whole phase. The tests that finished keep their
        # results; the one running is marked as where it stopped; the rest
        # are not run, and the host does not go on to run the program.
        result["stopped"] = True
        result["stopped_in"] = current
        if current is not None:
            rows.append({
                "name": current,
                "outcome": "stopped",
                "line_number": locs.get(current),
                "message": None,
                "stdout": None,
                "traceback": None,
            })

    result["passed"] = passed
    result["failed"] = failed
    result["skipped"] = skipped
    result["errors"] = errors
    result["tests"] = rows
    result["ok"] = failed == 0 and errors == 0 and not result.get("stopped")
    result["stdout"] = stdout.getvalue()
    result["stderr"] = stderr.getvalue()
    result["displays"] = list(_pll_displays)
    return result


# -----------------------------------------------------------------------------
# REPL-style eval (statements + last-expression value)
# -----------------------------------------------------------------------------

@_pll_stoppable(_pll_stopped_run)
def _pll_repl_eval(code, session_key, level="raw"):
    stdout = _PllStream("stdout")
    stderr = _PllStream("stderr")
    result = {
        "ok": False,
        "stdout": "",
        "stderr": "",
        "result_repr": None,
        "error_type": None,
        "error_message": None,
        "traceback": None,
        "line_number": None,
        "column": None,
        "displays": [],
    }
    _pll_displays.clear()
    _pll_apply_level(level)
    _pll_protect_import_path()
    user_globals = _pll_get_session(session_key)
    filename = "<repl>"
    del _pll_compile_warnings[:]
    try:
        tree = _pll_parse_and_instrument(code, filename)
    except SyntaxError as e:
        formatted = _pll_format_exception(e)
        result["error_type"] = type(e).__name__
        result["error_message"] = str(e)
        result["traceback"] = formatted
        result["line_number"] = e.lineno
        result["column"] = (e.offset - 1) if e.offset else None
        return result

    last_expr = None
    if tree.body and isinstance(tree.body[-1], _ast.Expr):
        last_expr = tree.body[-1]
        tree.body = tree.body[:-1]

    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            if tree.body:
                with _pll_recording_compile_warnings():
                    compiled_stmts = compile(tree, filename, "exec")
                exec(compiled_stmts, user_globals)
            if last_expr is not None:
                expr_module = _ast.Expression(body=last_expr.value)
                with _pll_recording_compile_warnings():
                    compiled_expr = compile(expr_module, filename, "eval")
                value = eval(compiled_expr, user_globals)
                if value is not None:
                    payload = _pll_extract_display(value)
                    if payload is not None:
                        _pll_push(payload)
                    else:
                        result["result_repr"] = repr(value)
        result["ok"] = True
    except SystemExit:
        result["ok"] = True
    except BaseException as e:
        _pll_enrich_type_check(e)
        _pll_enrich_index_error(e, code)
        formatted = _pll_format_exception(e)
        result["error_type"] = type(e).__name__
        result["error_message"] = str(e)
        result["traceback"] = formatted
        line_no, col = _pll_extract_loc(formatted, filename)
        result["line_number"] = line_no
        result["column"] = col
    finally:
        _pll_say_compile_warnings(stderr, result["error_message"], code)
        result["stdout"] = stdout.getvalue()
        result["stderr"] = stderr.getvalue()
        result["displays"] = list(_pll_displays)
    return result


# =============================================================================
# Static analysis (beginner / intermediate level checks)
# =============================================================================
#
# Per-level rules:
#
#   beginner:
#     1. Shadowing:        a binding whose name appears in any enclosing
#                          scope, is the name of a Python built-in, or is
#                          provided by a PLL library (image / table /
#                          reactor - the names every session starts with).
#     2. Reassignment:     a name bound more than once within the *same*
#                          scope. Suppressed for names already flagged as
#                          shadowing in that scope (fix the shadow first).
#     3. Disallowed kw:    `global` and `nonlocal` statements.
#
#   intermediate:
#     1. Shadowing:        same as beginner.
#     2. Reassignment:     only flagged at module scope. Function/lambda/
#                          class/comprehension scopes are allowed to rebind,
#                          which is what enables for-loop accumulator
#                          patterns (e.g. `total = 0; for x in xs: total += x`
#                          inside `def`).
#     3. Disallowed kw:    `global` and `nonlocal` statements.
#
#   advanced:
#     No checks. Full Python.
#
# A "scope" is one of: module, function (incl. async), lambda, class,
# comprehension/generator. We model these explicitly because Python 3
# comprehensions have their own scope.


_PLL_SCOPE_FUNC = (_ast.FunctionDef, _ast.AsyncFunctionDef)
_PLL_SCOPE_COMP = (_ast.ListComp, _ast.SetComp, _ast.DictComp, _ast.GeneratorExp)

# Attributes `dir()` reports for the `builtins` *module object* itself. They
# are not built-in functions, so reporting them as shadowed would be a false
# positive with misleading wording ("`__name__` is the name of a Python
# built-in"). Everything else `dir()` returns is a real builtin and is worth
# flagging, including the dunder ones like `__import__`.
_PLL_BUILTINS_MODULE_META = frozenset(
    ("__doc__", "__loader__", "__name__", "__package__", "__spec__")
)


class _PllScope:
    __slots__ = ("node", "kind", "parent", "bindings", "declared_elsewhere")

    def __init__(self, node, kind, parent):
        self.node = node
        self.kind = kind        # "module" | "function" | "lambda" | "class" | "comprehension"
        self.parent = parent    # _PllScope | None
        # name -> [(lineno, col, kind, module), ...]. `module` is set only
        # for import bindings: the module the name was imported from.
        self.bindings = {}
        # Names this scope declared `global` or `nonlocal`. An assignment to
        # one of them rebinds the *outer* name, so it neither shadows nor
        # reassigns anything here - and the keyword itself is already
        # reported at the levels that disallow it.
        self.declared_elsewhere = set()


def _pll_arg_names(args):
    """All argument names (with positions) on an ast.arguments node."""
    out = []
    posonly = list(getattr(args, "posonlyargs", []) or [])
    for a in posonly + list(args.args) + list(args.kwonlyargs):
        out.append((a.arg, a.lineno, a.col_offset))
    if args.vararg:
        out.append((args.vararg.arg, args.vararg.lineno, args.vararg.col_offset))
    if args.kwarg:
        out.append((args.kwarg.arg, args.kwarg.lineno, args.kwarg.col_offset))
    return out


class _PllScopeBuilder:
    """Walk a module AST and build a list of scopes with their bindings.

    A binding is collected in the *enclosing* scope of the syntactic node
    (e.g. a `def f` adds `f` to the surrounding scope and creates a new
    function scope for its body). Comprehensions, lambdas, and classes
    each open their own scope.
    """

    def __init__(self):
        self.scopes = []

    def build(self, tree):
        module = _PllScope(tree, "module", None)
        self.scopes.append(module)
        for stmt in tree.body:
            self._walk(stmt, module)
        return module

    def _add(self, scope, name, lineno, col, kind, module=None):
        scope.bindings.setdefault(name, []).append((lineno, col, kind, module))

    def _add_target(self, target, scope, kind):
        if isinstance(target, _ast.Name):
            self._add(scope, target.id, target.lineno, target.col_offset, kind)
        elif isinstance(target, (_ast.Tuple, _ast.List)):
            for elt in target.elts:
                self._add_target(elt, scope, kind)
        elif isinstance(target, _ast.Starred):
            self._add_target(target.value, scope, kind)
        else:
            # Subscript/Attribute targets are not name bindings.
            self._walk(target, scope)

    def _walk(self, node, scope):
        # --- Binding-creating statements ---------------------------------
        if isinstance(node, _ast.Assign):
            for t in node.targets:
                self._add_target(t, scope, "assign")
            self._walk(node.value, scope)
            return
        if isinstance(node, _ast.AnnAssign):
            if isinstance(node.target, _ast.Name):
                self._add(scope, node.target.id, node.target.lineno, node.target.col_offset, "annassign")
            else:
                self._walk(node.target, scope)
            if node.annotation is not None:
                self._walk(node.annotation, scope)
            if node.value is not None:
                self._walk(node.value, scope)
            return
        if isinstance(node, _ast.AugAssign):
            if isinstance(node.target, _ast.Name):
                self._add(scope, node.target.id, node.target.lineno, node.target.col_offset, "augassign")
            else:
                self._walk(node.target, scope)
            self._walk(node.value, scope)
            return
        if isinstance(node, (_ast.For, _ast.AsyncFor)):
            self._add_target(node.target, scope, "for")
            self._walk(node.iter, scope)
            for s in node.body:
                self._walk(s, scope)
            for s in node.orelse:
                self._walk(s, scope)
            return
        if isinstance(node, (_ast.With, _ast.AsyncWith)):
            for item in node.items:
                self._walk(item.context_expr, scope)
                if item.optional_vars is not None:
                    self._add_target(item.optional_vars, scope, "with")
            for s in node.body:
                self._walk(s, scope)
            return
        if isinstance(node, _ast.Import):
            for alias in node.names:
                name = alias.asname or alias.name.split(".", 1)[0]
                self._add(scope, name, node.lineno, node.col_offset, "import", alias.name)
            return
        if isinstance(node, _ast.ImportFrom):
            for alias in node.names:
                name = alias.asname or alias.name
                self._add(scope, name, node.lineno, node.col_offset, "importfrom", node.module)
            return
        if isinstance(node, _ast.NamedExpr):
            # Walrus :=
            if isinstance(node.target, _ast.Name):
                self._add(scope, node.target.id, node.target.lineno, node.target.col_offset, "walrus")
            self._walk(node.value, scope)
            return
        if isinstance(node, (_ast.Global, _ast.Nonlocal)):
            # No binding here, but an assignment further down binds the
            # outer name rather than a local one. Recorded so the shadowing
            # and reassignment checks do not report it twice over.
            scope.declared_elsewhere.update(node.names)
            return

        # --- Scope-introducing nodes -------------------------------------
        if isinstance(node, _PLL_SCOPE_FUNC):
            # Function name binds in the OUTER scope.
            self._add(scope, node.name, node.lineno, node.col_offset, "functiondef")
            for d in node.decorator_list:
                self._walk(d, scope)
            for d in node.args.defaults:
                self._walk(d, scope)
            for d in (node.args.kw_defaults or []):
                if d is not None:
                    self._walk(d, scope)
            inner = _PllScope(node, "function", scope)
            self.scopes.append(inner)
            for name, lineno, col in _pll_arg_names(node.args):
                self._add(inner, name, lineno, col, "argument")
            for s in node.body:
                self._walk(s, inner)
            return
        if isinstance(node, _ast.Lambda):
            for d in node.args.defaults:
                self._walk(d, scope)
            for d in (node.args.kw_defaults or []):
                if d is not None:
                    self._walk(d, scope)
            inner = _PllScope(node, "lambda", scope)
            self.scopes.append(inner)
            for name, lineno, col in _pll_arg_names(node.args):
                self._add(inner, name, lineno, col, "argument")
            self._walk(node.body, inner)
            return
        if isinstance(node, _ast.ClassDef):
            self._add(scope, node.name, node.lineno, node.col_offset, "classdef")
            for d in node.decorator_list:
                self._walk(d, scope)
            for b in node.bases:
                self._walk(b, scope)
            for kw in node.keywords:
                self._walk(kw.value, scope)
            inner = _PllScope(node, "class", scope)
            self.scopes.append(inner)
            for s in node.body:
                self._walk(s, inner)
            return
        if isinstance(node, _PLL_SCOPE_COMP):
            inner = _PllScope(node, "comprehension", scope)
            self.scopes.append(inner)
            # Per Python semantics: outermost iter is evaluated in the OUTER
            # scope, everything else inside the comp scope.
            for i, gen in enumerate(node.generators):
                if i == 0:
                    self._walk(gen.iter, scope)
                else:
                    self._walk(gen.iter, inner)
                self._add_target(gen.target, inner, "comprehension")
                for cond in gen.ifs:
                    self._walk(cond, inner)
            if isinstance(node, _ast.DictComp):
                self._walk(node.key, inner)
                self._walk(node.value, inner)
            else:
                self._walk(node.elt, inner)
            return

        # --- Default: descend in the same scope --------------------------
        for child in _ast.iter_child_nodes(node):
            self._walk(child, scope)


class _PllKeywordVisitor(_ast.NodeVisitor):
    """Collect every `global` / `nonlocal` statement in a tree.

    Each entry is `(keyword, lineno, col_offset, names)` where `keyword`
    is the literal string "global" or "nonlocal" and `names` is the list
    of identifiers the statement applies to.
    """

    def __init__(self):
        self.found = []

    def visit_Global(self, node):
        self.found.append(("global", node.lineno, node.col_offset, list(node.names)))
        self.generic_visit(node)

    def visit_Nonlocal(self, node):
        self.found.append(("nonlocal", node.lineno, node.col_offset, list(node.names)))
        self.generic_visit(node)


#: Annotations students write that are not types. `table` is the function
#: that makes a table; `Table` is the type. Written out rather than derived
#: so a name only maps when the replacement is certainly right.
_PLL_ANNOTATION_FIXES = {
    "table": "Table",
    "reactor": "Reactor",
    "row": "Row",
    "string": "str",
    "integer": "int",
    "boolean": "bool",
    "number": "float",
    "Float": "float",
    "Int": "int",
    "Str": "str",
    "Bool": "bool",
    "image": "Image",
    "Number": "float",
    "String": "str",
    "Boolean": "bool",
    "Integer": "int",
}

#: Methods that are nearly always meant to be called. `movies["rating"].mean`
#: prints `<bound method Series.mean of ...>` and says nothing; `.mean()` is
#: what was wanted. Only names that are a method everywhere a student meets
#: them: `columns`, `values` and `shape` are properties in pandas, and
#: `width` and `height` are properties on an image, so they are not here.
_PLL_CALLED_METHODS = frozenset(
    (
        "mean",
        "sum",
        "count",
        "length",
        "rows",
        "head",
        "tail",
        "to_pandas",
        "to_svg",
        "upper",
        "lower",
        "strip",
        "split",
        "keys",
        "items",
        "sort_values",
        "value_counts",
        "describe",
        "median",
        "std",
        "var",
        "nunique",
        "interact",
    )
)


_PLL_SILENCE_TYPES = {
    "unused-comparison": "UnusedValue",
    "unused-value": "UnusedValue",
    "assert-tuple": "AlwaysTrue",
    "method-not-called": "NotCalled",
    "annotation-not-a-type": "NotAType",
    "field-no-type": "FieldNeedsType",
    "field-assigned-type": "FieldNeedsType",
    "class-needs-dataclass": "NotADataclass",
    "compared-with-class": "AlwaysFalse",
}

_PLL_SILENCE_MESSAGES = {
    "unused-comparison": "this comparison's result is not used",
    "unused-value": "this value is not used",
    "assert-tuple": "this `assert` is always true",
    "method-not-called": "`%s` is named here but not called",
    "annotation-not-a-type": "`%s` is not a type",
    "field-no-type": "the field `%s` has no type",
    "field-assigned-type": "the field `%s` is assigned a type instead of annotated",
    "class-needs-dataclass": "`%s` has fields but is not a dataclass",
    "compared-with-class": "`%s` is a class, so this comparison is always False",
}


#: Functions whose whole job is to be given a function, where naming a
#: method without calling it is exactly right.
_PLL_TAKES_A_FUNCTION = frozenset(
    ("sorted", "map", "filter", "min", "max", "sort", "reduce", "any", "all")
)

#: Types a student might assign to a field name by mistake: `year = int`
#: rather than `year: int`.
_PLL_TYPE_NAMES = frozenset(("int", "float", "str", "bool", "list", "dict", "tuple"))


class _PllSilenceVisitor(_ast.NodeVisitor):
    """Collect mistakes that run without a word being said.

    Each of these is valid Python that does nothing, or does something
    other than what was meant, and so produces no error at all:

      - a value computed and thrown away inside a function, which is how a
        test written without `assert` always passes;
      - `assert(x, 1)`, where the tuple is always true;
      - a function containing `assert` that is not named `test_...` and is
        never called, so it never runs;
      - an annotation naming a function rather than a type, which turns
        every check on that value off;
      - a method named but not called, which yields the method object;
      - a dataclass field with no type, or written `year = int`, which
        makes no field and goes wrong somewhere else entirely;
      - a class with fields and no `@dataclass`, whose constructor then
        "takes no arguments";
      - `a == Boa`, which is always False.

    Only inside a function for the first one: at the top level a bare
    expression is displayed, and the course relies on that.
    """

    __slots__ = (
        "found",
        "_depth",
        "_called",
        "_asserting",
        "_classes",
        "_fields",
        "_written_types",
        "_expressions",
    )

    def __init__(self):
        self.found = []
        self._depth = 0
        # Classes defined in this file, so `== Boa` can be told from `== b`.
        self._classes = set()
        # Their field names. A field called `count` or `items` happens to
        # share its name with a method, and `s.count` is then exactly
        # right - so those are not "a method you forgot to call".
        self._fields = set()
        # For `year = int`: the type written, by position.
        self._written_types = {}
        # For a value thrown away: the expression node, by position.
        self._expressions = {}
        # Names used anywhere other than as the function's own definition,
        # so a helper that is never called can be told from one that is.
        self._called = set()
        # Functions that contain an `assert`: (name, lineno, col).
        self._asserting = []

    # ---- functions ----

    def scan(self, tree):
        """Visit `tree`, with the classes and their fields collected first.

        `a == Boa` is only recognisable as a comparison against a class if
        `Boa` is already known, and a function written above the class it
        uses is perfectly ordinary. The field names are wanted for the same
        reason, by the checks that would otherwise mistake one for a method.
        """
        for node in _ast.walk(tree):
            if not isinstance(node, _ast.ClassDef):
                continue
            self._classes.add(node.name)
            for stmt in node.body:
                if isinstance(stmt, _ast.AnnAssign) and isinstance(stmt.target, _ast.Name):
                    self._fields.add(stmt.target.id)
        self.visit(tree)

    def _function(self, node):
        self._depth += 1
        self.generic_visit(node)
        self._depth -= 1
        if self._contains_assert(node) and not node.name.startswith("test_"):
            self._asserting.append((node.name, node.lineno, node.col_offset))
        returns = node.returns
        if (
            isinstance(returns, _ast.Name)
            and returns.id in _PLL_ANNOTATION_FIXES
            and returns.id not in self._classes
        ):
            self.found.append(
                (
                    "annotation-not-a-type",
                    returns.lineno,
                    returns.col_offset,
                    returns.id,
                )
            )

    visit_FunctionDef = _function
    visit_AsyncFunctionDef = _function

    @staticmethod
    def _contains_assert(node):
        for child in _ast.walk(node):
            if isinstance(child, _ast.Assert):
                return True
        return False

    def visit_Name(self, node):
        if isinstance(node.ctx, _ast.Load):
            self._called.add(node.id)
        self.generic_visit(node)

    # ---- classes and their fields ----

    def visit_ClassDef(self, node):
        self._classes.add(node.name)
        decorated = any(
            (isinstance(d, _ast.Name) and d.id == "dataclass")
            or (isinstance(d, _ast.Attribute) and d.attr == "dataclass")
            or (
                isinstance(d, _ast.Call)
                and (
                    (isinstance(d.func, _ast.Name) and d.func.id == "dataclass")
                    or (isinstance(d.func, _ast.Attribute) and d.func.attr == "dataclass")
                )
            )
            for d in node.decorator_list
        )
        annotated = [
            stmt
            for stmt in node.body
            if isinstance(stmt, _ast.AnnAssign) and isinstance(stmt.target, _ast.Name)
        ]
        for stmt in node.body:
            # `year` on a line of its own: meant as a field, but it is a
            # use of a name, so it fails as a NameError somewhere else.
            if (
                isinstance(stmt, _ast.Expr)
                and isinstance(stmt.value, _ast.Name)
                and stmt.value.id not in ("Ellipsis",)
            ):
                self.found.append(
                    (
                        "field-no-type",
                        stmt.lineno,
                        stmt.col_offset,
                        stmt.value.id,
                    )
                )
            # `year = int`: a class attribute holding a type, which makes
            # no field at all and goes wrong much later, in the argument
            # count of a constructor nobody wrote.
            if (
                isinstance(stmt, _ast.Assign)
                and len(stmt.targets) == 1
                and isinstance(stmt.targets[0], _ast.Name)
                and isinstance(stmt.value, _ast.Name)
                and stmt.value.id in _PLL_TYPE_NAMES
            ):
                self.found.append(
                    (
                        "field-assigned-type",
                        stmt.lineno,
                        stmt.col_offset,
                        stmt.targets[0].id,
                    )
                )
                # The type they wrote, so the fix quotes it back exactly.
                self._written_types[(stmt.lineno, stmt.col_offset)] = stmt.value.id
        # Annotated fields and no `@dataclass`: `X(...)` then fails with
        # "takes no arguments", which says nothing about the decorator.
        writes_init = any(
            isinstance(stmt, _PLL_SCOPE_FUNC) and stmt.name == "__init__"
            for stmt in node.body
        )
        if annotated and not decorated and not writes_init:
            self.found.append(
                ("class-needs-dataclass", node.lineno, node.col_offset, node.name)
            )
        self.generic_visit(node)

    def visit_Compare(self, node):
        # `if a == Boa:` is always False - a value is never equal to the
        # class it was made from. `type(a) == Boa`, though, is a real check.
        sides = [node.left] + list(node.comparators)
        if any(
            isinstance(side, _ast.Call)
            and isinstance(side.func, _ast.Name)
            and side.func.id == "type"
            for side in sides
        ):
            self.generic_visit(node)
            return
        for side in sides:
            if (
                isinstance(side, _ast.Name)
                and side.id in self._classes
                and any(isinstance(op, (_ast.Eq, _ast.NotEq)) for op in node.ops)
            ):
                self.found.append(
                    ("compared-with-class", side.lineno, side.col_offset, side.id)
                )
        self.generic_visit(node)

    # ---- statements whose value goes nowhere ----

    def visit_Expr(self, node):
        value = node.value
        # A method named but not called is the more specific thing to say
        # about `t.mean` on a line of its own, so it wins.
        if not self._method_not_called(value) and self._depth > 0 and self._discarded(value):
            self.found.append(
                (
                    "unused-comparison" if isinstance(value, _ast.Compare) else "unused-value",
                    node.lineno,
                    node.col_offset,
                    None,
                )
            )
            self._expressions[(node.lineno, node.col_offset)] = value
        self.generic_visit(node)

    @staticmethod
    def _discarded(value):
        """Whether this expression statement can only be a mistake.

        A call, an await or a yield is there for its effect. A string is a
        docstring. `...` is a placeholder. Everything else computes
        something and drops it.
        """
        if isinstance(
            value,
            (
                _ast.Call,
                _ast.Await,
                _ast.Yield,
                _ast.YieldFrom,
                _ast.NamedExpr,
            ),
        ):
            return False
        if isinstance(value, _ast.Constant):
            return False
        return True

    def _method_not_called(self, value):
        """`movies["rating"].mean` - the method itself, not its result."""
        if (
            isinstance(value, _ast.Attribute)
            and value.attr in _PLL_CALLED_METHODS
            and value.attr not in self._fields
        ):
            self.found.append(
                ("method-not-called", value.lineno, value.col_offset, value.attr)
            )
            return True
        return False

    def visit_Call(self, node):
        # A method named but not called, wherever its value is used:
        # `print(movies["rating"].mean)`.
        #
        # Not for a function that takes a function - `sorted(xs,
        # key=str.lower)` passes `str.lower` deliberately, and that is the
        # one shape where naming a method without calling it is right.
        callee = node.func
        name = callee.id if isinstance(callee, _ast.Name) else None
        if name in _PLL_TAKES_A_FUNCTION:
            self.generic_visit(node)
            return
        for keyword in node.keywords:
            if keyword.arg not in ("key", "default_factory"):
                self._method_not_called(keyword.value)
        for argument in node.args:
            self._method_not_called(argument)
        self.generic_visit(node)

    # ---- asserts ----

    def visit_Assert(self, node):
        if isinstance(node.test, _ast.Tuple) and node.test.elts:
            self.found.append(
                ("assert-tuple", node.lineno, node.col_offset, None)
            )
        self.generic_visit(node)

    # ---- annotations ----

    def _annotation(self, node):
        annotation = getattr(node, "annotation", None)
        if (
            isinstance(annotation, _ast.Name)
            and annotation.id in _PLL_ANNOTATION_FIXES
            # A class of their own called `Number` is a type, and naming it
            # in an annotation is right.
            and annotation.id not in self._classes
        ):
            self.found.append(
                (
                    "annotation-not-a-type",
                    annotation.lineno,
                    annotation.col_offset,
                    annotation.id,
                )
            )
        self.generic_visit(node)

    visit_AnnAssign = _annotation
    visit_arg = _annotation

    def uncalled_test_functions(self):
        """Functions with an `assert` that nothing ever runs."""
        return [
            (name, lineno, col)
            for name, lineno, col in self._asserting
            if name not in self._called
        ]


def _pll_session_bound_names(session_key):
    """User-defined names already bound in a session (for REPL checks).

    Baseline names from `_pll_initial_globals` (image primitives, etc.) are
    skipped unless the user rebound them, so prompt analysis matches file
    analysis for the same snippet.
    """
    g = _pll_sessions.get(session_key)
    if not g:
        return []
    names = []
    for n in g:
        if n.startswith("_") or n in ("__builtins__", "__name__", "__doc__"):
            continue
        if n in _pll_initial_globals and g[n] is _pll_initial_globals[n]:
            continue
        names.append(n)
    return names


def _pll_predefined_library_names():
    """Public names every session starts with, mapped to their library.

    PYODIDE_INSTALL_PY seeds `_pll_initial_globals` with the image / table
    / reactor exports, so those names (`circle`, `rectangle`, `table`,
    `animate`, ...) are bound before the student writes anything. A student
    definition that reuses one is shadowing, exactly like a built-in - just
    with wording that says where the name comes from. The label is derived
    from the registered `pll` package when it is loaded, and falls back to
    the generic "library" otherwise (e.g. bootstrap-only test harnesses).
    """
    public = {n for n in _pll_initial_globals if not n.startswith("_")}
    labels = {}
    pll = _sys.modules.get("pll")
    if pll is not None:
        for lib in ("image", "table", "reactor"):
            mod = getattr(pll, lib, None)
            if mod is None:
                continue
            for n in public:
                if hasattr(mod, n):
                    labels[n] = lib
    return {n: labels.get(n, "library") for n in public}


def _pll_is_pll_import_loc(loc):
    """True when a binding loc tuple imports from a `pll` module.

    `from pll.image import circle` re-binds the library's own value, so it
    shadows nothing and must not be flagged.
    """
    kind, module = loc[2], loc[3]
    return (
        kind in ("import", "importfrom")
        and isinstance(module, str)
        and (module == "pll" or module.startswith("pll."))
    )


def _pll_static_analyze(code, level, filename, session_key=None):
    """Run static checks for `level` over `code` and return findings.

    Returns a list of dicts. Each dict has at minimum:
      id, error_type, message, line_number, column, name_token, scope_kind.

    If `session_key` is set, names already bound in that session are treated
    as existing module-level bindings. That way a `#level beginner` prompt cannot
    reassign a name the file (or an earlier prompt line) already defined.
    """
    if level not in ("beginner", "intermediate"):
        return []
    try:
        tree = _ast.parse(code, filename=filename)
    except SyntaxError:
        # Let the runtime path surface SyntaxErrors with their normal flow.
        return []

    findings = []
    builder = _PllScopeBuilder()
    builder.build(tree)
    if session_key:
        module = builder.scopes[0]
        for name in _pll_session_bound_names(session_key):
            locs = module.bindings.setdefault(name, [])
            locs.insert(0, (0, 0, "preexisting", None))
    builtins_set = set(dir(_builtins_mod)) - _PLL_BUILTINS_MODULE_META
    library_names = _pll_predefined_library_names()

    # Whether we flag reassignment in `scope` at this level. At beginner,
    # we flag everywhere; at intermediate, only at module scope so that
    # function-local accumulator patterns (`total = 0; for x in xs:
    # total += x`) work.
    def reassignment_active(scope_kind):
        if level == "beginner":
            return True
        if level == "intermediate":
            return scope_kind == "module"
        return False

    for scope in builder.scopes:
        # Names visible from any enclosing scope, paired with the *nearest*
        # outer binding's location and scope kind. We walk parents inner-to-
        # outer and refuse to overwrite, so the closest enclosing binding wins
        # (which is the one Python's lookup rules would resolve to).
        enclosing = {}  # name -> (lineno, col, scope_kind)
        cur = scope.parent
        while cur is not None:
            for outer_name, outer_locs in cur.bindings.items():
                if outer_name in enclosing:
                    continue
                outer_first = outer_locs[0]
                enclosing[outer_name] = (outer_first[0], outer_first[1], cur.kind)
            cur = cur.parent

        shadowed_in_scope = set()

        # ---- Shadowing first ----
        for name, locs in scope.bindings.items():
            if name in scope.declared_elsewhere:
                # `global x` already produced its own finding; an extra
                # Shadowing for the same name sent students looking for a
                # second, separate mistake.
                continue
            if scope.kind == "class":
                # A name bound in a class body is an *attribute*, not a
                # variable. `id: int` in a dataclass declares a field, and
                # `id` everywhere else still finds the built-in - so there
                # is nothing being shadowed, and telling a student to
                # rename the field was simply wrong. The class's own name
                # is bound in the enclosing scope and is still checked
                # there, so `class list:` is still caught.
                continue
            first_loc = locs[0]
            # A binding imported from a `pll` module re-binds the library's
            # own value and shadows nothing; a "preexisting" marker records
            # a name the session already bound (REPL analysis) rather than
            # one this code defines. Report at the first binding that
            # actually (re)defines the name; when there is none, this name
            # has nothing to report here.
            defining_loc = None
            for loc in locs:
                if not _pll_is_pll_import_loc(loc) and loc[2] != "preexisting":
                    defining_loc = loc
                    break
            report_loc = defining_loc if defining_loc is not None else first_loc
            if name in enclosing:
                shadowed_in_scope.add(name)
                outer = enclosing[name]
                findings.append({
                    "id": "shadowing",
                    "error_type": "Shadowing",
                    "message": "`%s` is already defined in an outer scope" % name,
                    "line_number": report_loc[0],
                    "column": report_loc[1],
                    "name_token": name,
                    "scope_kind": scope.kind,
                    "outer_line_number": outer[0],
                    "outer_column": outer[1],
                    "outer_scope_kind": outer[2],
                })
            elif name in builtins_set and defining_loc is not None:
                shadowed_in_scope.add(name)
                findings.append({
                    "id": "shadowing-builtin",
                    "error_type": "Shadowing",
                    "message": "`%s` is the name of a Python built-in" % name,
                    "line_number": defining_loc[0],
                    "column": defining_loc[1],
                    "name_token": name,
                    "scope_kind": scope.kind,
                })
            elif name in library_names and defining_loc is not None:
                shadowed_in_scope.add(name)
                lib = library_names[name]
                findings.append({
                    "id": "shadowing-library",
                    "error_type": "Shadowing",
                    "message": "`%s` is already defined by the %s library" % (name, lib),
                    "line_number": defining_loc[0],
                    "column": defining_loc[1],
                    "name_token": name,
                    "scope_kind": scope.kind,
                    "library": lib,
                })

        # ---- Then reassignment (skip names already shadow-flagged) ----
        if reassignment_active(scope.kind):
            for name, locs in scope.bindings.items():
                if name in shadowed_in_scope or name in scope.declared_elsewhere:
                    continue
                if len(locs) > 1:
                    second_loc = locs[1]
                    first_loc = locs[0]
                    # A `def` written twice is not an accumulator: the
                    # advice for a reassigned variable (running totals, use
                    # `sum`) is about something else entirely, and the fix
                    # is to rename one of them.
                    definitions = {"functiondef": "function", "classdef": "class"}
                    both = definitions.get(first_loc[2]) if first_loc[2] == second_loc[2] else None
                    if both is not None:
                        findings.append({
                            "id": "duplicate-definition",
                            "error_type": "DuplicateDefinition",
                            "message": (
                                "there are two %ss named `%s` (lines %d and %d)"
                                % (both, name, first_loc[0], second_loc[0])
                            ),
                            "line_number": second_loc[0],
                            "column": second_loc[1],
                            "name_token": name,
                            "scope_kind": scope.kind,
                            "first_line_number": first_loc[0],
                            "first_column": first_loc[1],
                            "definition_kind": both,
                        })
                        continue
                    findings.append({
                        "id": "reassignment",
                        "error_type": "Reassignment",
                        "message": "`%s` is assigned more than once in this scope" % name,
                        "line_number": second_loc[0],
                        "column": second_loc[1],
                        "name_token": name,
                        "scope_kind": scope.kind,
                        "first_line_number": first_loc[0],
                        "first_column": first_loc[1],
                    })

    # ---- `global` / `nonlocal` keyword check ----
    # Both are disallowed at beginner and intermediate. We emit one finding
    # per declaration (not per name) so a `global x, y` produces a single
    # diagnostic on that line.
    kw_visitor = _PllKeywordVisitor()
    kw_visitor.visit(tree)
    for keyword, lineno, col, names in kw_visitor.found:
        primary = names[0] if names else ""
        findings.append({
            "id": "disallowed-keyword",
            "error_type": "DisallowedKeyword",
            "message": "`%s` is not allowed at the %s level" % (keyword, level),
            "line_number": lineno,
            "column": col,
            "name_token": primary,
            "scope_kind": "function",
            "keyword": keyword,
            "names": list(names),
        })

    # ---- mistakes that would otherwise run without a word ----
    silence = _PllSilenceVisitor()
    silence.scan(tree)
    for kind, lineno, col, token in silence.found:
        expression = silence._expressions.get((lineno, col))
        findings.append({
            "id": kind,
            "error_type": _PLL_SILENCE_TYPES[kind],
            "message": _PLL_SILENCE_MESSAGES[kind] % token if token else _PLL_SILENCE_MESSAGES[kind],
            "line_number": lineno,
            "column": col,
            "name_token": token,
            "scope_kind": "function",
            "written_type": silence._written_types.get((lineno, col)),
            # The student's own text, so the advice can say
            # `return order_amt + 4` rather than "`return` it".
            "expression": (
                _ast.get_source_segment(code, expression) if expression is not None else None
            ),
        })
    for name, lineno, col in silence.uncalled_test_functions():
        findings.append({
            "id": "test-not-named",
            "error_type": "NeverRun",
            "message": (
                "`%s` has an `assert` in it, but nothing runs it: a test has "
                "to be called `test_%s`" % (name, name)
            ),
            "line_number": lineno,
            "column": col,
            "name_token": name,
            "scope_kind": "module",
        })

    findings.sort(key=lambda f: (f["line_number"] or 0, f["column"] or 0))
    return findings
