/**
 * Python source executed inside Pyodide once on init. It defines two helpers:
 *
 *   _bonnie_run_file(code: str, filename: str) -> dict
 *   _bonnie_repl_eval(code: str) -> dict
 *
 * Each returns a dict with keys:
 *   ok: bool
 *   stdout: str
 *   stderr: str
 *   result_repr: str | None       # only for repl, value of last expr
 *   error_type: str | None
 *   error_message: str | None
 *   traceback: str | None         # full formatted traceback
 *   line_number: int | None
 *   column: int | None
 *
 * We use io.StringIO to capture stdout/stderr. We compile() the source with
 * the user-provided filename so tracebacks point at the right file.
 */
export const PYODIDE_BOOTSTRAP_PY = `
import io
import sys
import traceback as _tb_mod
import ast as _ast
import codeop as _codeop
import contextlib

_bonnie_user_globals = {"__name__": "__main__", "__builtins__": __builtins__}

def _bonnie_repl_check(source):
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


def _bonnie_extract_loc(tb_str, fallback_filename):
    line_no = None
    col = None
    for raw in reversed(tb_str.splitlines()):
        line = raw.strip()
        if line.startswith('File "') and ', line ' in line:
            try:
                rest = line.split(', line ', 1)[1]
                num_part = rest.split(',', 1)[0].strip()
                line_no = int(num_part)
            except Exception:
                line_no = None
            break
    if line_no is None and fallback_filename:
        for raw in tb_str.splitlines():
            if fallback_filename in raw and ', line ' in raw:
                try:
                    rest = raw.split(', line ', 1)[1]
                    num_part = rest.split(',', 1)[0].strip()
                    line_no = int(num_part)
                except Exception:
                    pass
                break
    return line_no, col

def _bonnie_run_file(code, filename):
    stdout = io.StringIO()
    stderr = io.StringIO()
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
    }
    try:
        compiled = compile(code, filename, "exec")
    except SyntaxError as e:
        tb_text = "".join(_tb_mod.format_exception(type(e), e, e.__traceback__))
        result["error_type"] = type(e).__name__
        result["error_message"] = str(e)
        result["traceback"] = tb_text
        result["line_number"] = e.lineno
        result["column"] = (e.offset - 1) if e.offset else None
        result["stdout"] = stdout.getvalue()
        result["stderr"] = stderr.getvalue()
        return result

    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            exec(compiled, _bonnie_user_globals)
        result["ok"] = True
    except SystemExit:
        result["ok"] = True
    except BaseException as e:
        tb = e.__traceback__
        while tb is not None and tb.tb_next is not None and tb.tb_frame.f_code.co_filename != filename:
            tb = tb.tb_next
        formatted = "".join(_tb_mod.format_exception(type(e), e, e.__traceback__))
        result["error_type"] = type(e).__name__
        result["error_message"] = str(e)
        result["traceback"] = formatted
        line_no, col = _bonnie_extract_loc(formatted, filename)
        result["line_number"] = line_no
        result["column"] = col
    finally:
        result["stdout"] = stdout.getvalue()
        result["stderr"] = stderr.getvalue()
    return result

def _bonnie_repl_eval(code):
    stdout = io.StringIO()
    stderr = io.StringIO()
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
    }
    filename = "<repl>"
    try:
        tree = _ast.parse(code, filename=filename, mode="exec")
    except SyntaxError as e:
        formatted = "".join(_tb_mod.format_exception(type(e), e, e.__traceback__))
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
                exec(compiled_stmts, _bonnie_user_globals)
            if last_expr is not None:
                expr_module = _ast.Expression(body=last_expr.value)
                compiled_expr = compile(expr_module, filename, "eval")
                value = eval(compiled_expr, _bonnie_user_globals)
                if value is not None:
                    result["result_repr"] = repr(value)
        result["ok"] = True
    except SystemExit:
        result["ok"] = True
    except BaseException as e:
        formatted = "".join(_tb_mod.format_exception(type(e), e, e.__traceback__))
        result["error_type"] = type(e).__name__
        result["error_message"] = str(e)
        result["traceback"] = formatted
        line_no, col = _bonnie_extract_loc(formatted, filename)
        result["line_number"] = line_no
        result["column"] = col
    finally:
        result["stdout"] = stdout.getvalue()
        result["stderr"] = stderr.getvalue()
    return result
`;

export interface BonnieRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  result_repr: string | null;
  error_type: string | null;
  error_message: string | null;
  traceback: string | null;
  line_number: number | null;
  column: number | null;
}
