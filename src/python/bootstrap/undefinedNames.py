# Names a program reads where they have no value: the NameErrors (and
# UnboundLocalErrors) a run would raise, found before it runs.
#
# Each name is resolved the way Python resolves it - a function's own names,
# then the functions around it, then the file's, then the built-ins - and
# each scope's code is followed in the order it runs, keeping at each point
# the names that may have a value there. A read is reported only when its
# name certainly has none: it is given a value nowhere it could come from,
# or only further down, or it has been removed - by `del`, or at the end of
# the `except` that named it - on every way there.
#
# Code that runs later than it is written - a function's body, a lambda's,
# the rest of a generator after its first `in` - reads the file's names
# whenever it is called, so there only a name given a value nowhere is
# reported. What cannot be known is left alone: a scope with `from m import
# *`, a file that calls `exec`, `globals()`, `locals()` or `vars()` or uses
# `enum.global_enum`, a read inside a `try` whose handler would catch the
# NameError, and in a file with an `#examplar` line, the functions its tests
# call, which the bundle it names provides.

import ast as _ast
import builtins as _builtins_mod
import re as _pll_src_re
import sys as _sys

#: Python's built-ins, which no file has to define.
_PLL_BUILTIN_NAMES = frozenset(dir(_builtins_mod))

#: What gives a file names that no statement in it binds: these calls, and
#: `enum.global_enum`, which makes an enum's members names of the file.
_PLL_DYNAMIC_NAMES = frozenset(("exec", "globals", "locals", "vars", "global_enum"))

#: A file's `#examplar` line, as the host reads it (examplarSource.ts).
_PLL_EXAMPLAR_LINE = _pll_src_re.compile(r"#\s*examplar\s+\S+\s*$")

#: The exceptions whose handlers a NameError reaches.
_PLL_CATCHES_NAME_ERROR = frozenset(("NameError", "UnboundLocalError", "Exception", "BaseException"))

_PLL_NAME_FUNCTIONS = (_ast.FunctionDef, _ast.AsyncFunctionDef)
_PLL_NAME_COMPREHENSIONS = (_ast.ListComp, _ast.SetComp, _ast.DictComp, _ast.GeneratorExp)


def _pll_checks_names(level):
    """Whether code at `level` is checked for names it reads with no value:
    every level a student writes at, and not `raw`, which is Python as it is."""
    return level != _PLL_LEVEL_RAW


def _pll_undefined_names(tree, code, level, session_key, earlier):
    """The `undefined-name` findings for `tree`, the module `code` parses to.

    `session_key` is the prompt's session, whose names the code starts
    with; a file starts with what every run does. `earlier` are the other
    checks' findings, so that a name one of them already explains - an
    annotation naming no type, a `case` naming no class, a local that
    shadows an outer name - is not reported twice.
    """
    module = _pll_sessions.get(session_key) if session_key else None
    if module is not None:
        initial = set(module.__dict__)
    else:
        initial = set(_pll_initial_globals) | {"__file__", "__pll_level__"}
    return _PllUndefinedNames(tree, code, level, initial, earlier).findings


def _pll_type_param_names(node):
    """The names `def f[T]`, `class Leaf[T]` or `type Pair[T]` introduce."""
    return frozenset(param.name for param in getattr(node, "type_params", ()))


def _pll_all_args(args):
    """Every parameter of an `ast.arguments`, in no particular order."""
    return [
        *args.posonlyargs,
        *args.args,
        *args.kwonlyargs,
        *([args.vararg] if args.vararg else []),
        *([args.kwarg] if args.kwarg else []),
    ]


def _pll_union(*states):
    """The names that may have a value after any of `states`; None is a way
    that never gets there, and None for all of them is unreachable."""
    reached = [state for state in states if state is not None]
    return frozenset().union(*reached) if reached else None


def _pll_always_true(test):
    return isinstance(test, _ast.Constant) and bool(test.value)


def _pll_always_false(test):
    return isinstance(test, _ast.Constant) and not test.value


def _pll_catches_name_error(handler):
    """Whether `except` clause `handler` catches a NameError."""

    def names(node):
        if node is None:
            return True
        if isinstance(node, _ast.Name):
            return node.id in _PLL_CATCHES_NAME_ERROR
        if isinstance(node, _ast.Attribute):
            return node.attr in _PLL_CATCHES_NAME_ERROR
        if isinstance(node, _ast.Tuple):
            return any(names(elt) for elt in node.elts)
        return False

    return names(handler.type)


def _pll_binds_in(statements):
    """The names `statements` may give a value to in their own scope: not
    those of the functions, classes and comprehensions inside them, but the
    names of those functions and classes, and a `:=` in a comprehension."""
    names = set()

    def visit(node):
        if isinstance(node, (*_PLL_NAME_FUNCTIONS, _ast.ClassDef)):
            names.add(node.name)
            return
        if isinstance(node, _ast.Lambda):
            return
        if isinstance(node, _PLL_NAME_COMPREHENSIONS):
            for inner in _ast.walk(node):
                if isinstance(inner, _ast.NamedExpr) and isinstance(inner.target, _ast.Name):
                    names.add(inner.target.id)
            return
        if isinstance(node, _ast.Name) and isinstance(node.ctx, _ast.Store):
            names.add(node.id)
        elif isinstance(node, (_ast.Import, _ast.ImportFrom)):
            names.update(alias.asname or alias.name.split(".")[0] for alias in node.names if alias.name != "*")
        elif isinstance(node, _ast.ExceptHandler) and node.name:
            names.add(node.name)
        elif isinstance(node, (_ast.MatchAs, _ast.MatchStar)) and node.name:
            names.add(node.name)
        elif isinstance(node, _ast.MatchMapping) and node.rest:
            names.add(node.rest)
        for child in _ast.iter_child_nodes(node):
            visit(child)

    for statement in statements:
        visit(statement)
    return frozenset(names)


class _PllNameScope:
    """One scope's names, as Python's compiler decides them."""

    __slots__ = (
        "kind", "parent", "node", "assigned", "deleted", "globals", "nonlocals", "type_params", "star", "lines", "defs"
    )

    def __init__(self, kind, parent, node):
        self.kind = kind  # "module", "class", "function" (and lambdas), or "generator" (comprehensions)
        self.parent = parent
        self.node = node
        self.assigned = set()
        self.deleted = set()
        self.globals = set()
        self.nonlocals = set()
        self.type_params = frozenset()
        self.star = False
        # name -> the lines it is given a value on, in this scope
        self.lines = {}
        # name -> the `def`s that bind it here
        self.defs = {}

    @property
    def local(self):
        """Its own names: bound or deleted in it, and not declared another's.
        Assigning a name anywhere in a function makes it local to all of it."""
        return (self.assigned | self.deleted) - self.globals - self.nonlocals

    def bind(self, name, line):
        self.assigned.add(name)
        self.lines.setdefault(name, []).append(line)

    def function(self, name):
        """The function `name` is, when one `def` here is all that binds it."""
        defs = self.defs.get(name, ())
        if len(defs) == 1 and len(self.lines.get(name, ())) == 1 and name not in self.deleted:
            return defs[0]
        return None

    @property
    def method_of(self):
        """The class this function is a method of, or None."""
        if self.kind == "function" and self.parent is not None and self.parent.kind == "class":
            return self.parent
        return None


class _PllNameScopes:
    """Every scope of a module, and the names each one binds."""

    def __init__(self, tree):
        self.of = {}
        self.module = self._open(tree, "module", None)
        for statement in tree.body:
            self._visit(statement, self.module)

    def _open(self, node, kind, parent):
        scope = _PllNameScope(kind, parent, node)
        self.of[node] = scope
        return scope

    def _visit(self, node, scope):
        if isinstance(node, _PLL_NAME_FUNCTIONS):
            scope.bind(node.name, node.lineno)
            scope.defs.setdefault(node.name, []).append(node)
            args = node.args
            outer = node.decorator_list + list(args.defaults) + [d for d in args.kw_defaults if d is not None]
            outer += [arg.annotation for arg in _pll_all_args(args) if arg.annotation is not None]
            outer += [node.returns] if node.returns is not None else []
            for expression in outer:
                self._visit(expression, scope)
            inner = self._open(node, "function", scope)
            inner.type_params = _pll_type_param_names(node)
            for arg in _pll_all_args(args):
                inner.bind(arg.arg, arg.lineno)
            for statement in node.body:
                self._visit(statement, inner)
            return
        if isinstance(node, _ast.Lambda):
            for default in list(node.args.defaults) + [d for d in node.args.kw_defaults if d is not None]:
                self._visit(default, scope)
            inner = self._open(node, "function", scope)
            for arg in _pll_all_args(node.args):
                inner.bind(arg.arg, node.lineno)
            self._visit(node.body, inner)
            return
        if isinstance(node, _ast.ClassDef):
            scope.bind(node.name, node.lineno)
            for expression in node.decorator_list + node.bases + [k.value for k in node.keywords]:
                self._visit(expression, scope)
            inner = self._open(node, "class", scope)
            inner.type_params = _pll_type_param_names(node)
            for statement in node.body:
                self._visit(statement, inner)
            return
        if isinstance(node, _PLL_NAME_COMPREHENSIONS):
            self._visit(node.generators[0].iter, scope)
            inner = self._open(node, "generator", scope)
            for i, generator in enumerate(node.generators):
                if i:
                    self._visit(generator.iter, inner)
                self._visit(generator.target, inner)
                for condition in generator.ifs:
                    self._visit(condition, inner)
            for part in (node.key, node.value) if isinstance(node, _ast.DictComp) else (node.elt,):
                self._visit(part, inner)
            return
        if isinstance(node, _ast.NamedExpr):
            # `:=` in a comprehension gives the name to the scope around it.
            owner = scope
            while owner.kind == "generator":
                owner = owner.parent
            if isinstance(node.target, _ast.Name):
                owner.bind(node.target.id, node.lineno)
            self._visit(node.value, scope)
            return
        if isinstance(node, _ast.Name):
            if isinstance(node.ctx, _ast.Store):
                scope.bind(node.id, node.lineno)
            elif isinstance(node.ctx, _ast.Del):
                scope.deleted.add(node.id)
            return
        if isinstance(node, _ast.Global):
            scope.globals.update(node.names)
            return
        if isinstance(node, _ast.Nonlocal):
            scope.nonlocals.update(node.names)
            return
        if isinstance(node, (_ast.Import, _ast.ImportFrom)):
            for alias in node.names:
                if alias.name == "*":
                    scope.star = True
                else:
                    scope.bind(alias.asname or alias.name.split(".")[0], node.lineno)
            return
        if isinstance(node, getattr(_ast, "TypeAlias", ())):
            scope.bind(node.name.id, node.lineno)
            # Its value is read when the alias is first used, like a body.
            inner = self._open(node, "function", scope)
            inner.type_params = _pll_type_param_names(node)
            self._visit(node.value, inner)
            return
        if isinstance(node, _ast.ExceptHandler) and node.name:
            scope.bind(node.name, node.lineno)
        if isinstance(node, (_ast.MatchAs, _ast.MatchStar)) and node.name:
            scope.bind(node.name, node.lineno)
        if isinstance(node, _ast.MatchMapping) and node.rest:
            scope.bind(node.rest, node.lineno)
        for child in _ast.iter_child_nodes(node):
            self._visit(child, scope)


def _pll_runs_when_called(function):
    """Whether calling the `def` `function` runs its body there and then:
    not an `async def` or a generator, whose call only makes something to
    run later, and not decorated, as the name may then be another function."""
    if not isinstance(function, _ast.FunctionDef) or function.decorator_list:
        return False

    def yields(node):
        if isinstance(node, (_ast.Yield, _ast.YieldFrom)):
            return True
        if isinstance(node, (*_PLL_NAME_FUNCTIONS, _ast.Lambda, _ast.ClassDef)):
            return False
        return any(yields(child) for child in _ast.iter_child_nodes(node))

    return not any(yields(statement) for statement in function.body)


def _pll_certain_reads(function):
    """The names `function` reads every time it runs - on the way through
    its body up to the first `if`, loop, `try`, `with`, `match` or `return`,
    and not in a branch of `and`, `or` or `... if ... else` - and the names
    of the functions it calls on that way. Whatever comes after may not run."""
    reads, calls = [], []

    def visit(node):
        if isinstance(node, _ast.Name):
            if isinstance(node.ctx, _ast.Load):
                reads.append(node)
            return
        if isinstance(node, (_ast.Lambda, *_PLL_NAME_COMPREHENSIONS)):
            return
        if isinstance(node, _ast.IfExp):
            return visit(node.test)
        if isinstance(node, _ast.BoolOp):
            return visit(node.values[0])
        if isinstance(node, _ast.Call) and isinstance(node.func, _ast.Name):
            calls.append(node.func.id)
        for child in _ast.iter_child_nodes(node):
            visit(child.value if isinstance(child, _ast.keyword) else child)

    for statement in function.body:
        if isinstance(statement, (_ast.Expr, _ast.Assign, _ast.AugAssign, _ast.AnnAssign)):
            if statement.value is not None:
                visit(statement.value)
            continue
        if isinstance(statement, (_ast.Pass, _ast.Global, _ast.Nonlocal, _ast.Import, _ast.ImportFrom)):
            continue
        if isinstance(statement, (*_PLL_NAME_FUNCTIONS, _ast.ClassDef)):
            continue
        if isinstance(statement, _ast.Return) and statement.value is not None:
            visit(statement.value)
        elif isinstance(statement, _ast.Raise) and statement.exc is not None:
            visit(statement.exc)
        elif isinstance(statement, (_ast.If, _ast.While)):
            visit(statement.test)
        elif isinstance(statement, _ast.For):
            visit(statement.iter)
        break
    return reads, calls


class _PllReading:
    """How code at some point reads its names: the scope it runs in, and
    what about where it is changes that.

    `later` is code that runs when it is called rather than where it is
    written. `guarded` is code whose NameError a handler catches. `comp`
    are names bound around the point by a comprehension or a type
    parameter list. `outer` resolves a name a class body does not have, in
    the code the `class` statement runs in; `skip_own` is a comprehension in
    a class body, which never sees the class's names. `annotation` is a
    type: an annotation, or a `type` alias's value.
    """

    __slots__ = ("scope", "later", "guarded", "comp", "outer", "skip_own", "annotation")

    def __init__(
        self, scope, later=False, guarded=False, comp=frozenset(), outer=None, skip_own=False, annotation=False
    ):
        self.scope = scope
        self.later = later
        self.guarded = guarded
        self.comp = comp
        self.outer = outer
        self.skip_own = skip_own
        self.annotation = annotation

    def but(self, **changes):
        fields = {name: getattr(self, name) for name in self.__slots__}
        fields.update(changes)
        return _PllReading(**fields)


class _PllUndefinedNames:
    """Follows a module's code in the order it runs, and reports each read of
    a name that certainly has no value there."""

    def __init__(self, tree, code, level, initial, earlier):
        self.scopes = _PllNameScopes(tree)
        self.module = self.scopes.module
        self.lines = code.splitlines()
        self.teaching = level in _PLL_TEACHING_LEVELS
        self.initial = frozenset(initial)
        self.future_annotations = any(
            isinstance(s, _ast.ImportFrom)
            and s.module == "__future__"
            and any(a.name == "annotations" for a in s.names)
            for s in tree.body
        )
        self.dynamic = any(
            isinstance(n, _ast.Name) and n.id in _PLL_DYNAMIC_NAMES
            or isinstance(n, _ast.Attribute) and n.attr == "global_enum"
            for n in _ast.walk(tree)
        )
        # Tests written first, of functions only the bundle has (run/examplar.ts).
        self.examplar = any(_PLL_EXAMPLAR_LINE.match(line.strip()) for line in self.lines)
        # Names a function gives the module with `global`, or the function
        # around it with `nonlocal`: they may have a value anywhere once that
        # function has run, which can be before any read of them.
        self.given_by_functions = set()
        self.given_by_inner = {}
        for scope in self.scopes.of.values():
            self.given_by_functions |= scope.globals & scope.assigned
            for name in scope.nonlocals & scope.assigned:
                parent = scope.parent
                while parent is not None and parent.kind != "module":
                    if parent.kind == "function" and name in parent.local:
                        self.given_by_inner.setdefault(id(parent), set()).add(name)
                        break
                    parent = parent.parent
        # A name another check already explains, and the locals a shadowing
        # finding is about: reporting them again would read as a second,
        # separate mistake.
        self.explained = {
            f["name_token"] for f in earlier if f["id"] in ("annotation-not-a-type", "unknown-pattern-class")
        }
        self.shadowed = {f["name_token"] for f in earlier if f["id"].startswith("shadowing")}
        self.findings = []
        self.reported = set()
        # While a loop is followed to its fixpoint its reads are not reported:
        # only the last pass knows every name its iterations can give.
        self.quiet = 0
        self.loops = []
        # (scope, name) -> (how, line): the last `del`, or the `except` that
        # named it, which took the name's value away.
        self.removed = {}
        # The classes whose bodies are running, innermost last: their own
        # names have no value until they are finished.
        self.defining = []
        self.body(tree.body, self.initial, _PllReading(self.module))

    # -- reads -----------------------------------------------------------------

    def always(self, name):
        """Whether `name` has a value wherever a file's own names run out."""
        return name in _PLL_BUILTIN_NAMES or name in self.initial or (name.startswith("__") and name.endswith("__"))

    def read(self, name, node, state, ctx):
        """`name`, read at `node`, where `state` holds the names that may
        have a value in the scope whose code this is."""
        if name in ctx.comp:
            return
        if ctx.skip_own:
            return ctx.outer(name, node)
        scope = ctx.scope
        if scope.kind == "class":
            if name in state:
                return
            return ctx.outer(name, node)
        if scope.kind == "module":
            if ctx.later:
                return self.read_module_later(name, node, ctx)
            if name in state or self.always(name) or self.dynamic or scope.star or name in self.given_by_functions:
                return
            return self.report(name, node, ctx, local=False)
        # A function's code, a lambda's, or a generator's.
        if name in scope.type_params or name in scope.nonlocals:
            return
        if name in scope.globals:
            return self.read_module_later(name, node, ctx)
        if name in scope.local:
            given = self.given_by_inner.get(id(scope), ())
            if name not in state and name not in given and not scope.star and not self.dynamic:
                self.report(name, node, ctx, local=True)
            return
        parent = scope.parent
        while parent is not None and parent.kind != "module":
            if name in parent.type_params:
                return
            # A class's names are not visible inside its methods.
            if parent.kind != "class":
                if name in parent.globals:
                    break
                if name in parent.local or name in parent.nonlocals:
                    # The enclosing function's own: whether it has a value
                    # by the time this runs is that function's business.
                    return
            parent = parent.parent
        return self.read_module_later(name, node, ctx)

    def read_module_later(self, name, node, ctx):
        """A file's name, read by code that runs at some later time: it has to
        be given a value somewhere."""
        if self.always(name) or self.dynamic or self.module.star or self.examplar:
            return
        if name in self.module.assigned or name in self.given_by_functions:
            return
        self.report(name, node, ctx, local=False)

    def report(self, name, node, ctx, local, called=None, free=False):
        """Report `name`, read at `node` with no value. `called` is the line
        of a call that runs the function the read is in, and the functions
        it goes through to get there; `free` is a read of a name of the
        function around that one."""
        own = local or free
        if self.quiet or ctx.guarded or name in self.explained or (own and name in self.shadowed):
            return
        key = (name, id(ctx.scope) if own else None)
        if key in self.reported:
            return
        self.reported.add(key)
        line = node.lineno
        facts = {}
        owner = ctx.scope if own else self.module
        removed = self.removed.get((id(owner), name))
        if called is not None:
            facts["called_on"], facts["called"] = called[0], list(called[1])
            later = [n for n in owner.lines.get(name, ()) if n > called[0]]
            if later:
                facts["defined_on"] = min(later)
        elif removed is not None and removed[1] < line:
            facts["deleted_on" if removed[0] == "del" else "except_on"] = removed[1]
        elif not local and not ctx.later and name in self.defining:
            facts["being_defined"] = True
        elif not local and not ctx.later:
            later = [n for n in self.module.lines.get(name, ()) if n > line]
            if later:
                facts["defined_on"] = min(later)
        if ctx.annotation:
            facts["in_annotation"] = True
        self.findings.append(_pll_finding(
            "undefined-name",
            "UnboundLocalError" if local else "NameError",
            line,
            node.col_offset,
            name,
            says=(
                "cannot access free variable '%s' where it is not associated with a value in enclosing scope" % name
                if free
                else self.python_says(name, ctx.scope, local)
            ),
            text=self.lines[line - 1] if 0 < line <= len(self.lines) else None,
            **facts,
        ))

    def python_says(self, name, scope, local):
        """Python's own message for the error, "Did you mean" and all."""
        if local:
            return "cannot access local variable '%s' where it is not associated with a value" % name
        message = "name '%s' is not defined" % name
        method = scope.method_of if scope.kind == "function" else None
        if method is not None and self.instance_has(method, name):
            return message + ". Did you mean: 'self.%s'?" % name
        candidates = []
        while scope is not None:
            if scope.kind != "class" or scope is self.module:
                candidates.extend(sorted(scope.local))
            scope = scope.parent
        candidates += sorted(n for n in self.initial if not n.startswith("_pll")) + sorted(_PLL_BUILTIN_NAMES)
        suggestion = None
        try:
            import _suggestions as _pll_suggestions

            suggestion = _pll_suggestions._generate_suggestions(candidates, name)
        except Exception:
            pass
        if suggestion:
            message += ". Did you mean: '%s'?" % suggestion
        if name in getattr(_sys, "stdlib_module_names", ()):
            message += (" Or did you" if suggestion else ". Did you") + " forget to import '%s'?" % name
        return message

    def instance_has(self, cls, name):
        """Whether an instance of the class `cls` scopes would have `name`: a
        field, a method, or a `self.name = ...` in one of its methods."""
        if name in cls.assigned:
            return True
        for node in _ast.walk(cls.node):
            if (
                isinstance(node, _ast.Attribute)
                and isinstance(node.ctx, _ast.Store)
                and node.attr == name
                and isinstance(node.value, _ast.Name)
                and node.value.id == "self"
            ):
                return True
        return False

    # -- expressions -----------------------------------------------------------

    def expr(self, node, state, ctx):
        """Read what `node` reads; the names that may have a value after it
        (a `:=` can give one)."""
        if node is None:
            return state
        if isinstance(node, _ast.Name):
            if isinstance(node.ctx, _ast.Load):
                self.read(node.id, node, state, ctx)
            return state
        if isinstance(node, _ast.NamedExpr):
            state = self.expr(node.value, state, ctx)
            return self.bind(node.target, state, ctx)
        if isinstance(node, _ast.Lambda):
            args = node.args
            for default in list(args.defaults) + [d for d in args.kw_defaults if d is not None]:
                state = self.expr(default, state, ctx)
            self.function_body(node)
            return state
        if isinstance(node, _ast.GeneratorExp):
            return self.generator(node, state, ctx)
        if isinstance(node, _PLL_NAME_COMPREHENSIONS):
            return self.comprehension(node, state, ctx)
        for child in _ast.iter_child_nodes(node):
            if not isinstance(child, (_ast.expr_context, _ast.operator, _ast.cmpop, _ast.boolop, _ast.unaryop)):
                state = self.expr(child, state, ctx)
        if isinstance(node, _ast.Call) and isinstance(node.func, _ast.Name):
            self.call(node, state, ctx)
        return state

    def call(self, node, state, ctx):
        """`f(...)`, where `f` is a function this scope defines: the call runs
        it here, so the names of this scope that it certainly reads need a
        value by now - and so do those of the functions it calls in turn."""
        scope = ctx.scope
        if scope.kind == "module" and not ctx.later:
            # A function can give the file names with `global`, at any time.
            given = self.given_by_functions
        elif scope.kind == "function":
            given = self.given_by_inner.get(id(scope), set())
        else:
            return
        name = node.func.id
        if name in ctx.comp or name in scope.globals or name in scope.nonlocals or self.dynamic or scope.star:
            return
        pending, seen = [(name, ())], set()
        while pending:
            name, path = pending.pop()
            function = scope.function(name)
            if function is None or name not in state or name in given or id(function) in seen:
                continue
            if not _pll_runs_when_called(function):
                continue
            seen.add(id(function))
            path += (name,)
            callee = self.scopes.of[function]
            reads, calls = _pll_certain_reads(function)
            for read in reads:
                if not self.reads_from(read.id, callee, scope) or read.id in state or read.id in given:
                    continue
                if scope.kind == "module" and self.always(read.id):
                    continue
                self.report(read.id, read, ctx, local=False, called=(node.lineno, path), free=scope.kind == "function")
            pending.extend((called, path) for called in calls if self.reads_from(called, callee, scope))

    @staticmethod
    def reads_from(name, callee, scope):
        """Whether `name`, read in the function `callee` defined directly in
        `scope`, is `scope`'s own."""
        if name in callee.local or name in callee.type_params or name in callee.globals:
            return False
        return name in scope.local

    def bind(self, target, state, ctx):
        """Give the names `target` binds a value, reading what it reads:
        `a[i] = ...` reads `a` and `i`."""
        if isinstance(target, _ast.Name):
            self.removed.pop((id(self.owner(target.id, ctx)), target.id), None)
            return state | {target.id}
        if isinstance(target, (_ast.Tuple, _ast.List)):
            for element in target.elts:
                state = self.bind(element, state, ctx)
            return state
        if isinstance(target, _ast.Starred):
            return self.bind(target.value, state, ctx)
        return self.expr(target, state, ctx)

    def owner(self, name, ctx):
        """The scope a name bound or removed here belongs to."""
        scope = ctx.scope
        while scope.kind == "generator" and scope.parent is not None:
            scope = scope.parent
        if name in scope.globals:
            return self.module
        return scope

    def comprehension(self, node, state, ctx):
        """A list, set or dict comprehension, which runs where it is written,
        with its own names for what it loops over."""
        generators = node.generators
        state = self.expr(generators[0].iter, state, ctx)
        inner = ctx.but(skip_own=True) if ctx.scope.kind == "class" and not ctx.skip_own else ctx
        own = set()
        for i, generator in enumerate(generators):
            if i:
                state = self.expr(generator.iter, state, inner.but(comp=ctx.comp | own))
            own |= {n.id for n in _ast.walk(generator.target) if isinstance(n, _ast.Name)}
            for condition in generator.ifs:
                state = self.expr(condition, state, inner.but(comp=ctx.comp | own))
        for part in (node.key, node.value) if isinstance(node, _ast.DictComp) else (node.elt,):
            state = self.expr(part, state, inner.but(comp=ctx.comp | own))
        return state

    def generator(self, node, state, ctx):
        """A generator: its first `in` is read where it is written, and the
        rest whenever it is iterated, which may be any time later."""
        generators = node.generators
        state = self.expr(generators[0].iter, state, ctx)
        later = _PllReading(self.scopes.of[node], later=True)
        inner = frozenset()
        for i, generator in enumerate(generators):
            if i:
                inner = self.expr(generator.iter, inner, later)
            inner = self.bind(generator.target, inner, later)
            for condition in generator.ifs:
                inner = self.expr(condition, inner, later)
        self.expr(node.elt, inner, later)
        return state

    # -- statements ------------------------------------------------------------

    def body(self, statements, state, ctx):
        for statement in statements:
            if state is None:
                # Nothing after a `return`, `raise`, `break` or `continue`
                # runs, so nothing it reads is a NameError.
                return None
            state = self.statement(statement, state, ctx)
        return state

    def statement(self, node, state, ctx):
        if isinstance(node, _PLL_NAME_FUNCTIONS):
            return self.define(node, state, ctx)
        if isinstance(node, _ast.ClassDef):
            return self.define_class(node, state, ctx)
        if isinstance(node, _ast.Return):
            self.expr(node.value, state, ctx)
            return None
        if isinstance(node, _ast.Raise):
            self.expr(node.cause, self.expr(node.exc, state, ctx), ctx)
            return None
        if isinstance(node, (_ast.Break, _ast.Continue)):
            if self.loops:
                self.loops[-1][0 if isinstance(node, _ast.Break) else 1].append(state)
            return None
        if isinstance(node, _ast.Assign):
            state = self.expr(node.value, state, ctx)
            for target in node.targets:
                state = self.bind(target, state, ctx)
            return state
        if isinstance(node, _ast.AugAssign):
            if isinstance(node.target, _ast.Name):
                self.read(node.target.id, node.target, state, ctx)
                return self.bind(node.target, self.expr(node.value, state, ctx), ctx)
            return self.expr(node.value, self.expr(node.target, state, ctx), ctx)
        if isinstance(node, _ast.AnnAssign):
            return self.annotated(node, state, ctx)
        if isinstance(node, (_ast.For, _ast.AsyncFor, _ast.While)):
            return self.loop(node, state, ctx)
        if isinstance(node, _ast.If):
            state = self.expr(node.test, state, ctx)
            if _pll_always_true(node.test):
                return self.body(node.body, state, ctx)
            if _pll_always_false(node.test):
                return self.body(node.orelse, state, ctx)
            return _pll_union(self.body(node.body, state, ctx), self.body(node.orelse, state, ctx))
        if isinstance(node, (_ast.With, _ast.AsyncWith)):
            return self.with_(node, state, ctx)
        if isinstance(node, (_ast.Try, getattr(_ast, "TryStar", _ast.Try))):
            return self.try_(node, state, ctx)
        if isinstance(node, _ast.Match):
            return self.match_(node, state, ctx)
        if isinstance(node, _ast.Delete):
            for target in node.targets:
                state = self.delete(target, node, state, ctx)
            return state
        if isinstance(node, (_ast.Import, _ast.ImportFrom)):
            return state | {alias.asname or alias.name.split(".")[0] for alias in node.names if alias.name != "*"}
        if isinstance(node, (_ast.Global, _ast.Nonlocal, _ast.Pass)):
            return state
        if isinstance(node, getattr(_ast, "TypeAlias", ())):
            scope = self.scopes.of[node]
            self.expr(node.value, scope.type_params, _PllReading(scope, later=True, annotation=True))
            return state | {node.name.id}
        for child in _ast.iter_child_nodes(node):
            state = self.expr(child, state, ctx)
        return state

    def define(self, node, state, ctx):
        """A `def`: its decorators, defaults and annotations are read as it
        runs, and its body whenever it is called."""
        args = node.args
        for expression in node.decorator_list + list(args.defaults) + [d for d in args.kw_defaults if d is not None]:
            state = self.expr(expression, state, ctx)
        annotations = [arg.annotation for arg in _pll_all_args(args) if arg.annotation is not None]
        annotations += [node.returns] if node.returns is not None else []
        own_types = ctx.comp | _pll_type_param_names(node)
        if self.future_annotations:
            # Read as strings, when the function is checked as it is called.
            for annotation in annotations:
                self.read_anywhere(annotation, ctx.but(annotation=True))
        else:
            for annotation in annotations:
                state = self.expr(annotation, state, ctx.but(comp=own_types, annotation=True))
        state = self.bind(_ast.Name(id=node.name, ctx=_ast.Store()), state, ctx)
        self.function_body(node)
        return state

    def read_anywhere(self, node, ctx):
        """An annotation read later and from wherever it can be: only a name
        given a value nowhere in the file is a NameError."""
        everywhere = set()
        for scope in self.scopes.of.values():
            everywhere |= scope.assigned | scope.type_params
        for name in _ast.walk(node):
            if isinstance(name, _ast.Name) and isinstance(name.ctx, _ast.Load):
                if name.id not in everywhere:
                    self.read_module_later(name.id, name, ctx.but(later=True))

    def function_body(self, node):
        scope = self.scopes.of[node]
        state = frozenset(arg.arg for arg in _pll_all_args(node.args)) | scope.type_params
        ctx = _PllReading(scope, later=True)
        if isinstance(node, _ast.Lambda):
            self.expr(node.body, state, ctx)
        else:
            self.body(node.body, state, ctx)

    def define_class(self, node, state, ctx):
        """A `class`: its body runs where it is written, with names of its
        own, and reads any it lacks where the `class` statement runs."""
        for expression in node.decorator_list:
            state = self.expr(expression, state, ctx)
        own_types = ctx.comp | _pll_type_param_names(node)
        for expression in node.bases + [k.value for k in node.keywords]:
            state = self.expr(expression, state, ctx.but(comp=own_types))
        at_class = state
        body_ctx = _PllReading(
            self.scopes.of[node],
            later=ctx.later,
            guarded=ctx.guarded,
            comp=own_types,
            outer=lambda name, read_at: self.read(name, read_at, at_class, ctx),
        )
        self.defining.append(node.name)
        try:
            self.body(node.body, frozenset(("__module__", "__qualname__")), body_ctx)
        finally:
            self.defining.pop()
        return self.bind(_ast.Name(id=node.name, ctx=_ast.Store()), state, ctx)

    def annotated(self, node, state, ctx):
        """`x: T = v`. A function's local annotation is read only when there
        is a value to check against it; elsewhere it is always read."""
        if node.value is not None:
            state = self.expr(node.value, state, ctx)
        local = ctx.scope.kind in ("function", "generator")
        if not self.future_annotations and (node.value is not None or not local):
            state = self.expr(node.annotation, state, ctx.but(annotation=True))
        if isinstance(node.target, _ast.Name):
            return self.bind(node.target, state, ctx) if node.value is not None else state
        return self.expr(node.target, state, ctx)

    def delete(self, target, statement, state, ctx):
        if isinstance(target, _ast.Name):
            # The levels that refuse removing a name report that instead.
            if not self.teaching:
                self.read(target.id, target, state, ctx)
            self.removed[(id(self.owner(target.id, ctx)), target.id)] = ("del", statement.lineno)
            return state - {target.id}
        if isinstance(target, (_ast.Tuple, _ast.List)):
            for element in target.elts:
                state = self.delete(element, statement, state, ctx)
            return state
        return self.expr(target, state, ctx)

    def loop(self, node, state, ctx):
        """A `for` or `while`: its body may run any number of times, so it
        is followed until the names that may have a value stop growing."""
        is_for = not isinstance(node, _ast.While)
        if is_for:
            state = self.expr(node.iter, state, ctx)
        elif _pll_always_false(node.test):
            return self.body(node.orelse, state, ctx)
        head = state
        self.quiet += 1
        try:
            while True:
                end, continues, _ = self.iteration(node, head, ctx, is_for)
                grown = _pll_union(head, end, *continues)
                if grown == head:
                    break
                head = grown
        finally:
            self.quiet -= 1
        _, _, breaks = self.iteration(node, head, ctx, is_for)
        # `while True:` only ever ends by a `break`.
        ended = None if not is_for and _pll_always_true(node.test) else self.body(node.orelse, head, ctx)
        return _pll_union(ended, *breaks)

    def iteration(self, node, head, ctx, is_for):
        frame = ([], [])
        self.loops.append(frame)
        try:
            state = self.bind(node.target, head, ctx) if is_for else self.expr(node.test, head, ctx)
            end = self.body(node.body, state, ctx)
        finally:
            self.loops.pop()
        return end, frame[1], frame[0]

    def with_(self, node, state, ctx):
        for item in node.items:
            state = self.expr(item.context_expr, state, ctx)
            if item.optional_vars is not None:
                state = self.bind(item.optional_vars, state, ctx)
        end = self.body(node.body, state, ctx)
        # A context manager can stop an exception from anywhere in the body,
        # and the code after the `with` goes on from there.
        return _pll_union(end, state | _pll_binds_in(node.body))

    def try_(self, node, state, ctx):
        caught = any(_pll_catches_name_error(handler) for handler in node.handlers)
        end = self.body(node.body, state, ctx.but(guarded=True) if caught else ctx)
        # A handler starts from wherever the body raised.
        anywhere = state | _pll_binds_in(node.body)
        ends = [self.body(node.orelse, end, ctx) if end is not None else None]
        for handler in node.handlers:
            entry = self.expr(handler.type, anywhere, ctx)
            if handler.name:
                entry = entry | {handler.name}
            out = self.body(handler.body, entry, ctx)
            if handler.name:
                # Python removes the name when the handler ends.
                self.removed[(id(self.owner(handler.name, ctx)), handler.name)] = ("except", handler.lineno)
                if out is not None:
                    out = out - {handler.name}
            ends.append(out)
        normal = _pll_union(*ends)
        if not node.finalbody:
            return normal
        everything = anywhere | _pll_binds_in(node.orelse) | _pll_binds_in([h for h in node.handlers])
        finished = self.body(node.finalbody, _pll_union(normal, everything), ctx)
        return None if normal is None or finished is None else finished

    def match_(self, node, state, ctx):
        state = self.expr(node.subject, state, ctx)
        ends = [state]
        for case in node.cases:
            entry = self.pattern(case.pattern, state, ctx)
            if case.guard is not None:
                entry = self.expr(case.guard, entry, ctx)
            ends.append(self.body(case.body, entry, ctx))
        return _pll_union(*ends)

    def pattern(self, node, state, ctx):
        """Read what a `case` pattern reads, and give its captures a value."""
        if isinstance(node, _ast.MatchValue):
            return self.expr(node.value, state, ctx)
        if isinstance(node, _ast.MatchSequence):
            for inner in node.patterns:
                state = self.pattern(inner, state, ctx)
            return state
        if isinstance(node, _ast.MatchMapping):
            for key in node.keys:
                state = self.expr(key, state, ctx)
            for inner in node.patterns:
                state = self.pattern(inner, state, ctx)
            return state | {node.rest} if node.rest else state
        if isinstance(node, _ast.MatchClass):
            state = self.expr(node.cls, state, ctx)
            for inner in node.patterns + node.kwd_patterns:
                state = self.pattern(inner, state, ctx)
            return state
        if isinstance(node, (_ast.MatchStar, _ast.MatchAs)):
            if isinstance(node, _ast.MatchAs) and node.pattern is not None:
                state = self.pattern(node.pattern, state, ctx)
            return state | {node.name} if node.name else state
        if isinstance(node, _ast.MatchOr):
            return _pll_union(*(self.pattern(inner, state, ctx) for inner in node.patterns))
        return state
