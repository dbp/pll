# Type checking: which checks a run makes, decided by its language level, and
# the names the instrumentation calls. The checks themselves are contracts
# (contracts.py).

import builtins as _pll_builtins
import collections.abc as _pll_level_abc
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
    """The names a file at `level` starts with beyond `_pll_initial_globals`:
    at the student levels, `Callable`, the type of a function, which an
    annotation needs often enough that it should need no import. `#level
    raw` is Python, which has no such name."""
    return {"Callable": _pll_level_abc.Callable} if level in _PLL_STUDENT_LEVELS else {}


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
