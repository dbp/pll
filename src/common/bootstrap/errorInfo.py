# Describing an exception for the host: the message as Python would display
# it, the line and column, the student's own frames, and the facts the
# explanations need (a name, a sequence and its length, ...) - as data, so
# no explanation ever has to parse Python's wording back out of a message.

import traceback as _tb_mod
import linecache as _pll_linecache
import ast as _ast
import re as _pll_src_re
import inspect as _pll_inspect

#: The checkers PLL gives typeguard for numbers, in place of its own.
_PLL_CHECKERS = ("_pll_check_int", "_pll_check_float")


def _pll_is_vendor_frame(filename, name=None):
    """Whether a frame is the type checker's: vendored typeguard, or one of
    the checkers PLL gives it, which do typeguard's job."""
    if not isinstance(filename, str):
        return False
    return filename.startswith(_PLL_VENDOR_DIR) or (
        filename == "<pll:bootstrap/typeChecking>" and name in _PLL_CHECKERS
    )


#: How typeguard words what failed: `<subject> (<actual type>) <predicate>`.
_PLL_TC_PREDICATES = (
    (_pll_src_re.compile(r"^(.*) is not an instance of (.+)$"), lambda m: [m.group(2)]),
    (_pll_src_re.compile(r"^(.*) is neither float or int$"), lambda m: ["float"]),
    (_pll_src_re.compile(r"^(.*) is not None$"), lambda m: ["None"]),
    (_pll_src_re.compile(r"^(.*) is not a ([A-Za-z_][A-Za-z0-9_]*)$"), lambda m: [m.group(2)]),
)
_PLL_TC_UNION = " did not match any element in the union:"
_PLL_TC_UNION_MEMBER_RE = _pll_src_re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_.\[\], ]*):")
_PLL_TC_ACTUAL_RE = _pll_src_re.compile(r"^(.*) \(([^()]*)\)$")
#: Something inside a collection: `item 2 of argument "nums"`.
_PLL_TC_ELEMENT_RE = _pll_src_re.compile(r"^(item \d+|key .+|value of key .+|\[.+\]) of (.+)$")
_PLL_TC_ARGUMENT_RE = _pll_src_re.compile(r'^argument "(.+)"$')
_PLL_TC_ASSIGNED_RE = _pll_src_re.compile(r"^value assigned to (.+)$")


def _pll_type_check_parts(message):
    """typeguard's message, read once into its parts, for the host.

    `kind` is what the annotation is on - "argument", "return", "variable",
    or "unknown" when the wording is unfamiliar - `name` its name, `element`
    typeguard's words for the part of a collection that failed ("item 2",
    "value of key 'a'"), `actual` the type the value had, and `expected`
    the types the annotation accepts.
    """
    lines = message.split("\n")
    first = lines[0].strip()
    parts = {"kind": "unknown", "name": None, "element": None, "actual": None, "expected": []}
    subject = None
    at = first.find(_PLL_TC_UNION)
    if at >= 0:
        subject = first[:at]
        for raw in lines[1:]:
            member = _PLL_TC_UNION_MEMBER_RE.match(raw)
            if member:
                parts["expected"].append(member.group(1).strip())
    else:
        for pattern, pick in _PLL_TC_PREDICATES:
            found = pattern.match(first)
            if found:
                subject = found.group(1)
                parts["expected"] = pick(found)
                break
    if subject is None:
        return parts
    actual = _PLL_TC_ACTUAL_RE.match(subject)
    if actual:
        subject, parts["actual"] = actual.group(1), actual.group(2)
    element = _PLL_TC_ELEMENT_RE.match(subject)
    if element:
        parts["element"], subject = element.group(1), element.group(2)
    argument = _PLL_TC_ARGUMENT_RE.match(subject)
    assigned = _PLL_TC_ASSIGNED_RE.match(subject)
    if subject == "the return value":
        parts["kind"] = "return"
    elif argument:
        parts["kind"], parts["name"] = "argument", argument.group(1)
    elif assigned:
        parts["kind"], parts["name"] = "variable", assigned.group(1)
    return parts


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
        if _pll_is_students(tb.tb_frame.f_code.co_filename):
            frames.append((tb.tb_frame, tb.tb_lineno))
        tb = tb.tb_next
    return frames


def _pll_source_line(filename, lineno, run):
    """Line `lineno` of `filename`, as it ran.

    `run` is `(filename, code)` for what was run: its code is read from
    there, since a prompt line is in no file and a run file need not be on
    disk. Any other file is read from disk.
    """
    if run is not None and filename == run[0]:
        lines = run[1].split("\n")
        return lines[lineno - 1] if 0 < lineno <= len(lines) else ""
    _pll_linecache.checkcache(filename)
    return _pll_linecache.getline(filename, lineno).rstrip("\n")


def _pll_enrich_index_error(exc, run):
    """Record how long the list really is, for an `IndexError`.

    "list index out of range" says nothing about the list, and the
    explanation was left to illustrate with a made-up list of 3. The frame
    the error was raised in holds the real one, and the line says which
    name was subscripted.
    """
    if type(exc) is not IndexError or "out of range" not in str(exc):
        return
    frames = _pll_student_frames(exc)
    if not frames:
        return
    frame, lineno = frames[-1]
    text = _pll_source_line(frame.f_code.co_filename, lineno, run)
    for name in _pll_src_re.findall(r"([A-Za-z_]\w*)\s*\[", text):
        value = frame.f_locals.get(name, frame.f_globals.get(name))
        if isinstance(value, (list, tuple, str)):
            _pll_add_facts(exc, sequence=name, length=len(value))
            return


def _pll_enrich_type_check(exc):
    """Record what failed its annotation, as parts (`check`) - and, for an
    element of an argument, what the element actually is.

    typeguard names the element that failed - "item 0 of argument "lst"
    (list) is not an instance of float" - but not what it is, which is the
    one thing a student needs to see: here, the string "1". The value is
    only reachable from the frame the check fired in.

    Only frames from the student's own files are searched: typeguard's own
    functions have locals with ordinary names like `value`, and finding one
    of those first would describe the wrong thing.
    """
    if type(exc).__name__ != "TypeCheckError" or not exc.args:
        return
    # A check PLL raised itself has its parts already.
    check = (getattr(exc, "_pll_facts", None) or {}).get("check")
    if check is None:
        check = _pll_type_check_parts(str(exc))
        _pll_add_facts(exc, check=check)
    element, name = check.get("element"), check.get("name")
    if check["kind"] != "argument" or element is None:
        return
    item = _pll_src_re.match(r"^item (\d+)$", element)
    keyed = _pll_src_re.match(r"^value of key (.+)$", element)
    if item is None and keyed is None:
        return
    for frame, _line in reversed(_pll_student_frames(exc)):
        if name in frame.f_locals:
            container = frame.f_locals[name]
            break
    else:
        return
    try:
        value = container[int(item.group(1))] if item else container[_ast.literal_eval(keyed.group(1))]
    except Exception:
        return
    _pll_add_facts(exc, element_value=_pll_describe(value))


def _pll_format_exception(exc):
    """`format_exception`, minus frames inside the vendored type checker.

    A typeguard failure otherwise ends in several frames of typeguard's
    own checker, burying the student's line under machinery they did not
    write. When nothing is dropped this returns the stdlib formatting
    unchanged, so ordinary errors look exactly as they did before.
    """
    try:
        frames = _tb_mod.extract_tb(exc.__traceback__)
        kept = [f for f in frames if not _pll_is_vendor_frame(f.filename, f.name)]
        if len(kept) == len(frames):
            return "".join(_tb_mod.format_exception(type(exc), exc, exc.__traceback__))
        parts = ["Traceback (most recent call last):\n"]
        parts.extend(_tb_mod.StackSummary.from_list(kept).format())
        parts.extend(_tb_mod.format_exception_only(type(exc), exc))
        return "".join(parts)
    except BaseException:
        return "".join(_tb_mod.format_exception(type(exc), exc, exc.__traceback__))


#: Files that are not the student's: the vendored type checker, the
#: standard library, installed packages, and pytest.
_PLL_NOT_STUDENT = (_PLL_VENDOR_DIR, "site-packages", "/lib/python", "_pytest", "pluggy")


def _pll_is_students(filename):
    """Whether a frame in `filename` runs the student's code: one of their
    files, or a prompt line (`<repl>`). Any other `<...>` is code no file
    holds - PLL's own (`<pll:...>`), or code Python made from a string
    (`<string>`, as `typing` and `dataclasses` do, and `<frozen ...>`).
    """
    if filename == "<repl>":
        return True
    if filename.startswith("<"):
        return False
    return not any(token in filename for token in _PLL_NOT_STUDENT)

#: How Python words a name used before it has a value.
_PLL_UNBOUND_RE = _pll_src_re.compile(r"cannot access (?:free|local) variable '(\w+)'")

#: Innermost frames sent with an error. A `RecursionError` has a thousand,
#: and the rules that read frames want only the last few.
_PLL_MAX_FRAMES = 100


def _pll_shown_file(filename):
    """A file as the student knows it: one next to their program by its own
    name, rather than the work directory's path."""
    prefix = _PLL_WORK_DIR + "/"
    if isinstance(filename, str) and filename.startswith(prefix):
        return filename[len(prefix) :]
    return filename


def _pll_parameters(code):
    """The parameters of the function `code` runs, or None at module level."""
    if code.co_name == "<module>":
        return None
    count = code.co_argcount + code.co_kwonlyargcount
    count += bool(code.co_flags & _pll_inspect.CO_VARARGS)
    count += bool(code.co_flags & _pll_inspect.CO_VARKEYWORDS)
    return list(code.co_varnames[:count])


def _pll_frame_text(summary, run):
    """The student's line a frame is at, as written, or None."""
    return _pll_source_line(summary.filename, summary.lineno, run) or None


def _pll_frame_column(summary, run):
    """The 0-based column `summary`'s frame failed at, or None.

    None where Python's own traceback draws no caret: when it has no source
    for the line, or when the failing expression is the whole line.
    """
    if summary.colno is None or summary.end_colno is None:
        return None
    text = _pll_source_line(summary.filename, summary.lineno, run)
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


def _pll_error_info(exc, run=None):
    """Everything the host needs to report `exc`, as data.

    The one place an exception becomes a result, for a file run, a prompt
    line, a test and a reactor alike. The host reads these
    fields rather than the traceback text: `traceback` is kept only to show
    when nothing better can be said.

    `run` is `(filename, code)` for what was run, which the lines of its
    frames are read from (see `_pll_source_line`).

    - `error_frames`: outermost first, each `{file, line, column, function,
      user, text, parameters}`, where `user` says whether the frame runs the
      student's code, and `text` and `parameters` are their line there and
      the parameters of their function.
    - `error_facts`: what was learned from the live frames - the name a
      `NameError` is about, a sequence's real length, the value that failed
      its annotation, a swapped field - and from the code (`_pll_code_facts`).
    """
    _pll_enrich_type_check(exc)
    _pll_enrich_index_error(exc, run)
    # The same frames twice over: summaries for their lines, and the live
    # ones for the code they run.
    entries = [
        (s, live.f_code)
        for s, (live, _line) in zip(_tb_mod.extract_tb(exc.__traceback__), _tb_mod.walk_tb(exc.__traceback__))
        if not _pll_is_vendor_frame(s.filename, s.name)
    ][-_PLL_MAX_FRAMES:]
    frames = []
    for s, code in entries:
        user = _pll_is_students(s.filename)
        frames.append({
            "file": _pll_shown_file(s.filename),
            "line": s.lineno,
            "column": _pll_frame_column(s, run),
            "function": None if s.name == "<module>" else s.name,
            "user": user,
            # The line itself, so the host never reads it out of the wrong
            # file: a frame can be in any of the student's files.
            "text": _pll_frame_text(s, run) if user else None,
            "parameters": _pll_parameters(code) if user else None,
        })
    facts = dict(getattr(exc, "_pll_facts", None) or {})
    try:
        facts.update(_pll_code_facts(exc, run))
    except Exception:
        # Facts only add to an explanation; the error itself still has to
        # be reported if reading them fails.
        pass
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
            "file": _pll_shown_file(exc.filename),
            "line": exc.lineno,
            "column": exc.offset - 1 if exc.offset else None,
            "text": exc.text.rstrip("\n") if exc.text else None,
        }
    elif frames:
        where = frames[-1]
    else:
        where = {"file": None, "line": None, "column": None, "text": None}
    return {
        "error_type": type(exc).__name__,
        "error_message": _pll_displayed_message(exc),
        "traceback": _pll_format_exception(exc),
        "error_file": where["file"],
        "line_number": where["line"],
        "column": where["column"],
        "error_text": where.get("text"),
        "error_frames": frames,
        "error_facts": facts,
    }
