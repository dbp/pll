# Static analysis: the checks each level makes before a program runs.
#
# Per-level rules:
#
#   beginner:
#     1. Shadowing:        a binding whose name appears in any enclosing
#                          scope, is the name of a Python built-in, or is
#                          provided by a PLL library (image / table /
#                          reactor - the names every session starts with).
#     2. Reassignment:     a name bound more than once within the *same*
#                          scope - or, for a `def` or `class` written
#                          twice, a duplicate definition. Suppressed for
#                          names already flagged as shadowing in that scope
#                          (fix the shadow first).
#     3. Disallowed kw:    `global` and `nonlocal` statements.
#     4. Silent mistakes:  code that runs without a word but cannot be what
#                          was meant (`_PllSilenceVisitor`).
#
#   intermediate:
#     The same, except that reassignment is only flagged at module scope.
#     Function/lambda/class/comprehension scopes are allowed to rebind,
#     which is what enables for-loop accumulator patterns (e.g. `total = 0;
#     for x in xs: total += x` inside `def`).
#
#   raw, advanced:
#     No checks. Full Python.
#
# A "scope" is one of: module, function (incl. async), lambda, class,
# comprehension/generator. We model these explicitly because Python 3
# comprehensions have their own scope.

import ast as _ast
import sys as _sys
import builtins as _builtins_mod

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
    __slots__ = ("node", "kind", "parent", "bindings", "declared_elsewhere")

    def __init__(self, node, kind, parent):
        self.node = node
        self.kind = kind        # "module" | "function" | "lambda" | "class" | "comprehension"
        self.parent = parent    # _PllScope | None
        # name -> [(lineno, col, kind, module), ...]. `module` is set only
        # for import bindings: the module the name was imported from.
        self.bindings = {}
        # Names this scope declared `global` or `nonlocal`. An assignment to
        # one of them rebinds the *outer* name, so it neither shadows nor
        # reassigns anything here - and the keyword itself is already
        # reported at the levels that disallow it.
        self.declared_elsewhere = set()


def _pll_redefines_on_purpose(node):
    """Whether a `def` is meant to share its name with one above it: a
    property's `@name.setter` (or `getter`, `deleter`), or an `@overload`."""
    for decorator in node.decorator_list:
        if (
            isinstance(decorator, _ast.Attribute)
            and decorator.attr in ("setter", "getter", "deleter")
            and isinstance(decorator.value, _ast.Name)
            and decorator.value.id == node.name
        ):
            return True
        if (isinstance(decorator, _ast.Name) and decorator.id == "overload") or (
            isinstance(decorator, _ast.Attribute) and decorator.attr == "overload"
        ):
            return True
    return False


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
        self._classes = set()

    def build(self, tree):
        self._classes = {node.name for node in _ast.walk(tree) if isinstance(node, _ast.ClassDef)}
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
            # No binding here, but an assignment further down binds the
            # outer name rather than a local one. Recorded so the shadowing
            # and reassignment checks do not report it twice over.
            scope.declared_elsewhere.update(node.names)
            return
        # A `case` pattern's captures, and `except ... as e`, bind a name -
        # one of the alternatives, of which only one runs. Not `case Boa:`
        # for a class `Boa`: that is the class with its brackets left off,
        # which the compiler's own error, or the match it then fits, says.
        if (
            isinstance(node, (_ast.MatchAs, _ast.MatchStar))
            and node.name is not None
            and not (isinstance(node, _ast.MatchAs) and node.pattern is None and node.name in self._classes)
        ):
            self._add(scope, node.name, node.lineno, node.col_offset, "capture")
        if isinstance(node, _ast.MatchMapping) and node.rest is not None:
            self._add(scope, node.rest, node.lineno, node.col_offset, "capture")
        if isinstance(node, _ast.ExceptHandler) and node.name is not None:
            self._add(scope, node.name, node.lineno, node.col_offset, "capture")

        # --- Scope-introducing nodes -------------------------------------
        if isinstance(node, _PLL_SCOPE_FUNC):
            # Function name binds in the OUTER scope.
            kind = "accessor" if _pll_redefines_on_purpose(node) else "functiondef"
            self._add(scope, node.name, node.lineno, node.col_offset, kind)
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


#: The kinds that are said but do not stop the code running: each can be
#: right as written. Every other kind is an error, which does.
_PLL_WARNING_KINDS = frozenset(("method-not-called", "test-not-named"))


def _pll_finding(kind, error_type, line, column, name_token=None, **extras):
    """One static finding, in the shape the host reads (`RawStaticFinding`).

    `extras` are what this kind's explanation needs, and only that: the
    checks that walk scopes add `scope_kind`, because only they know it.
    """
    finding = {
        "id": kind,
        "error_type": error_type,
        "severity": "warning" if kind in _PLL_WARNING_KINDS else "error",
        "line_number": line,
        "column": column,
        "name_token": name_token,
    }
    finding.update(extras)
    return finding


#: Annotations students write that are not types: `table` is the function
#: that makes a table, `Table` the type. Written out rather than derived, so
#: a name is only reported when its replacement is certainly right. The
#: replacements are the host's (`TYPE_FOR` in silenceExplainer.ts), which
#: words the advice.
_PLL_NOT_A_TYPE = frozenset(
    (
        "table",
        "reactor",
        "row",
        "string",
        "integer",
        "boolean",
        "number",
        "Float",
        "Int",
        "Str",
        "Bool",
        "image",
        "Number",
        "String",
        "Boolean",
        "Integer",
    )
)

#: Methods that are nearly always meant to be called. `movies["rating"].mean`
#: prints `<bound method Series.mean of ...>` and says nothing; `.mean()` is
#: what was wanted. Only names that are a method everywhere a student meets
#: them: `columns`, `values` and `shape` are properties in pandas, and
#: `width` and `height` are properties on an image, so they are not here.
_PLL_CALLED_METHODS = frozenset(
    (
        "mean",
        "sum",
        "count",
        "length",
        "rows",
        "head",
        "tail",
        "to_pandas",
        "to_svg",
        "upper",
        "lower",
        "strip",
        "split",
        "keys",
        "items",
        "sort_values",
        "value_counts",
        "describe",
        "median",
        "std",
        "var",
        "nunique",
        "interact",
    )
)


#: Functions whose whole job is to be given a function, where naming a
#: method without calling it is exactly right.
_PLL_TAKES_A_FUNCTION = frozenset(
    ("sorted", "map", "filter", "min", "max", "sort", "reduce", "any", "all")
)

#: Types a student might assign to a field name by mistake: `year = int`
#: rather than `year: int`.
_PLL_TYPE_NAMES = frozenset(("int", "float", "str", "bool", "list", "dict", "tuple"))

#: Built-in types whose methods are passed as functions: `str.upper` is the
#: function every string's `.upper()` calls, and can never be one forgotten.
_PLL_METHOD_TYPES = frozenset(("str", "int", "float", "list", "dict", "set", "tuple", "bytes", "frozenset"))


def _pll_names_type(annotation):
    """Whether an annotation is `type` or `type[...]`."""
    if isinstance(annotation, _ast.Subscript):
        annotation = annotation.value
    return isinstance(annotation, _ast.Name) and annotation.id == "type"


class _PllSilenceVisitor(_ast.NodeVisitor):
    """Collect mistakes that run without a word being said.

    Each of these is valid Python that does nothing, or does something
    other than what was meant, and so produces no error at all:

      - a value computed and thrown away inside a function, which is how a
        test written without `assert` always passes;
      - `assert(x, 1)`, where the tuple is always true;
      - a function containing `assert` that is not named `test_...` and is
        never called, so it never runs;
      - an annotation naming a function rather than a type, which turns
        every check on that value off;
      - a method named but not called, which yields the method object;
      - a dataclass field with no type, or written `year = int`, which
        makes no field and goes wrong somewhere else entirely;
      - a class with fields and no `@dataclass`, whose constructor then
        "takes no arguments";
      - `a == Boa`, which is always False.

    Only inside a function for the first one: at the top level a bare
    expression is displayed, and the course relies on that.
    """

    __slots__ = (
        "found",
        "_code",
        "_defined",
        "_depth",
        "_called",
        "_asserting",
        "_classes",
        "_fields",
        "_type_valued",
    )

    def __init__(self, code, defined):
        self.found = []
        # The student's text, so advice can quote `return order_amt + 4`
        # rather than say "`return` it".
        self._code = code
        # Every name the file (or the session) binds at the top level: an
        # alias like `Number = int | float` is a type an annotation can name.
        self._defined = defined
        self._depth = 0
        # For each function being visited, its parameters annotated `type`,
        # whose values are classes and can be compared with one.
        self._type_valued = []
        # Classes defined in this file, so `== Boa` can be told from `== b`.
        self._classes = set()
        # Their field names. A field called `count` or `items` happens to
        # share its name with a method, and `s.count` is then exactly
        # right - so those are not "a method you forgot to call".
        self._fields = set()
        # Names used anywhere other than as the function's own definition,
        # so a helper that is never called can be told from one that is.
        self._called = set()
        # A finding for each function that contains an `assert` and is not
        # a test - reported only if nothing calls it, which is known at the end.
        self._asserting = []

    # ---- functions ----

    def scan(self, tree):
        """The findings for `tree`, with the classes and their fields collected first.

        `a == Boa` is only recognisable as a comparison against a class if
        `Boa` is already known, and a function written above the class it
        uses is perfectly ordinary. The field names are wanted for the same
        reason, by the checks that would otherwise mistake one for a method.
        """
        for node in _ast.walk(tree):
            if not isinstance(node, _ast.ClassDef):
                continue
            self._classes.add(node.name)
            for stmt in node.body:
                if isinstance(stmt, _ast.AnnAssign) and isinstance(stmt.target, _ast.Name):
                    self._fields.add(stmt.target.id)
        self.visit(tree)
        self.found.extend(f for f in self._asserting if f["name_token"] not in self._called)
        return self.found

    def _function(self, node):
        self._depth += 1
        self._type_valued.append({
            arg.arg
            for arg in node.args.posonlyargs + node.args.args + node.args.kwonlyargs
            if _pll_names_type(arg.annotation)
        })
        self.generic_visit(node)
        self._type_valued.pop()
        self._depth -= 1
        if self._contains_assert(node) and not node.name.startswith("test_"):
            self._asserting.append(
                _pll_finding("test-not-named", "NeverRun", node.lineno, node.col_offset, node.name)
            )
        self._not_a_type(node.returns)

    visit_FunctionDef = _function
    visit_AsyncFunctionDef = _function

    @staticmethod
    def _contains_assert(node):
        for child in _ast.walk(node):
            if isinstance(child, _ast.Assert):
                return True
        return False

    def visit_Name(self, node):
        if isinstance(node.ctx, _ast.Load):
            self._called.add(node.id)
        self.generic_visit(node)

    def visit_Attribute(self, node):
        # A method is called through its object: `a.check()`.
        if isinstance(node.ctx, _ast.Load):
            self._called.add(node.attr)
        self.generic_visit(node)

    # ---- classes and their fields ----

    def visit_ClassDef(self, node):
        self._classes.add(node.name)
        decorated = any(
            (isinstance(d, _ast.Name) and d.id == "dataclass")
            or (isinstance(d, _ast.Attribute) and d.attr == "dataclass")
            or (
                isinstance(d, _ast.Call)
                and (
                    (isinstance(d.func, _ast.Name) and d.func.id == "dataclass")
                    or (isinstance(d.func, _ast.Attribute) and d.func.attr == "dataclass")
                )
            )
            for d in node.decorator_list
        )
        annotated = [
            stmt
            for stmt in node.body
            if isinstance(stmt, _ast.AnnAssign) and isinstance(stmt.target, _ast.Name)
        ]
        for stmt in node.body:
            # `year` on a line of its own: meant as a field, but it is a
            # use of a name, so it fails as a NameError somewhere else.
            if isinstance(stmt, _ast.Expr) and isinstance(stmt.value, _ast.Name):
                self.found.append(
                    _pll_finding(
                        "field-no-type", "FieldNeedsType", stmt.lineno, stmt.col_offset, stmt.value.id
                    )
                )
            # `year = int`: a class attribute holding a type, which makes
            # no field at all and goes wrong much later, in the argument
            # count of a constructor nobody wrote.
            if (
                isinstance(stmt, _ast.Assign)
                and len(stmt.targets) == 1
                and isinstance(stmt.targets[0], _ast.Name)
                and isinstance(stmt.value, _ast.Name)
                and stmt.value.id in _PLL_TYPE_NAMES
            ):
                self.found.append(
                    _pll_finding(
                        "field-assigned-type",
                        "FieldNeedsType",
                        stmt.lineno,
                        stmt.col_offset,
                        stmt.targets[0].id,
                        # The type they wrote, so the fix quotes it back exactly.
                        written_type=stmt.value.id,
                    )
                )
        # Annotated fields and no `@dataclass`: `X(...)` then fails with
        # "takes no arguments", which says nothing about the decorator. Only
        # for a class with no base: a `NamedTuple` declares its fields this
        # way, and a subclass is made by its base's constructor.
        writes_init = any(
            isinstance(stmt, _PLL_SCOPE_FUNC) and stmt.name == "__init__"
            for stmt in node.body
        )
        has_base = any(not (isinstance(b, _ast.Name) and b.id == "object") for b in node.bases)
        if annotated and not decorated and not writes_init and not has_base:
            self.found.append(
                _pll_finding("class-needs-dataclass", "NotADataclass", node.lineno, node.col_offset, node.name)
            )
        self.generic_visit(node)

    def _class_valued(self, side):
        """Whether `side` is a class itself, which a class can equal:
        `type(a)`, `a.__class__`, another class, or a parameter annotated
        `type`."""
        if isinstance(side, _ast.Call) and isinstance(side.func, _ast.Name) and side.func.id == "type":
            return True
        if isinstance(side, _ast.Attribute) and side.attr == "__class__":
            return True
        return isinstance(side, _ast.Name) and (
            side.id in self._classes or any(side.id in names for names in self._type_valued)
        )

    def visit_Compare(self, node):
        # `if a == Boa:` is always False - a value is never equal to the
        # class it was made from. `type(a) == Boa`, though, is a real check.
        sides = [node.left] + list(node.comparators)
        if any(isinstance(op, (_ast.Eq, _ast.NotEq)) for op in node.ops):
            for i, side in enumerate(sides):
                others = sides[:i] + sides[i + 1 :]
                if (
                    isinstance(side, _ast.Name)
                    and side.id in self._classes
                    and not any(self._class_valued(other) for other in others)
                ):
                    self.found.append(
                        _pll_finding("compared-with-class", "AlwaysFalse", side.lineno, side.col_offset, side.id)
                    )
        self.generic_visit(node)

    # ---- statements whose value goes nowhere ----

    def visit_Expr(self, node):
        value = node.value
        # A method named but not called is the more specific thing to say
        # about `t.mean` on a line of its own, so it wins.
        if not self._method_not_called(value) and self._depth > 0 and self._discarded(value):
            self.found.append(
                _pll_finding(
                    "unused-comparison" if isinstance(value, _ast.Compare) else "unused-value",
                    "UnusedValue",
                    node.lineno,
                    node.col_offset,
                    expression=_ast.get_source_segment(self._code, value),
                )
            )
        self.generic_visit(node)

    @staticmethod
    def _discarded(value):
        """Whether this expression statement can only be a mistake.

        A call, an await or a yield is there for its effect. A string is a
        docstring. `...` is a placeholder. Everything else computes
        something and drops it.
        """
        if isinstance(
            value,
            (
                _ast.Call,
                _ast.Await,
                _ast.Yield,
                _ast.YieldFrom,
                _ast.NamedExpr,
            ),
        ):
            return False
        if isinstance(value, _ast.Constant):
            return False
        return True

    def _method_not_called(self, value):
        """`movies["rating"].mean` - the method itself, not its result."""
        if (
            isinstance(value, _ast.Attribute)
            and value.attr in _PLL_CALLED_METHODS
            and value.attr not in self._fields
            # `str.upper`: read off a type, so the function, on purpose.
            and not (
                isinstance(value.value, _ast.Name)
                and (value.value.id in _PLL_METHOD_TYPES or value.value.id in self._classes)
            )
        ):
            self.found.append(
                _pll_finding("method-not-called", "NotCalled", value.lineno, value.col_offset, value.attr)
            )
            return True
        return False

    def visit_Call(self, node):
        # A method named but not called, wherever its value is used:
        # `print(movies["rating"].mean)`.
        #
        # Not for a function that takes a function - `sorted(xs,
        # key=str.lower)` passes `str.lower` deliberately, and that is the
        # one shape where naming a method without calling it is right.
        callee = node.func
        name = callee.id if isinstance(callee, _ast.Name) else None
        if name in _PLL_TAKES_A_FUNCTION:
            self.generic_visit(node)
            return
        for keyword in node.keywords:
            if keyword.arg not in ("key", "default_factory"):
                self._method_not_called(keyword.value)
        for argument in node.args:
            self._method_not_called(argument)
        self.generic_visit(node)

    # ---- asserts ----

    def visit_Assert(self, node):
        if isinstance(node.test, _ast.Tuple) and node.test.elts:
            self.found.append(_pll_finding("assert-tuple", "AlwaysTrue", node.lineno, node.col_offset))
        self.generic_visit(node)

    # ---- annotations ----

    def _not_a_type(self, annotation):
        if (
            isinstance(annotation, _ast.Name)
            and annotation.id in _PLL_NOT_A_TYPE
            # A class or alias of their own called `Number` is a type, and
            # naming it in an annotation is right.
            and annotation.id not in self._classes
            and annotation.id not in self._defined
        ):
            self.found.append(
                _pll_finding(
                    "annotation-not-a-type", "NotAType", annotation.lineno, annotation.col_offset, annotation.id
                )
            )

    def _annotation(self, node):
        self._not_a_type(getattr(node, "annotation", None))
        self.generic_visit(node)

    visit_AnnAssign = _annotation
    visit_arg = _annotation


def _pll_session_bound_names(session_key):
    """User-defined names already bound in a session (for REPL checks).

    Baseline names from `_pll_initial_globals` (image primitives, etc.) are
    skipped unless the user rebound them, so prompt analysis matches file
    analysis for the same snippet.
    """
    module = _pll_sessions.get(session_key)
    if module is None:
        return []
    g = module.__dict__
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

    Returns a list of dicts made by `_pll_finding`: `id`, `error_type`, a
    position and `name_token`, and whatever that kind's explanation needs.

    If `session_key` is set, names already bound in that session are treated
    as existing module-level bindings. That way a `#level beginner` prompt cannot
    reassign a name the file (or an earlier prompt line) already defined.
    """
    if level not in _PLL_TEACHING_LEVELS:
        return []
    try:
        with _pll_without_syntax_warnings():
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
    # total += x`) work. Mirrored by `levelRefusesReassignment` in level.ts,
    # which the explanations use to offer only fixes the level accepts.
    def reassignment_active(scope_kind):
        if level == _PLL_LEVEL_BEGINNER:
            return True
        if level == _PLL_LEVEL_INTERMEDIATE:
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
            if name in scope.declared_elsewhere:
                # `global x` has its own finding; one for the same name here
                # would read as a second, separate mistake.
                continue
            if scope.kind == "class":
                # A name bound in a class body is an *attribute*, not a
                # variable. `id: int` in a dataclass declares a field, and
                # `id` everywhere else still finds the built-in, so nothing
                # is shadowed. The class's own name is bound in the
                # enclosing scope and checked there, so `class list:` is
                # still caught.
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
                findings.append(_pll_finding(
                    "shadowing", "Shadowing", report_loc[0], report_loc[1], name,
                    scope_kind=scope.kind,
                    outer_line_number=outer[0],
                    outer_column=outer[1],
                    outer_scope_kind=outer[2],
                ))
            elif name in builtins_set and defining_loc is not None:
                shadowed_in_scope.add(name)
                findings.append(_pll_finding(
                    "shadowing-builtin", "Shadowing", defining_loc[0], defining_loc[1], name,
                    scope_kind=scope.kind,
                ))
            elif name in library_names and defining_loc is not None:
                shadowed_in_scope.add(name)
                findings.append(_pll_finding(
                    "shadowing-library", "Shadowing", defining_loc[0], defining_loc[1], name,
                    scope_kind=scope.kind,
                    library=library_names[name],
                ))

        # ---- Then reassignment (skip names already shadow-flagged) ----
        if reassignment_active(scope.kind):
            for name, locs in scope.bindings.items():
                if name in shadowed_in_scope or name in scope.declared_elsewhere:
                    continue
                # A property's setter is the property, not a second one.
                locs = [loc for loc in locs if loc[2] != "accessor"]
                # The same capture in two `case`s (or two `except`s) is bound
                # by whichever one runs, never twice.
                if all(loc[2] == "capture" for loc in locs):
                    continue
                if len(locs) > 1:
                    second_loc = locs[1]
                    first_loc = locs[0]
                    # A `def` written twice is not an accumulator: the
                    # advice for a reassigned variable (running totals, use
                    # `sum`) is about something else entirely, and the fix
                    # is to rename one of them.
                    definitions = {"functiondef": "function", "classdef": "class"}
                    both = definitions.get(first_loc[2]) if first_loc[2] == second_loc[2] else None
                    if both is not None:
                        findings.append(_pll_finding(
                            "duplicate-definition", "DuplicateDefinition", second_loc[0], second_loc[1], name,
                            scope_kind=scope.kind,
                            first_line_number=first_loc[0],
                            first_column=first_loc[1],
                            definition_kind=both,
                        ))
                        continue
                    findings.append(_pll_finding(
                        "reassignment", "Reassignment", second_loc[0], second_loc[1], name,
                        scope_kind=scope.kind,
                        first_line_number=first_loc[0],
                        first_column=first_loc[1],
                    ))

    # ---- `global` / `nonlocal` ----
    # Both are disallowed at beginner and intermediate. One finding per
    # statement, not per name, so `global x, y` is one diagnostic on its line.
    for node in _ast.walk(tree):
        if isinstance(node, (_ast.Global, _ast.Nonlocal)):
            findings.append(_pll_finding(
                "disallowed-keyword", "DisallowedKeyword", node.lineno, node.col_offset, node.names[0],
                keyword="global" if isinstance(node, _ast.Global) else "nonlocal",
                names=list(node.names),
            ))

    # ---- mistakes that would otherwise run without a word ----
    findings.extend(_PllSilenceVisitor(code, set(builder.scopes[0].bindings)).scan(tree))

    findings.sort(key=lambda f: (f["line_number"] or 0, f["column"] or 0))
    return findings
