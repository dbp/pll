# Tests: the file's own `test_*` functions and `Test*` classes, collected
# the way pytest collects them from the namespace the program made, and run
# one at a time once it has finished - not `pytest.main()`, which cannot
# safely be called repeatedly in one interpreter. pytest is used only to
# rewrite assertions (`_pll_rewrite_asserts`, applied by `_pll_run_file`).

import traceback as _tb_mod
import ast as _ast
import contextlib
import re as _pll_src_re

def _pll_has_tests(code):
    """Return True if `code` looks like it contains pytest tests.

    Mirrors pytest's default collection: module-level `test_*` functions
    and `test_*` methods on `Test*` classes. Used so we can skip loading
    pytest for files that have no tests.
    """
    try:
        with _pll_without_syntax_warnings():
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


def _pll_marks(fn):
    """The pytest marks on a test: `[(name, args, kwargs)]`."""
    marks = []
    for mark in getattr(fn, "pytestmark", None) or []:
        name = getattr(mark, "name", None)
        if isinstance(name, str):
            marks.append((name, tuple(getattr(mark, "args", ())), dict(getattr(mark, "kwargs", {}))))
    return marks


def _pll_mark_condition(args, kwargs, fn):
    """Whether a `skipif` / `xfail` mark's condition holds: none is true; a
    string is evaluated in the test's module, as pytest does. A method's
    module is the one `_pll_iter_tests` noted."""
    conditions = args if args else ((kwargs["condition"],) if "condition" in kwargs else ())
    if not conditions:
        return True
    for condition in conditions:
        if isinstance(condition, str):
            try:
                module = getattr(fn, "pll_module", None) or getattr(fn, "__globals__", {})
                condition = eval(condition, module)
            except Exception:
                condition = False
        if condition:
            return True
    return False


def _pll_call_test(fn, run=None):
    """Run one test function, as pytest would - its `skip`, `skipif` and
    `xfail` marks included.

    Returns `(outcome, message, stdout, error)`. `error` is the
    `_pll_error_info` of a test that raised, for the host's explanations;
    the message is the one line a report has room for. A test expected to
    fail that does is "skipped", saying so; one that passes anyway passes,
    unless its mark is `strict`.
    """
    expected_failure = None
    for name, args, kwargs in _pll_marks(fn):
        reason = kwargs.get("reason") or (args[0] if name == "skip" and args else None)
        if name == "skip" or (name == "skipif" and _pll_mark_condition(args, kwargs, fn)):
            return ("skipped", reason if isinstance(reason, str) and reason else None, None, None)
        if name == "xfail" and _pll_mark_condition(args, kwargs, fn):
            expected_failure = (reason if isinstance(reason, str) else "", bool(kwargs.get("strict")))
    outcome = _pll_call_test_body(fn, run)
    if expected_failure is not None:
        reason, strict = expected_failure
        if outcome[0] in ("failed", "error"):
            said = "expected to fail" + (": " + reason if reason else "") + ", and did."
            return ("skipped", said, outcome[2], None)
        if outcome[0] == "passed" and strict:
            said = "expected to fail" + (": " + reason if reason else "") + ", but passed."
            return ("failed", said, outcome[2], None)
    return outcome


def _pll_call_test_body(fn, run):
    import io

    buf = io.StringIO()
    stops = _pll_stops_delivered
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
    except KeyboardInterrupt as e:
        # A Stop, not something this test did wrong: it ends the tests, so
        # it is not recorded as this one's error and passed over. One the
        # test raised itself is its error, like any other.
        if _pll_stops_delivered != stops:
            raise
        return _pll_test_error(e, buf, run)
    except AssertionError as e:
        tb_text = "".join(_tb_mod.format_exception(type(e), e, e.__traceback__))
        return (
            "failed",
            _pll_friendly_assert_message(e, tb_text),
            buf.getvalue().strip() or None,
            None,
        )
    except BaseException as e:
        name = type(e).__name__
        if name == "Skipped":
            return (
                "skipped",
                str(e).strip() or None,
                buf.getvalue().strip() or None,
                None,
            )
        if name == "XFailed":
            # `pytest.xfail("reason")`: the test says it is expected to fail.
            reason = str(e).strip()
            return (
                "skipped",
                "expected to fail" + (": " + reason if reason else "") + ".",
                buf.getvalue().strip() or None,
                None,
            )
        return _pll_test_error(e, buf, run)


def _pll_test_error(e, buf, run):
    """The outcome of a test that raised `e`, which was not an assertion."""
    return (
        "error",
        type(e).__name__ + ": " + (_pll_linux_errno(str(e), e) or "this test raised an exception."),
        buf.getvalue().strip() or None,
        _pll_error_info(e, run),
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

            # pytest reads marks from the method and from its class.
            _bound.pytestmark = list(getattr(attr, "pytestmark", None) or []) + list(
                getattr(obj, "pytestmark", None) or []
            )
            _bound.pll_module = getattr(attr, "__globals__", None)
            yield name + "::" + meth_name, _bound


def _pll_rewrite_asserts(tree, code, filename):
    """Rewrite `tree`'s asserts the way pytest does, so a failure says
    `assert 4 == 5` rather than nothing. In place; if it fails, the file
    still runs, with plain `AssertionError`s.
    """
    try:
        from _pytest.assertion.rewrite import rewrite_asserts

        rewrite_asserts(tree, code.encode("utf-8"), module_path=filename)
        # Do not call ast.fix_missing_locations after this: it copies parent
        # positions onto pytest's injected nodes and yields ranges that
        # Python 3.12+ rejects (`end_lineno` < `lineno`).
        _pll_fix_ast_ranges(tree)
    except Exception:
        # It mutates the tree as it goes, so what is compiled is whatever it
        # managed; a failure then shows an empty AssertionError, which is
        # worse than nothing but still runs.
        pass


def _pll_tests_result():
    """The tests' part of a run's result, before any has run."""
    return {"passed": 0, "failed": 0, "skipped": 0, "errors": 0, "tests": []}


def _pll_run_collected_tests(ns, locs, run):
    """Run the `test_*` functions and `Test*` classes the program defined.

    `ns` is the program's own namespace, so the tests see exactly what it
    made; `run` is `(filename, code)` for the program, as `_pll_error_info`
    takes it. A Stop ends them: the tests that finished keep their results, the
    one running is marked as where it stopped, and the rest are not run.
    """
    result = _pll_tests_result()
    rows = result["tests"]
    current = None
    try:
        for name, fn in _pll_iter_tests(ns):
            current = name
            outcome, message, cap, error = _pll_call_test(fn, run)
            result[{"passed": "passed", "failed": "failed", "skipped": "skipped"}.get(outcome, "errors")] += 1
            rows.append({
                "name": name,
                "outcome": outcome,
                "line_number": locs.get(name),
                "message": message,
                "stdout": cap,
                # For the host's explainers only; never shown to a student.
                "error": error,
            })
    except KeyboardInterrupt:
        result["stopped"] = True
        result["stopped_in"] = current
        if current is not None:
            rows.append({
                "name": current,
                "outcome": "stopped",
                "line_number": locs.get(current),
                "message": None,
                "stdout": None,
                "error": None,
            })
    return result
