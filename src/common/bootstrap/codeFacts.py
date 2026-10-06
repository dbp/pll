# What the student's code says about an error, read from the live objects
# and the code that raised: the definitions it names, where the names on
# its line were last set, and how a function that returned `None` is built.
# The explanations need these, and only Python can see them across files:
# `shapes.area(3)` names a function defined somewhere else entirely.

import ast as _ast
import dataclasses as _pll_dataclasses
import inspect as _pll_inspect
import io as _pll_io
import keyword as _pll_keyword
import linecache as _pll_linecache
import re as _pll_src_re
import sys as _pll_sys
import tokenize as _pll_tokenize
import types as _pll_types
import typing as _pll_typing

#: At most this many definitions travel with one error.
_PLL_MAX_DEFINITIONS = 20

#: The names in a message that name something defined: `area()`,
#: `Song.__init__()`, `'Song' object`, `type object 'Song'`.
_PLL_NAMED_IN_MESSAGE = (
    _pll_src_re.compile(r"\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\(\)"),
    _pll_src_re.compile(r"'([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)' object"),
    _pll_src_re.compile(r"type object '([A-Za-z_]\w*)'"),
)

#: PLL's own namespace, which the libraries share with the bootstrap.
_PLL_OWN = globals()

_PLL_POSITIONAL = (
    _pll_inspect.Parameter.POSITIONAL_ONLY,
    _pll_inspect.Parameter.POSITIONAL_OR_KEYWORD,
)


def _pll_is_own(obj):
    """Whether `obj` is one of PLL's own functions or classes."""
    name = getattr(obj, "__name__", None)
    return isinstance(name, str) and _PLL_OWN.get(name) is obj


def _pll_is_students_class(cls):
    """Whether `cls` was written in one of the student's files.

    Not by its module's name alone: PLL's libraries run as `__main__` too.
    """
    if _pll_is_own(cls):
        return False
    if cls.__module__ == "__main__":
        return True
    module = _pll_sys.modules.get(cls.__module__)
    filename = getattr(module, "__file__", None)
    return isinstance(filename, str) and _pll_is_students(filename)


def _pll_union_members(obj):
    """The types a union is made of, by name, or None if `obj` is not one."""
    if not (isinstance(obj, _pll_types.UnionType) or _pll_typing.get_origin(obj) is _pll_typing.Union):
        return None
    names = []
    for member in _pll_typing.get_args(obj):
        name = "None" if member is type(None) else getattr(member, "__name__", None)
        if isinstance(name, str):
            names.append(name)
    return names


def _pll_definition(obj, drop_first=False):
    """What `obj` is, as the explanations use it, or None.

    - a function: its positional `parameters`, and the `required` ones;
      `drop_first` leaves out a method's `self`
    - a class: whether it is the student's, and if so its `fields`, in
      order, and whether it is a `dataclass`
    - a union: its `members`
    """
    if isinstance(obj, type):
        students = _pll_is_students_class(obj)
        fields = []
        if students:
            if _pll_dataclasses.is_dataclass(obj):
                fields = [field.name for field in _pll_dataclasses.fields(obj)]
            else:
                fields = list(_pll_inspect.get_annotations(obj))
        return {
            "kind": "class",
            "students": students,
            "fields": fields,
            "dataclass": students and _pll_dataclasses.is_dataclass(obj),
        }
    members = _pll_union_members(obj)
    if members is not None:
        return {"kind": "union", "members": members}
    if not (_pll_inspect.isfunction(obj) or _pll_inspect.ismethod(obj)):
        return None
    try:
        parameters = list(_pll_inspect.signature(obj).parameters.values())
    except (TypeError, ValueError):
        return None
    if drop_first:
        parameters = parameters[1:]
    positional = [p for p in parameters if p.kind in _PLL_POSITIONAL]
    return {
        "kind": "function",
        "parameters": [p.name for p in positional],
        "required": [p.name for p in positional if p.default is p.empty],
    }


_PLL_UNRESOLVED = object()


def _pll_resolve(chain, scopes):
    """`obj`, and whether it is a method reached through its class or one of
    its instances, for a dotted name like `shapes.area` - looked up without
    running anything (no properties, no `__getattr__`)."""
    head, *rest = chain.split(".")
    obj = _PLL_UNRESOLVED
    for scope in scopes:
        if head in scope:
            obj = scope[head]
            break
    if obj is _PLL_UNRESOLVED:
        return _PLL_UNRESOLVED, False
    method = False
    for attr in rest:
        try:
            found = _pll_inspect.getattr_static(obj, attr)
        except AttributeError:
            return _PLL_UNRESOLVED, False
        method = not isinstance(obj, _pll_types.ModuleType)
        if isinstance(found, staticmethod):
            found, method = found.__func__, False
        elif isinstance(found, classmethod):
            found = found.__func__
        obj = found
    return obj, method and _pll_inspect.isfunction(obj)


def _pll_line_names(text):
    """The names on a line, dotted ones whole: `shapes.area`, `print`."""
    chains = []
    current = None
    after_dot = False
    try:
        for token in _pll_tokenize.generate_tokens(_pll_io.StringIO(text).readline):
            if token.type == _pll_tokenize.NAME and not _pll_keyword.iskeyword(token.string):
                current = current + "." + token.string if after_dot and current else token.string
                after_dot = False
                continue
            if token.type == _pll_tokenize.OP and token.string == "." and current:
                after_dot = True
                continue
            if current:
                chains.append(current)
            current, after_dot = None, False
    except (_pll_tokenize.TokenError, SyntaxError):
        pass
    if current:
        chains.append(current)
    return chains


def _pll_definitions(exc, frame, text):
    """The definitions an explanation of `exc` might name: those its
    message names, and those named on the student's line.

    Keyed as written - `shapes.area` - and by the last part too, which is
    how Python's message names it (`area() missing ...`).
    """
    # PLL's own classes - `Table` in `Table.scatter_plot()` - are among
    # every session's globals.
    scopes = [frame.f_locals, frame.f_globals, frame.f_builtins]
    message = str(exc)
    chains = []
    for pattern in _PLL_NAMED_IN_MESSAGE:
        for chain in pattern.findall(message):
            parts = chain.split(".")
            # `Song.__init__()` is about `Song` as much as its `__init__`.
            chains.extend(".".join(parts[: i + 1]) for i in range(len(parts)))
    chains.extend(_pll_line_names(text or ""))
    found = {}
    # The class of the value an attribute was asked of, which no name may
    # reach: `'Song' object has no attribute 'yaer'`.
    if isinstance(exc, AttributeError) and getattr(exc, "obj", None) is not None:
        cls = exc.obj if isinstance(exc.obj, type) else type(exc.obj)
        described = _pll_definition(cls)
        if described is not None:
            found[cls.__name__] = described
    for chain in chains:
        if len(found) >= _PLL_MAX_DEFINITIONS:
            break
        if chain in found:
            continue
        obj, method = _pll_resolve(chain, scopes)
        if obj is _PLL_UNRESOLVED:
            continue
        described = _pll_definition(obj, drop_first=method)
        if described is None:
            continue
        found[chain] = described
        last = chain.rsplit(".", 1)[-1]
        if last != chain and last not in found:
            found[last] = described
    return found


def _pll_tree_of(code, run):
    """The parsed source `code` was compiled from, as it ran, or None."""
    source = _pll_source_of(code, run)
    if not source:
        return None, ""
    try:
        return _ast.parse(source), source
    except (SyntaxError, ValueError):
        return None, source


def _pll_function_node(tree, code, lineno):
    """The `def` that `code` runs, found by its name and the line inside it."""
    best = None
    for node in _ast.walk(tree):
        if (
            isinstance(node, (_ast.FunctionDef, _ast.AsyncFunctionDef))
            and node.name == code.co_name
            and node.lineno <= lineno <= (node.end_lineno or node.lineno)
        ):
            # The innermost, for a function defined inside another.
            if best is None or node.lineno >= best.lineno:
                best = node
    return best


def _pll_scope_statements(body):
    """Every statement of a scope, in order, into `if`s and loops but not
    into the functions and classes it defines."""
    for statement in body:
        yield statement
        if isinstance(statement, (_ast.FunctionDef, _ast.AsyncFunctionDef, _ast.ClassDef)):
            continue
        for field in ("body", "orelse", "finalbody"):
            yield from _pll_scope_statements(getattr(statement, field, None) or [])
        for handler in getattr(statement, "handlers", None) or []:
            yield from _pll_scope_statements(handler.body)
        for case in getattr(statement, "cases", None) or []:
            yield from _pll_scope_statements(case.body)


def _pll_dotted(node):
    """`f` or `x.append`, for the function a call calls, or None."""
    parts = []
    while isinstance(node, _ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if not isinstance(node, _ast.Name):
        return None
    parts.append(node.id)
    return ".".join(reversed(parts))


def _pll_calls_assigned(body, names, before):
    """For each of `names` set from a call in `body`: the call and its line,
    the last before line `before` - or after it, when none is before (a
    loop goes round)."""
    earlier, later = {}, {}
    for statement in _pll_scope_statements(body):
        if isinstance(statement, _ast.Assign) and len(statement.targets) == 1:
            target, value = statement.targets[0], statement.value
        elif isinstance(statement, _ast.AnnAssign) and statement.value is not None:
            target, value = statement.target, statement.value
        else:
            continue
        if not (isinstance(target, _ast.Name) and target.id in names and isinstance(value, _ast.Call)):
            continue
        call = _pll_dotted(value.func)
        if call is None:
            continue
        side = earlier if statement.lineno < before else later
        if side is earlier or target.id not in later:
            side[target.id] = {"call": call, "line": statement.lineno}
    return {**later, **earlier}


def _pll_assigned(frame, lineno, tree, names):
    """Where the names on the failing line were last set from a call: in
    the function the error is in, or - for a global - in its file."""
    code = frame.f_code
    node = _pll_function_node(tree, code, lineno) if code.co_name != "<module>" else None
    local = set(code.co_varnames) if node is not None else set()
    found = {}
    if node is not None:
        found.update(_pll_calls_assigned(node.body, names & local, lineno))
    module_before = lineno if node is None else float("inf")
    for name, where in _pll_calls_assigned(tree.body, names - local, module_before).items():
        found.setdefault(name, where)
    return found


def _pll_union_named(annotation, frame):
    """The members of the union an annotation names, or None."""
    if isinstance(annotation, _ast.Name):
        value = frame.f_globals.get(annotation.id, frame.f_builtins.get(annotation.id))
        return _pll_union_members(value)
    if isinstance(annotation, _ast.BinOp) and isinstance(annotation.op, _ast.BitOr):
        left = _pll_union_named(annotation.left, frame)
        right = _pll_union_named(annotation.right, frame)
        names = []
        for side, part in ((left, annotation.left), (right, annotation.right)):
            if side is not None:
                names.extend(side)
            elif isinstance(part, _ast.Name):
                names.append(part.id)
            elif isinstance(part, _ast.Constant) and part.value is None:
                names.append("None")
            else:
                return None
        return names
    return None


def _pll_pattern_classes(pattern):
    """The classes a `case` pattern matches, or None for one that matches
    anything (`case _:`, `case x:`)."""
    if isinstance(pattern, _ast.MatchAs):
        return None if pattern.pattern is None else _pll_pattern_classes(pattern.pattern)
    if isinstance(pattern, _ast.MatchOr):
        names = set()
        for alternative in pattern.patterns:
            inner = _pll_pattern_classes(alternative)
            if inner is None:
                return None
            names |= inner
        return names
    if isinstance(pattern, _ast.MatchClass):
        name = _pll_dotted(pattern.cls)
        return {name.rsplit(".", 1)[-1]} if name else set()
    if isinstance(pattern, _ast.MatchSingleton) and pattern.value is None:
        return {"None"}
    return set()


def _pll_trailing_match(node, source, frame):
    """The `match` a function ends with, when it ends with one.

    A `match` no `case` fits does nothing, and the function then runs off
    its end and returns `None`.
    """
    last = node.body[-1] if node.body else None
    if not isinstance(last, _ast.Match):
        return None
    segment = lambda part: _ast.get_source_segment(source, part) or ""
    patterns = [case.pattern for case in last.cases]
    fixed = [
        segment(p)
        for p in patterns
        if isinstance(p, _ast.MatchSequence)
        and len(p.patterns) >= 2
        and not any(isinstance(inner, _ast.MatchStar) for inner in p.patterns)
        and segment(p).startswith("[")
    ]
    lists = [p for p in patterns if isinstance(p, _ast.MatchSequence) and segment(p).startswith("[")]
    # The members of the union being matched that no `case` names - only
    # when the subject is a parameter annotated with a union.
    uncovered = []
    subject = last.subject
    if isinstance(subject, _ast.Name):
        arguments = node.args.posonlyargs + node.args.args + node.args.kwonlyargs
        annotation = next((a.annotation for a in arguments if a.arg == subject.id), None)
        members = _pll_union_named(annotation, frame) if annotation is not None else None
        if members:
            covered = set()
            for pattern in patterns:
                classes = _pll_pattern_classes(pattern)
                if classes is None:
                    covered = None
                    break
                covered |= classes
            if covered is not None:
                uncovered = [member for member in members if member not in covered]
    return {
        "subject": segment(subject),
        "patterns": [segment(p) for p in patterns],
        "fixed_length": fixed,
        "has_list": len(lists) > 0,
        "uncovered": uncovered,
    }


def _pll_blocks(body):
    """Every block of statements in a function body, the body included,
    not into the functions and classes it defines."""
    yield body
    for statement in body:
        if isinstance(statement, (_ast.FunctionDef, _ast.AsyncFunctionDef, _ast.ClassDef)):
            continue
        for field in ("body", "orelse", "finalbody"):
            inner = getattr(statement, field, None)
            if inner:
                yield from _pll_blocks(inner)
        for handler in getattr(statement, "handlers", None) or []:
            yield from _pll_blocks(handler.body)
        for case in getattr(statement, "cases", None) or []:
            yield from _pll_blocks(case.body)


def _pll_print_ending_a_branch(node, source):
    """The first `print` that is the last statement of its block.

    A branch that ends in `print` shows the right answer and returns
    nothing. A `print` followed by more in its block is just output.
    """
    found = None
    for block in _pll_blocks(node.body):
        last = block[-1]
        call = last.value if isinstance(last, _ast.Expr) else None
        if not (isinstance(call, _ast.Call) and isinstance(call.func, _ast.Name) and call.func.id == "print"):
            continue
        if found is not None and found["line"] <= last.lineno:
            continue
        single = len(call.args) == 1 and not call.keywords and not isinstance(call.args[0], _ast.Starred)
        found = {
            "line": last.lineno,
            "expression": _ast.get_source_segment(source, call.args[0]) if single else None,
        }
    return found


def _pll_returned_none(frame, lineno, tree, source):
    """How the function a `None` return came from is built: the `match` it
    ends with, and a branch of it that ends in `print`."""
    node = _pll_function_node(tree, frame.f_code, lineno)
    if node is None:
        return None
    return {
        "match": _pll_trailing_match(node, source, frame),
        "printed": _pll_print_ending_a_branch(node, source),
    }


def _pll_code_facts(exc, run):
    """The facts about the student's code that explaining `exc` needs, for
    `_pll_error_info`: `definitions`, `assigned`, and - for a function
    annotated to return something that returned `None` - `returned_none`."""
    if isinstance(exc, SyntaxError):
        return {}
    frames = _pll_student_frames(exc)
    if not frames:
        return {}
    frame, lineno = frames[-1]
    text = _pll_source_line(frame.f_code, lineno, run)
    facts = {"definitions": _pll_definitions(exc, frame, text)}
    tree, source = _pll_tree_of(frame.f_code, run)
    if tree is None:
        return facts
    names = {chain.split(".")[0] for chain in _pll_line_names(text or "")}
    facts["assigned"] = _pll_assigned(frame, lineno, tree, names)
    check = (getattr(exc, "_pll_facts", None) or {}).get("check")
    if check is not None and check["kind"] == "return" and check["actual"] in ("None", "NoneType"):
        returned = _pll_returned_none(frame, lineno, tree, source)
        if returned is not None:
            facts["returned_none"] = returned
    return facts
