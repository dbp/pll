# Bonnie Python runtime bootstrap.
#
# This module is loaded into Pyodide once when the runtime initializes.
# It exposes four entry points used by the TypeScript host:
#
#   _bonnie_run_file(code, filename)       -> dict
#   _bonnie_repl_eval(code)                -> dict
#   _bonnie_repl_check(source)             -> dict
#   _bonnie_static_analyze(code, level, filename) -> list[dict]
#
# Each returns a JSON-friendly dict / list of dicts so the JS side can
# consume the result via `proxy.toJs({ dict_converter: Object.fromEntries })`.

import io
import sys
import traceback as _tb_mod
import ast as _ast
import codeop as _codeop
import contextlib

_bonnie_user_globals = {"__name__": "__main__", "__builtins__": __builtins__}


# -----------------------------------------------------------------------------
# REPL syntax check (codeop.compile_command in 'single' mode)
# -----------------------------------------------------------------------------

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


# -----------------------------------------------------------------------------
# Run a whole file (with output capture and traceback extraction)
# -----------------------------------------------------------------------------

def _bonnie_extract_loc(tb_str, fallback_filename):
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


# -----------------------------------------------------------------------------
# REPL-style eval (statements + last-expression value)
# -----------------------------------------------------------------------------

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


# =============================================================================
# Static analysis (beginner-level checks)
# =============================================================================
#
# Beginner-level rules:
#   1. Shadowing:     a binding whose name appears in any enclosing scope or
#                     is the name of a Python built-in.
#   2. Reassignment:  a name bound more than once within the same scope.
#                     Suppressed for names already flagged as shadowing in
#                     that scope (fix the shadow first; reassignment becomes
#                     trivial once each binding has its own name).
#
# A "scope" is one of: module, function (incl. async), lambda, class,
# comprehension/generator. We model these explicitly because Python 3
# comprehensions have their own scope.


_BONNIE_SCOPE_FUNC = (_ast.FunctionDef, _ast.AsyncFunctionDef)
_BONNIE_SCOPE_COMP = (_ast.ListComp, _ast.SetComp, _ast.DictComp, _ast.GeneratorExp)


class _BonnieScope:
    __slots__ = ("node", "kind", "parent", "bindings")

    def __init__(self, node, kind, parent):
        self.node = node
        self.kind = kind        # "module" | "function" | "lambda" | "class" | "comprehension"
        self.parent = parent    # _BonnieScope | None
        self.bindings = {}      # name -> [(lineno, col, kind), ...]


def _bonnie_arg_names(args):
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


class _BonnieScopeBuilder:
    """Walk a module AST and build a list of scopes with their bindings.

    A binding is collected in the *enclosing* scope of the syntactic node
    (e.g. a `def f` adds `f` to the surrounding scope and creates a new
    function scope for its body). Comprehensions, lambdas, and classes
    each open their own scope.
    """

    def __init__(self):
        self.scopes = []

    def build(self, tree):
        module = _BonnieScope(tree, "module", None)
        self.scopes.append(module)
        for stmt in tree.body:
            self._walk(stmt, module)
        return module

    def _add(self, scope, name, lineno, col, kind):
        scope.bindings.setdefault(name, []).append((lineno, col, kind))

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
                self._add(scope, name, node.lineno, node.col_offset, "import")
            return
        if isinstance(node, _ast.ImportFrom):
            for alias in node.names:
                name = alias.asname or alias.name
                self._add(scope, name, node.lineno, node.col_offset, "importfrom")
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
        if isinstance(node, _BONNIE_SCOPE_FUNC):
            # Function name binds in the OUTER scope.
            self._add(scope, node.name, node.lineno, node.col_offset, "functiondef")
            for d in node.decorator_list:
                self._walk(d, scope)
            for d in node.args.defaults:
                self._walk(d, scope)
            for d in (node.args.kw_defaults or []):
                if d is not None:
                    self._walk(d, scope)
            inner = _BonnieScope(node, "function", scope)
            self.scopes.append(inner)
            for name, lineno, col in _bonnie_arg_names(node.args):
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
            inner = _BonnieScope(node, "lambda", scope)
            self.scopes.append(inner)
            for name, lineno, col in _bonnie_arg_names(node.args):
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
            inner = _BonnieScope(node, "class", scope)
            self.scopes.append(inner)
            for s in node.body:
                self._walk(s, inner)
            return
        if isinstance(node, _BONNIE_SCOPE_COMP):
            inner = _BonnieScope(node, "comprehension", scope)
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


def _bonnie_static_analyze(code, level, filename):
    """Run static checks for `level` over `code` and return findings.

    Returns a list of dicts. Each dict has at minimum:
      id, error_type, message, line_number, column, name_token, scope_kind.
    """
    if level != "beginner":
        return []
    try:
        tree = _ast.parse(code, filename=filename)
    except SyntaxError:
        # Let the runtime path surface SyntaxErrors with their normal flow.
        return []

    findings = []
    builder = _BonnieScopeBuilder()
    builder.build(tree)
    builtins_set = {n for n in dir(__builtins__) if not n.startswith("_")}

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
            first_loc = locs[0]
            if name in enclosing:
                shadowed_in_scope.add(name)
                outer = enclosing[name]
                findings.append({
                    "id": "shadowing",
                    "error_type": "Shadowing",
                    "message": "`%s` is already defined in an outer scope" % name,
                    "line_number": first_loc[0],
                    "column": first_loc[1],
                    "name_token": name,
                    "scope_kind": scope.kind,
                    "outer_line_number": outer[0],
                    "outer_column": outer[1],
                    "outer_scope_kind": outer[2],
                })
            elif name in builtins_set:
                shadowed_in_scope.add(name)
                findings.append({
                    "id": "shadowing-builtin",
                    "error_type": "Shadowing",
                    "message": "`%s` is the name of a Python built-in" % name,
                    "line_number": first_loc[0],
                    "column": first_loc[1],
                    "name_token": name,
                    "scope_kind": scope.kind,
                })

        # ---- Then reassignment (skip names already shadow-flagged) ----
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

    findings.sort(key=lambda f: (f["line_number"] or 0, f["column"] or 0))
    return findings
