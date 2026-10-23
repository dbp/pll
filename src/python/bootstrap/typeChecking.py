# Type checking: which checks a run makes, decided by its language level, and
# the names the instrumentation calls. The checks themselves are contracts
# (contracts.py).

import builtins as _pll_builtins
import collections.abc as _pll_level_abc
import dataclasses as _pll_level_dataclasses
import operator as _pll_operator
import sys as _sys

# The language levels, as the host sends them: `LEVEL_NAMES` in level.ts
# names the same four.
_PLL_LEVEL_RAW = "raw"
_PLL_LEVEL_BEGINNER = "beginner"
_PLL_LEVEL_INTERMEDIATE = "intermediate"
_PLL_LEVEL_ADVANCED = "advanced"

#: The two that teach: static checks, and no bool where a number is annotated.
_PLL_TEACHING_LEVELS = (_PLL_LEVEL_BEGINNER, _PLL_LEVEL_INTERMEDIATE)

#: The levels students write; `raw` is plain Python.
_PLL_STUDENT_LEVELS = (_PLL_LEVEL_BEGINNER, _PLL_LEVEL_INTERMEDIATE, _PLL_LEVEL_ADVANCED)


def _pll_level_names(level):
    """The names a file at `level` starts with beyond `_pll_initial_globals`.
    At the student levels:

    - `Callable`, the type of a function, which an annotation needs often
      enough that it should need no import;
    - `dataclass`, which every data definition starts with;
    - `print`, which shows a picture or a table as the top level shows one
      (`_pll_print`, sessions.py).

    `#level raw` is Python, which has neither.
    """
    if level not in _PLL_STUDENT_LEVELS:
        return {}
    return {"Callable": _pll_level_abc.Callable, "dataclass": _pll_level_dataclasses.dataclass, "print": _pll_print}


def _pll_hidden(name, value):
    """Put `value` where PLL's instrumentation finds it, and return its name.

    Among the builtins, as `pll:name`: a name no program can write, so
    `dir()` does not list it and no assignment of the student's can hide
    it. The code PLL adds to theirs names it so.
    """
    key = "pll:" + name
    _pll_builtins.__dict__[key] = value
    return key


#: The names PLL's instrumentation calls, among the builtins once set.
_PLL_SHOW_TOP_LEVEL = "pll:show_top_level"
_PLL_CHECK_DATACLASS_FIELDS = "pll:check_dataclass_fields"

def _pll_checks_annotations(level):
    """Whether code at `level` has its annotations checked as it runs.

    Every level but `raw`, which exists so a file can opt out; there is no
    separate setting, so nothing can disagree with the level. How strictly
    a number is checked is decided per contract, from the level of the file
    its annotation is in (bootstrap/contracts.py).
    """
    return level != _PLL_LEVEL_RAW


#: Python's own recursion limit, and the one at the levels that check: a
#: call of a contracted function goes through its contract's wrapper, a
#: second frame, so the limit doubles to leave recursion as deep as before.
_PLL_PYTHON_RECURSION_LIMIT = 1000
_PLL_CHECKED_RECURSION_LIMIT = 2 * _PLL_PYTHON_RECURSION_LIMIT


def _pll_set_recursion_limit(level):
    """The recursion limit for a run at `level`."""
    _sys.setrecursionlimit(
        _PLL_CHECKED_RECURSION_LIMIT if _pll_checks_annotations(level) else _PLL_PYTHON_RECURSION_LIMIT
    )


# -- bitwise operators, at the teaching levels ------------------------------------


class _PllBitwiseOperator(Exception):
    """A bitwise operator between numbers, at a level that does not use them;
    what the explanation needs is in its facts (`bitwise`)."""


_PllBitwiseOperator.__name__ = _PllBitwiseOperator.__qualname__ = "BitwiseOperator"
_PllBitwiseOperator.__module__ = "builtins"

#: Each bitwise operator, as `pll:bitwise` does it and as `op=` does it.
_PLL_BITWISE = {
    "|": (_pll_operator.or_, _pll_operator.ior),
    "&": (_pll_operator.and_, _pll_operator.iand),
    "^": (_pll_operator.xor, _pll_operator.ixor),
    "<<": (_pll_operator.lshift, _pll_operator.ilshift),
    ">>": (_pll_operator.rshift, _pll_operator.irshift),
}


def _pll_bitwise(symbol, left, right, written, left_text, right_text):
    """`left symbol right` at `beginner` and `intermediate` (compile.py):
    refused between two numbers - `True` and `False` among them - where it
    works on binary digits; anything else - types (`int | None`), sets,
    dictionaries, a table's masks - is what Python does."""
    if isinstance(left, int) and isinstance(right, int):
        _pll_refuse_bitwise(symbol, written, left_text, right_text, left, right)
    return _PLL_BITWISE[symbol][0](left, right)


def _pll_bitwise_not(operand, written, operand_text):
    """`~operand`, as `_pll_bitwise`: refused for a number."""
    if isinstance(operand, int):
        _pll_refuse_bitwise("~", written, operand_text, None, operand, None)
    return ~operand


def _pll_refuse_bitwise(symbol, written, left_text, right_text, left, right):
    if symbol == "~":
        result = ~left
    elif symbol in ("<<", ">>"):
        # A shift's answer can be enormous, and says nothing more.
        result = None
    else:
        result = _PLL_BITWISE[symbol][0](left, right)
    error = _PllBitwiseOperator("%s is a bitwise operation on %r%s" % (
        written, left, "" if right is None else " and %r" % (right,)
    ))
    _pll_add_facts(error, bitwise={
        "operator": symbol,
        "written": written,
        "left": left_text,
        "right": right_text,
        "result": None if result is None else repr(result),
    })
    raise error


_pll_hidden("bitwise", _pll_bitwise)
_pll_hidden("bitwise_not", _pll_bitwise_not)


# -- changing a list, a dictionary or a set in place, at the teaching levels ---------


class _PllMutation(Exception):
    """A list, a dictionary, a set or a dataclass changed in place, at a level
    that refuses it: what the explanation needs is in its facts (`mutation`)."""


_PllMutation.__name__ = _PllMutation.__qualname__ = "Mutation"
_PllMutation.__module__ = "builtins"

#: The methods that change each kind of value in place - the rest of its
#: methods (`index`, `count`, `copy`, `get`, `union`) give a new value back.
_PLL_MUTATORS = {
    "list": frozenset(("append", "extend", "insert", "remove", "pop", "clear", "sort", "reverse")),
    "dict": frozenset(("update", "setdefault", "pop", "popitem", "clear")),
    "set": frozenset((
        "add", "remove", "discard", "pop", "clear", "update",
        "intersection_update", "difference_update", "symmetric_difference_update",
    )),
}

#: Library functions that change what they are given in place, by the
#: module and name they report (one written in C reports `_heapq`), and what
#: `_pll_mutation_instead` calls them.
_PLL_LIBRARY_MUTATORS = {
    ("random", "Random.shuffle"): "shuffle",
    ("heapq", "heappush"): "heap",
    ("heapq", "heappop"): "heap",
    ("heapq", "heapify"): "heap",
    ("heapq", "heapreplace"): "heap",
    ("heapq", "heappushpop"): "heap",
    ("bisect", "insort_right"): "insort",
    ("bisect", "insort_left"): "insort",
}

#: The names those are written by, which compile.py checks wherever one is
#: named on its own (`shuffle`, after `from random import shuffle`).
_PLL_LIBRARY_MUTATOR_NAMES = frozenset((
    "shuffle", "heappush", "heappop", "heapify", "heapreplace", "heappushpop", "insort", "insort_left", "insort_right",
))

#: Every name that can change something in place, a method's or a library
#: function's, which compile.py checks wherever it is fetched.
_PLL_MUTATOR_NAMES = frozenset().union(*_PLL_MUTATORS.values(), _PLL_LIBRARY_MUTATOR_NAMES)

#: `x op= y` as Python does it, by operator.
_PLL_IN_PLACE = {
    "+": _pll_operator.iadd, "-": _pll_operator.isub, "*": _pll_operator.imul, "/": _pll_operator.itruediv,
    "//": _pll_operator.ifloordiv, "%": _pll_operator.imod, "**": _pll_operator.ipow, "@": _pll_operator.imatmul,
    "|": _pll_operator.ior, "&": _pll_operator.iand, "^": _pll_operator.ixor,
    "<<": _pll_operator.ilshift, ">>": _pll_operator.irshift,
}


def _pll_mutable_kind(value):
    """"list", "dict" or "set" for one of those (a table's row is a dict), or None."""
    if isinstance(value, list):
        return "list"
    if isinstance(value, dict):
        return "dict"
    if isinstance(value, set):
        return "set"
    return None


def _pll_mutable_type(value):
    """"list", "dict" or "set" for one of those types, or a class made from
    one, or None."""
    if isinstance(value, type):
        for kind, made in (("list", list), ("dict", dict), ("set", set)):
            if issubclass(value, made):
                return kind
    return None


def _pll_refuse_mutation(what, kind, written, level, **parts):
    """Raise the error for changing a value in place at `level`."""
    error = _PllMutation("%s changes a %s in place" % (written, kind))
    _pll_add_facts(error, mutation=dict(parts, what=what, kind=kind, written=written, level=level))
    raise error


def _pll_level_of_caller(depth=2):
    return _sys._getframe(depth).f_globals.get("__pll_level__")


def _pll_attribute(value, name, written, value_text, arguments):
    """`value.name`, for a name that can change something in place
    (`_PLL_MUTATOR_NAMES`), refused as it is fetched: when `value` is a list,
    a dictionary or a set and the method one of its own that changes it
    (`_PLL_MUTATORS`); when `value` is the class, as in `list.append(xs,
    4)`, whose first argument is what it changes; and when what is fetched
    is a library function that changes what it is given. `arguments` are
    what the call it is fetched for gives it, as written - or None."""
    kind = _pll_mutable_kind(value)
    if kind is not None and name in _PLL_MUTATORS[kind]:
        _pll_refuse_mutation(
            "method", kind, written, _pll_level_of_caller(), name=name, target=value_text, arguments=arguments
        )
    kind = _pll_mutable_type(value)
    if kind is not None and name in _PLL_MUTATORS[kind]:
        _pll_refuse_mutation(
            "method", kind, written, _pll_level_of_caller(), name=name,
            target=arguments[0] if arguments else None, arguments=arguments[1:] if arguments else None,
        )
    fetched = getattr(value, name)
    if name in _PLL_LIBRARY_MUTATOR_NAMES:
        _pll_check_library(fetched, written, value_text, arguments)
    return fetched


def _pll_named(function, written, arguments):
    """`function`, named on its own - `shuffle`, after `from random import
    shuffle` - refused when it is a library function that changes what it
    is given."""
    _pll_check_library(function, written, None, arguments)
    return function


def _pll_check_library(function, written, prefix, arguments):
    """Refuse `function` if it is one of `_PLL_LIBRARY_MUTATORS`. `prefix`
    is what it is read off, as written (`random`), or None."""
    module, name = getattr(function, "__module__", None), getattr(function, "__qualname__", None)
    if not (isinstance(module, str) and isinstance(name, str)):
        return
    found = _PLL_LIBRARY_MUTATORS.get((module.lstrip("_"), name))
    if found is not None:
        _pll_refuse_mutation(
            "function", "list", written, _pll_level_of_caller(3), name=found, prefix=prefix,
            target=arguments[0] if arguments else None, arguments=arguments,
        )


def _pll_setitem(target, key, value, written, target_text, key_text, value_text):
    """`target[key] = value`: refused for a list or a dictionary (a set has
    no items to set, as Python says)."""
    kind = _pll_mutable_kind(target)
    if kind in ("list", "dict"):
        _pll_refuse_mutation("setitem", kind, written, _pll_level_of_caller(), target=target_text, key=key_text,
                             value=value_text)
    target[key] = value


def _pll_setitem_check(target, written, target_text, key_text):
    """An item of `target` set by an assignment to several targets, as in
    `xs[i], xs[j] = xs[j], xs[i]`: refused for a list or a dictionary,
    before the assignment."""
    kind = _pll_mutable_kind(target)
    if kind in ("list", "dict"):
        _pll_refuse_mutation("setitem", kind, written, _pll_level_of_caller(), target=target_text, key=key_text,
                             value=None)


def _pll_iterating_into(iterable, target, written, target_text, key_text):
    """`iterable`, for a loop whose target sets an item of `target` each time
    round (`for xs[i] in ...`): refused for a list or a dictionary."""
    kind = _pll_mutable_kind(target)
    if kind in ("list", "dict"):
        _pll_refuse_mutation("setitem", kind, written, _pll_level_of_caller(), target=target_text, key=key_text,
                             value=None)
    return iterable


def _pll_delitem(target, key, written, target_text, key_text):
    """`del target[key]`: refused for a list or a dictionary."""
    kind = _pll_mutable_kind(target)
    if kind in ("list", "dict"):
        _pll_refuse_mutation("delitem", kind, written, _pll_level_of_caller(), target=target_text, key=key_text)
    del target[key]


def _pll_in_place(symbol, target, value, written, target_text, value_text):
    """`target symbol= value`: refused for a list, a dictionary or a set,
    which it changes in place - `xs += ys` is not `xs = xs + ys` - and for a
    bitwise operator between numbers; anything else is Python's."""
    kind = _pll_mutable_kind(target)
    if kind is not None:
        _pll_refuse_mutation("in_place", kind, written, _pll_level_of_caller(), symbol=symbol, target=target_text,
                             value=value_text)
    if symbol in _PLL_BITWISE and isinstance(target, int) and isinstance(value, int):
        _pll_refuse_bitwise(symbol, written, target_text, value_text, target, value)
    return _PLL_IN_PLACE[symbol](target, value)


def _pll_setitem_in_place(target, key, symbol, value, written, target_text, key_text, value_text):
    """`target[key] symbol= value`: refused for a list or a dictionary, as
    `_pll_setitem` is."""
    kind = _pll_mutable_kind(target)
    if kind in ("list", "dict"):
        _pll_refuse_mutation("setitem", kind, written, _pll_level_of_caller(), target=target_text, key=key_text,
                             value=value_text, symbol=symbol)
    target[key] = _PLL_IN_PLACE[symbol](target[key], value)


for _pll_name, _pll_function in (
    ("attribute", _pll_attribute), ("named", _pll_named), ("setitem", _pll_setitem),
    ("setitem_check", _pll_setitem_check), ("iterating_into", _pll_iterating_into), ("delitem", _pll_delitem),
    ("in_place", _pll_in_place), ("setitem_in_place", _pll_setitem_in_place), ("slice", slice),
):
    _pll_hidden(_pll_name, _pll_function)
