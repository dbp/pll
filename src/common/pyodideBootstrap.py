# Bonnie Python runtime bootstrap.
#
# This module is loaded into Pyodide once when the runtime initializes.
# It exposes four entry points used by the TypeScript host:
#
#   _bonnie_run_file(code, filename, session_key)   -> dict
#   _bonnie_repl_eval(code, session_key)            -> dict
#   _bonnie_repl_check(source)                      -> dict
#   _bonnie_static_analyze(code, level, filename)   -> list[dict]
#
# Each returns a JSON-friendly dict / list of dicts so the JS side can
# consume the result via `proxy.toJs({ dict_converter: Object.fromEntries })`.
#
# Sessions
# --------
# Each Python file gets its own session, keyed by an opaque string the host
# chooses (typically the document URI). Sessions hold their own globals
# dict, so file A's `data = ...` doesn't leak into file B's REPL prompt.
# `_bonnie_run_file` resets the addressed session's globals to the baseline
# template before executing; `_bonnie_repl_eval` does NOT reset, so REPL
# input keeps the names defined by the most recent Run File of the same
# session.

import io
import sys
import traceback as _tb_mod
import ast as _ast
import codeop as _codeop
import contextlib

# Per-session globals dicts, keyed by session_key (e.g. document URI).
# Created lazily; initialized from `_bonnie_initial_globals`.
_bonnie_sessions = {}

# The "template" globals used to seed each new session and to reset a
# session at the start of every Run File. Populated by PYODIDE_INSTALL_PY
# at the end of bootstrap so the template includes the Bonnie image
# library + the auto-display helper.
_bonnie_initial_globals = {"__name__": "__main__", "__builtins__": __builtins__}

# Image emissions captured during the most recent `_bonnie_run_file` /
# `_bonnie_repl_eval` call. The host drains this list after the call.
# Pyodide is single-threaded, so a single shared list is fine.
_bonnie_image_emissions = []


def _bonnie_show_top_level(value):
    """Emit a value produced by a top-level expression statement.

    Mirrors the behavior of Python's interactive shell: `None` is suppressed,
    Bonnie images are captured for the host to render, anything else is
    printed via `repr` so bare expressions like `1 + 2` still display.
    """
    if value is None:
        return
    if hasattr(value, "_bonnie_image_data"):
        try:
            data = value._bonnie_image_data()
        except Exception:
            print(repr(value))
            return
        _bonnie_image_emissions.append(data)
        return
    print(repr(value))


# Seed the template with the auto-display helper. The image library names
# get added later by PYODIDE_INSTALL_PY.
_bonnie_initial_globals["_bonnie_show_top_level"] = _bonnie_show_top_level


def _bonnie_get_session(session_key):
    """Get-or-create the globals dict for `session_key`.

    Newly-created sessions start as a copy of `_bonnie_initial_globals`
    (so all baseline names like the image primitives are present).
    """
    g = _bonnie_sessions.get(session_key)
    if g is None:
        g = dict(_bonnie_initial_globals)
        _bonnie_sessions[session_key] = g
    return g


def _bonnie_reset_session(session_key):
    """Reset the globals for `session_key` to the baseline template.

    Mutates the existing dict in place (`clear` + `update`) so any cached
    reference to it (e.g. from `_bonnie_show_top_level`'s closure or from
    Pyodide's `globals.get(...)`) remains valid.
    """
    g = _bonnie_get_session(session_key)
    g.clear()
    g.update(_bonnie_initial_globals)
    return g


class _BonnieTopLevelExprWrapper(_ast.NodeTransformer):
    """Wrap module-level expression statements so they auto-display.

    Skips the conventional module docstring (a string literal as the first
    statement) and bare `None` / `...` constants which are usually noise.
    """

    def visit_Module(self, node):
        new_body = []
        for i, stmt in enumerate(node.body):
            if isinstance(stmt, _ast.Expr) and not _bonnie_should_skip_expr(stmt, i):
                call = _ast.Call(
                    func=_ast.Name(id="_bonnie_show_top_level", ctx=_ast.Load()),
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


def _bonnie_should_skip_expr(stmt, index):
    value = stmt.value
    if isinstance(value, _ast.Constant):
        if index == 0 and isinstance(value.value, str):
            return True  # module docstring
        if value.value is None or value.value is Ellipsis:
            return True
    return False


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


def _bonnie_run_file(code, filename, session_key):
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
        "images": [],
    }
    # Each Run File starts with a clean slate for this session: discard any
    # names defined by a previous Run File of the same session or by REPL
    # exploration since then.
    user_globals = _bonnie_reset_session(session_key)
    _bonnie_image_emissions.clear()
    try:
        tree = _ast.parse(code, filename=filename, mode="exec")
        _BonnieTopLevelExprWrapper().visit(tree)
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
        result["images"] = list(_bonnie_image_emissions)
        return result

    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            exec(compiled, user_globals)
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
        result["images"] = list(_bonnie_image_emissions)
    return result


# -----------------------------------------------------------------------------
# REPL-style eval (statements + last-expression value)
# -----------------------------------------------------------------------------

def _bonnie_repl_eval(code, session_key):
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
        "images": [],
    }
    _bonnie_image_emissions.clear()
    user_globals = _bonnie_get_session(session_key)
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
                exec(compiled_stmts, user_globals)
            if last_expr is not None:
                expr_module = _ast.Expression(body=last_expr.value)
                compiled_expr = compile(expr_module, filename, "eval")
                value = eval(compiled_expr, user_globals)
                if value is None:
                    pass
                elif hasattr(value, "_bonnie_image_data"):
                    try:
                        _bonnie_image_emissions.append(value._bonnie_image_data())
                    except Exception:
                        result["result_repr"] = repr(value)
                else:
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
        result["images"] = list(_bonnie_image_emissions)
    return result


# =============================================================================
# Static analysis (beginner / intermediate level checks)
# =============================================================================
#
# Per-level rules:
#
#   beginner:
#     1. Shadowing:        a binding whose name appears in any enclosing
#                          scope or is the name of a Python built-in.
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


class _BonnieKeywordVisitor(_ast.NodeVisitor):
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


def _bonnie_static_analyze(code, level, filename):
    """Run static checks for `level` over `code` and return findings.

    Returns a list of dicts. Each dict has at minimum:
      id, error_type, message, line_number, column, name_token, scope_kind.
    """
    if level not in ("beginner", "intermediate"):
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
    kw_visitor = _BonnieKeywordVisitor()
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
