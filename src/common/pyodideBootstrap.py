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
            check(getattr(self, field_name), [(field_name, hint)], memo)

    __init__.__name__ = "__init__"
    __init__.__qualname__ = "%s.__init__" % cls.__qualname__
    cls.__init__ = __init__
    return cls


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
# examplarLib borrows `_pll_fix_ast_ranges`.

import re as _pll_src_re

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
            raise FileNotFoundError(
                "There is no file called %r next to your program. Check the "
                "spelling, or pass an https:// address instead." % stripped
            ) from None
        except IsADirectoryError:
            raise IsADirectoryError("%r is a folder, not a file." % stripped) from None
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
    try:
        tree = _pll_parse_and_instrument(code, filename)
        _PllTopLevelExprWrapper().visit(tree)
        _ast.fix_missing_locations(tree)
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
        result["ok"] = True
    except SystemExit:
        result["ok"] = True
    except BaseException as e:
        formatted = _pll_format_exception(e)
        result["error_type"] = type(e).__name__
        result["error_message"] = str(e)
        result["traceback"] = formatted
        line_no, col = _pll_extract_loc(formatted, filename)
        result["line_number"] = line_no
        result["column"] = col
    finally:
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
        return "\n".join(lines)
    for raw in reversed((tb_text or "").splitlines()):
        stripped = raw.strip()
        if stripped.startswith("assert "):
            return stripped
    return "This test failed."


def _pll_is_async(fn):
    try:
        import inspect
        return inspect.iscoroutinefunction(fn)
    except Exception:
        return False


def _pll_call_test(fn):
    """Run one test function. Returns (outcome, message, stdout)."""
    import io

    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            if _pll_is_async(fn):
                return (
                    "error",
                    "async tests are not supported.",
                    buf.getvalue().strip() or None,
                )
            fn()
        return ("passed", None, buf.getvalue().strip() or None)
    except AssertionError as e:
        tb_text = "".join(_tb_mod.format_exception(type(e), e, e.__traceback__))
        return (
            "failed",
            _pll_friendly_assert_message(e, tb_text),
            buf.getvalue().strip() or None,
        )
    except BaseException as e:
        name = type(e).__name__
        if name == "Skipped":
            return ("skipped", str(e).strip() or None, buf.getvalue().strip() or None)
        return (
            "error",
            name + ": " + (str(e) or "this test raised an exception."),
            buf.getvalue().strip() or None,
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
        result["internal_error"] = True
        result["error_type"] = type(e).__name__
        result["error_message"] = str(e)
        result["line_number"] = e.lineno
        result["column"] = (e.offset - 1) if e.offset else None
        return result

    locs = _pll_test_locations(tree)
    try:
        from _pytest.assertion.rewrite import rewrite_asserts
        rewrite_asserts(tree, code.encode("utf-8"), module_path=display_name)
        # Do not call ast.fix_missing_locations here: it copies parent
        # positions onto pytest's injected nodes and yields ranges that
        # Python 3.12+ rejects (`end_lineno` < `lineno`).
        _pll_fix_ast_ranges(tree)
        compiled = compile(tree, display_name, "exec")
    except Exception:
        # Assert rewriting failed; keep the type instrumentation.
        compiled = compile(tree, display_name, "exec")

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
    for name, fn in _pll_iter_tests(ns):
        outcome, message, cap = _pll_call_test(fn)
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
        })

    result["passed"] = passed
    result["failed"] = failed
    result["skipped"] = skipped
    result["errors"] = errors
    result["tests"] = rows
    result["ok"] = failed == 0 and errors == 0
    result["stdout"] = stdout.getvalue()
    result["stderr"] = stderr.getvalue()
    result["displays"] = list(_pll_displays)
    return result


# -----------------------------------------------------------------------------
# REPL-style eval (statements + last-expression value)
# -----------------------------------------------------------------------------

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
                compiled_stmts = compile(tree, filename, "exec")
                exec(compiled_stmts, user_globals)
            if last_expr is not None:
                expr_module = _ast.Expression(body=last_expr.value)
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
        formatted = _pll_format_exception(e)
        result["error_type"] = type(e).__name__
        result["error_message"] = str(e)
        result["traceback"] = formatted
        line_no, col = _pll_extract_loc(formatted, filename)
        result["line_number"] = line_no
        result["column"] = col
    finally:
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
    __slots__ = ("node", "kind", "parent", "bindings")

    def __init__(self, node, kind, parent):
        self.node = node
        self.kind = kind        # "module" | "function" | "lambda" | "class" | "comprehension"
        self.parent = parent    # _PllScope | None
        # name -> [(lineno, col, kind, module), ...]. `module` is set only
        # for import bindings: the module the name was imported from.
        self.bindings = {}


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
            # These don't create bindings.
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
                if name in shadowed_in_scope:
                    continue
                if len(locs) > 1:
                    second_loc = locs[1]
                    first_loc = locs[0]
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

    findings.sort(key=lambda f: (f["line_number"] or 0, f["column"] or 0))
    return findings
