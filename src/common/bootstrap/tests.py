# Tests: the file's own `test_*` functions and `Test*` classes, collected
# the way pytest collects them and run one at a time - not `pytest.main()`,
# which cannot safely be called repeatedly in one interpreter.

import traceback as _tb_mod
import ast as _ast
import contextlib
import sys as _sys
import types as _pll_types
import re as _pll_src_re

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

    Returns `(outcome, message, stdout, error)`. `error` is the
    `_pll_error_info` of a test that raised, for the host's explanations;
    the message is the one line a report has room for.
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
        return (
            "error",
            name + ": " + (str(e) or "this test raised an exception."),
            buf.getvalue().strip() or None,
            _pll_error_info(e, code),
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
    result.update(_pll_error_info(error))
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
    result = _pll_tests_result()
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
        return _pll_with_output(result, stdout, stderr)
    except BaseException as e:
        result["internal_error"] = True
        result.update(_pll_error_info(e, code))
        return _pll_with_output(result, stdout, stderr)

    rows = []
    passed = failed = errors = skipped = 0
    current = None
    try:
        for name, fn in _pll_iter_tests(ns):
            current = name
            outcome, message, cap, error = _pll_call_test(fn, code)
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
                "error": error,
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
                "error": None,
            })

    result["passed"] = passed
    result["failed"] = failed
    result["skipped"] = skipped
    result["errors"] = errors
    result["tests"] = rows
    result["ok"] = failed == 0 and errors == 0 and not result.get("stopped")
    return _pll_with_output(result, stdout, stderr)
