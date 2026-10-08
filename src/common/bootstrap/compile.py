# Compiling the student's code: the AST passes that check top-level
# annotations and dataclass fields, show top-level expression values, and
# turn Python's compile-time warnings into something a beginner can act on.

import ast as _ast
import copy as _pll_copy
import contextlib
import sys as _sys
import warnings as _pll_warnings
import re as _pll_src_re

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
    if not _PLL_TYPEGUARD_READY:
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
                expected = _pll_hint_name(hint)
                error = _pll_type_check_error(
                    "field %r of %r got %s (%s), not %s"
                    % (field_name, cls.__name__, shown, type(bad).__name__, expected)
                )
                # The parts, as `_pll_type_check_parts` gives typeguard's.
                _pll_add_facts(error, check={
                    "kind": "field",
                    "name": field_name,
                    "element": None,
                    "actual": type(bad).__name__,
                    "expected": [expected],
                    "owner": cls.__name__,
                    "value": shown,
                    "level": defining_globals.get("__pll_level__"),
                })
                if swapped:
                    _pll_add_facts(error, swapped_with=swapped)
                raise error from None

    __init__.__name__ = "__init__"
    __init__.__qualname__ = "%s.__init__" % cls.__qualname__
    # So `inspect.signature` gives the fields, not `*args, **kwargs`.
    __init__.__wrapped__ = original
    cls.__init__ = __init__
    return cls


#: Compile-time warnings for the current file: `(line, message)`, each once.
_pll_compile_warnings = []


@contextlib.contextmanager
def _pll_recording_compile_warnings():
    """Record `SyntaxWarning`s from PLL's own parses and compiles instead
    of printing them.

    A run parses and compiles the file more than once - the type-check
    instrumentation is validated by compiling it, then the real compile
    follows - and so does importing one of the student's files, and Python
    prints a `SyntaxWarning` on every one.

    Recorded here, by file and line, and said once, after the run, by
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
                entry = (warning.filename, warning.lineno, str(warning.message))
                if entry not in _pll_compile_warnings:
                    _pll_compile_warnings.append(entry)
            else:
                _pll_warnings.warn_explicit(
                    warning.message, warning.category, warning.filename, warning.lineno
                )


@contextlib.contextmanager
def _pll_without_syntax_warnings():
    """For a parse of a file that a run parses too - the static checks',
    the test finder's - which the run's own warnings already cover."""
    with _pll_warnings.catch_warnings():
        _pll_warnings.simplefilter("ignore", SyntaxWarning)
        yield


def _pll_say_compile_warnings(stream, error_message, source="", filename=None):
    """Say each recorded warning once - unless the run's error already did.

    A warning that predicts the error the run then raised (`'int' object is
    not callable; perhaps you missed a comma?` before `TypeError: 'int'
    object is not callable`) is covered by the finding for that error, and
    printing it beside the finding says the same thing worse. One whose
    line never ran is the only sign of the mistake, so that one is said.

    `source` is the text of `filename`, the file run; a warning about a
    file it imported names that file.
    """
    lines = source.split("\n") if source else []
    for where, lineno, message in _pll_compile_warnings:
        if error_message and message.startswith(error_message):
            continue
        if filename is None or where == filename:
            text = lines[lineno - 1] if isinstance(lineno, int) and 0 < lineno <= len(lines) else ""
            stream.write("warning: line %s: %s\n" % (lineno, _pll_reword_warning(message, text)))
        else:
            stream.write(
                "warning: %s, line %s: %s\n" % (_pll_shown_file(where), lineno, _pll_reword_warning(message))
            )
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


def _pll_parse_and_instrument(code, filename, level):
    """Parse `code`, adding the runtime type checks of its `level` when they
    are available.

    Instrumentation is attempted on a second parse and validated by
    compiling it, so anything typeguard cannot handle falls back to the
    plain tree rather than failing the run.
    """
    with _pll_recording_compile_warnings():
        tree = _ast.parse(code, filename=filename, mode="exec")
        if not _pll_checks_annotations(level) or not _PLL_TYPEGUARD_READY:
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
