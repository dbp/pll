# Running: a whole file, a prompt line, and whether a prompt line is
# complete yet. Each returns a JSON-friendly dict.

import ast as _ast
import codeop as _codeop
import contextlib
import os as _pll_os

# -----------------------------------------------------------------------------
# Ending a program
# -----------------------------------------------------------------------------


class _PllExit(SystemExit):
    """`os._exit()` or `os.abort()`, ending the program and nothing more.

    In CPython each ends the whole process at once. Here the process is the
    one interpreter every open file's session shares, and Pyodide does not
    recover from it: every later run, of any file, failed with "Pyodide
    already exited" until the window was reloaded. Raised instead, they end
    the program the way `sys.exit()` does, and Python carries on.
    """


def _pll_os_exit(status):
    raise _PllExit(status)


def _pll_os_abort():
    raise _PllExit(134)


def _pll_exit_status(exc, stderr):
    """The status a process ending with `exc` exits with, as CPython decides.

    `sys.exit()` is 0 and `sys.exit(3)` is 3. Anything else, such as
    `sys.exit("no data file")`, is written to stderr - the student's message
    is the point of writing it that way - and the status is 1.
    """
    code = exc.code
    if code is None:
        return 0
    if isinstance(code, int):
        # `int`, so `SystemExit(True)` is 1 rather than crossing to the host
        # as a boolean.
        return int(code)
    stderr.write("%s\n" % (code,))
    return 1


# Their own names, so a mistake in calling one reads as it would in Python.
_pll_os_exit.__name__ = _pll_os_exit.__qualname__ = "_exit"
_pll_os_abort.__name__ = _pll_os_abort.__qualname__ = "abort"
_pll_os._exit = _pll_os_exit
_pll_os.abort = _pll_os_abort

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

def _pll_reset_notes():
    """Forget what the last run had to say at its end."""
    reset = globals().get("_pll_reset_reactor_notes")
    if reset is not None:
        reset()


def _pll_run_notes():
    """What is worth saying once the program has finished, as stderr text.

    Not an error: the program ran. It is the case where it ran and visibly
    did nothing, and the student has no other evidence of why - today, a
    reactor that was built and never started. Looked up rather than named
    so the bootstrap does not depend on the reactor library, which loads
    after it.
    """
    note = globals().get("_pll_reactor_note")
    if note is None:
        return ""
    try:
        return note() or ""
    except Exception:
        # A note is a courtesy; it must never take the run down with it.
        return ""


def _pll_no_error():
    """The error fields of a result that reports none."""
    return {
        "error_type": None,
        "error_message": None,
        "traceback": None,
        "error_file": None,
        "line_number": None,
        "column": None,
        "error_frames": [],
        "error_facts": {},
    }


def _pll_run_result():
    """A file run's or prompt line's result, before anything has happened.

    `exit_code` is set only when the program ended itself, with `sys.exit`;
    `tests` only when its tests were asked for and it finished, so they ran.
    """
    result = {
        "ok": False,
        "stdout": "",
        "stderr": "",
        "result_repr": None,
        "displays": [],
        "exit_code": None,
        "tests": None,
    }
    result.update(_pll_no_error())
    return result


def _pll_with_output(result, stdout, stderr):
    """`result`, with what the run printed and showed."""
    result["stdout"] = stdout.getvalue()
    result["stderr"] = stderr.getvalue()
    result["displays"] = list(_pll_displays)
    return result


def _pll_stopped_run():
    """A run's result when Stop landed before any of the student's code ran."""
    result = _pll_run_result()
    result.update(error_type="KeyboardInterrupt", error_message="")
    return result


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
def _pll_run_file(code, filename, session_key, level=_PLL_LEVEL_RAW, run_tests=False):
    """Run a file as its program, and then - if asked, and if it finished -
    its own `test_*` functions, against the names the program defined.

    The file is executed once: the tests run in the program's namespace,
    after its top-level code. `run_tests` needs pytest loaded, for its
    assertion rewriting.
    """
    stdout = _PllStream("stdout")
    stderr = _PllStream("stderr")
    result = _pll_run_result()
    # Each Run File starts with a clean slate for this session: discard any
    # names defined by a previous Run File of the same session or by REPL
    # exploration since then.
    _pll_apply_level(level)
    _pll_protect_import_path()
    user_globals = _pll_reset_session(session_key, level)
    main = _pll_session_module(session_key)
    _pll_displays.clear()
    _pll_reset_notes()
    del _pll_compile_warnings[:]
    try:
        tree = _pll_parse_and_instrument(code, filename)
        # Where each test is, read before anything is added to the tree.
        tests_at = _pll_test_locations(tree) if run_tests else None
        _PllTopLevelExprWrapper().visit(tree)
        _ast.fix_missing_locations(tree)
        if run_tests:
            _pll_rewrite_asserts(tree, code, filename)
        with _pll_recording_compile_warnings():
            compiled = compile(tree, filename, "exec")
    except SyntaxError as e:
        result.update(_pll_error_info(e, (filename, code)))
        return _pll_with_output(result, stdout, stderr)

    finished = False
    try:
        with _pll_as_main(main), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            exec(compiled, user_globals)
            # Only once the program has finished: building a reactor and
            # starting it further down is perfectly ordinary.
            stderr.write(_pll_run_notes())
        result["ok"] = True
        finished = True
    except SystemExit as e:
        result["ok"] = True
        result["exit_code"] = _pll_exit_status(e, stderr)
    except BaseException as e:
        result.update(_pll_error_info(e, (filename, code)))
    finally:
        # After the run, so a warning the run's own error explains can be
        # left out, and one about a line that never ran can be said.
        _pll_say_compile_warnings(stderr, result["error_message"], code)
        _pll_with_output(result, stdout, stderr)
    # A program that raised, stopped or exited did not get to the end, and
    # neither do its tests: the host says they were not run, and why.
    if run_tests and finished:
        with _pll_as_main(main):
            result["tests"] = _pll_run_collected_tests(user_globals, tests_at, (filename, code))
    return result


# -----------------------------------------------------------------------------
# REPL-style eval (statements + last-expression value)
# -----------------------------------------------------------------------------

@_pll_stoppable(_pll_stopped_run)
def _pll_repl_eval(code, session_key, level=_PLL_LEVEL_RAW):
    stdout = _PllStream("stdout")
    stderr = _PllStream("stderr")
    result = _pll_run_result()
    _pll_displays.clear()
    _pll_apply_level(level)
    _pll_protect_import_path()
    user_globals = _pll_get_session(session_key)
    user_globals["__pll_level__"] = level
    main = _pll_session_module(session_key)
    filename = "<repl>"
    del _pll_compile_warnings[:]
    try:
        tree = _pll_parse_and_instrument(code, filename)
    except SyntaxError as e:
        result.update(_pll_error_info(e, (filename, code)))
        return result

    last_expr = None
    if tree.body and isinstance(tree.body[-1], _ast.Expr):
        last_expr = tree.body[-1]
        tree.body = tree.body[:-1]

    try:
        with _pll_as_main(main), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
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
    except SystemExit as e:
        result["ok"] = True
        result["exit_code"] = _pll_exit_status(e, stderr)
    except BaseException as e:
        result.update(_pll_error_info(e, (filename, code)))
    finally:
        _pll_say_compile_warnings(stderr, result["error_message"], code)
        _pll_with_output(result, stdout, stderr)
    return result
