# Describing an exception for the host: the message as Python would display
# it, the line and column, the student's own frames, and the facts the
# explanations need (a name, a sequence and its length, ...) - as data, so
# no explanation ever has to parse Python's wording back out of a message.

import traceback as _tb_mod
import linecache as _pll_linecache
import ast as _ast
import re as _pll_src_re

def _pll_is_vendor_frame(filename):
    return isinstance(filename, str) and filename.startswith(_PLL_VENDOR_DIR)


#: An element failure on an argument: `item 0 of argument "lst" (list) ...`
#: or `value of key 'a' of argument "d" (dict) ...`.
_PLL_ELEMENT_FAILURE_RE = _pll_src_re.compile(
    r'^(item (\d+)|value of key (.+?)) of argument "(\w+)" '
)


def _pll_add_facts(exc, **facts):
    """Record what was learned about `exc` for the host's explanations.

    Facts travel beside the message, never in it: the message stays the one
    Python wrote, and the host reads a fact by name rather than by pattern.
    """
    try:
        known = getattr(exc, "_pll_facts", None) or {}
        known.update(facts)
        exc._pll_facts = known
    except Exception:
        pass


def _pll_student_frames(exc):
    """The live frames of `exc`'s traceback that run the student's code."""
    frames = []
    tb = exc.__traceback__
    while tb is not None:
        filename = tb.tb_frame.f_code.co_filename
        if not _pll_is_vendor_frame(filename) and filename != "<exec>":
            frames.append((tb.tb_frame, tb.tb_lineno))
        tb = tb.tb_next
    return frames


def _pll_enrich_index_error(exc, code):
    """Record how long the list really is, for an `IndexError`.

    "list index out of range" says nothing about the list, and the
    explanation was left to illustrate with a made-up list of 3. The frame
    the error was raised in holds the real one, and the line says which
    name was subscripted.
    """
    if type(exc) is not IndexError or "out of range" not in str(exc):
        return
    frames = _pll_student_frames(exc)
    if not frames or not code:
        return
    frame, lineno = frames[-1]
    lines = code.split("\n")
    if not 0 < lineno <= len(lines):
        return
    for name in _pll_src_re.findall(r"([A-Za-z_]\w*)\s*\[", lines[lineno - 1]):
        value = frame.f_locals.get(name, frame.f_globals.get(name))
        if isinstance(value, (list, tuple, str)):
            _pll_add_facts(exc, sequence=name, length=len(value))
            return


def _pll_enrich_type_check(exc):
    """Record what the offending element actually is, for an element failure.

    typeguard names the element that failed - "item 0 of argument "lst"
    (list) is not an instance of float" - but not what it is, which is the
    one thing a student needs to see: here, the string "1". The value is
    only reachable from the frame the check fired in.

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
    for frame, _line in reversed(_pll_student_frames(exc)):
        if name in frame.f_locals:
            container = frame.f_locals[name]
            break
    else:
        return
    try:
        if match.group(2) is not None:
            element = container[int(match.group(2))]
        else:
            element = container[_ast.literal_eval(match.group(3))]
    except Exception:
        return
    _pll_add_facts(exc, element_value=_pll_describe(element))


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


#: Frames that are not the student's: PLL's own bootstrap and libraries
#: (`<exec>`), the vendored type checker, the standard library, installed
#: packages, and pytest.
_PLL_NOT_STUDENT = ("<exec>", _PLL_VENDOR_DIR, "site-packages", "/lib/python", "_pytest", "pluggy")

#: How Python words a name used before it has a value.
_PLL_UNBOUND_RE = _pll_src_re.compile(r"cannot access (?:free|local) variable '(\w+)'")

#: Innermost frames sent with an error. A `RecursionError` has a thousand,
#: and the rules that read frames want only the last few.
_PLL_MAX_FRAMES = 100


def _pll_frame_column(summary):
    """The 0-based column `summary`'s frame failed at, or None.

    None where Python's own traceback draws no caret: when it has no source
    for the line, or when the failing expression is the whole line.
    """
    if summary.colno is None or summary.end_colno is None:
        return None
    text = _pll_linecache.getline(summary.filename, summary.lineno).rstrip("\n")
    if not text:
        return None
    # Python counts these in UTF-8 bytes; a column counts characters.
    encoded = text.encode("utf-8")
    start = len(encoded[: summary.colno].decode("utf-8", "replace"))
    if summary.end_lineno == summary.lineno:
        end = len(encoded[: summary.end_colno].decode("utf-8", "replace"))
        if text[:start].strip() == "" and text[end:].strip() == "":
            return None
    return start


def _pll_displayed_message(exc):
    """The message as Python's traceback shows it.

    Not always `str(exc)`: Python adds its suggestion ("Did you mean:
    'total'?") to a `NameError` or `AttributeError` only when it displays
    one, and a `SyntaxError`'s `str` carries the file and line, which the
    display puts elsewhere.
    """
    exc_type = type(exc)
    shown = exc_type.__qualname__
    if exc_type.__module__ not in ("__main__", "builtins"):
        shown = "%s.%s" % (exc_type.__module__, shown)
    try:
        lines = _tb_mod.TracebackException(
            exc_type, exc, exc.__traceback__, limit=0, compact=True
        ).format_exception_only()
        for text in lines:
            if text.startswith(shown + ": "):
                return text[len(shown) + 2 :].rstrip("\n")
            if text.rstrip("\n") == shown:
                return ""
    except Exception:
        pass
    return exc.msg if isinstance(exc, SyntaxError) else str(exc)


def _pll_error_info(exc, code=""):
    """Everything the host needs to report `exc`, as data.

    The one place an exception becomes a result, for a file run, a prompt
    line, the test phase, a test and a reactor alike. The host reads these
    fields rather than the traceback text: `traceback` is kept only to show
    when nothing better can be said.

    - `error_frames`: outermost first, each `{file, line, column, function,
      user}`, where `user` says whether the frame runs the student's code.
    - `error_facts`: what was learned from the live frames - the name a
      `NameError` is about, a sequence's real length, the value that failed
      its annotation, a swapped field.
    """
    _pll_enrich_type_check(exc)
    _pll_enrich_index_error(exc, code)
    summaries = [
        s for s in _tb_mod.extract_tb(exc.__traceback__) if not _pll_is_vendor_frame(s.filename)
    ][-_PLL_MAX_FRAMES:]
    frames = [
        {
            "file": s.filename,
            "line": s.lineno,
            "column": _pll_frame_column(s),
            "function": None if s.name == "<module>" else s.name,
            "user": not any(token in s.filename for token in _PLL_NOT_STUDENT),
        }
        for s in summaries
    ]
    facts = dict(getattr(exc, "_pll_facts", None) or {})
    if isinstance(exc, NameError):
        # Python sets `name` for most of these, but not for a local read
        # before it is assigned; its message names it either way.
        name = getattr(exc, "name", None)
        if not isinstance(name, str):
            found = _PLL_UNBOUND_RE.search(str(exc))
            name = found.group(1) if found else None
        if name is not None:
            facts["name"] = name
    if isinstance(exc, SyntaxError):
        where = {
            "file": exc.filename,
            "line": exc.lineno,
            "column": exc.offset - 1 if exc.offset else None,
        }
    elif frames:
        where = frames[-1]
    else:
        where = {"file": None, "line": None, "column": None}
    return {
        "error_type": type(exc).__name__,
        "error_message": _pll_displayed_message(exc),
        "traceback": _pll_format_exception(exc),
        "error_file": where["file"],
        "line_number": where["line"],
        "column": where["column"],
        "error_frames": frames,
        "error_facts": facts,
    }
