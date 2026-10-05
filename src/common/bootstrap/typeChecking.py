# Type checking: which checks a run makes, decided by its language level, and
# typeguard - vendored, not installed - set up to make them.

import sys as _sys

# The language levels, as the host sends them: `LEVEL_NAMES` in level.ts
# names the same four.
_PLL_LEVEL_RAW = "raw"
_PLL_LEVEL_BEGINNER = "beginner"
_PLL_LEVEL_INTERMEDIATE = "intermediate"
_PLL_LEVEL_ADVANCED = "advanced"

#: The two that teach: static checks, and no bool where a number is annotated.
_PLL_TEACHING_LEVELS = (_PLL_LEVEL_BEGINNER, _PLL_LEVEL_INTERMEDIATE)

# Vendored pure-Python wheels (typeguard + typing_extensions) that the
# worker writes into MEMFS before calling `_pll_enable_type_checking`.
# Must match PLL_VENDOR_DIR in pythonVendor.ts.
_PLL_VENDOR_DIR = "/pll_vendor"

# Set by `_pll_enable_type_checking`. While False, `_pll_instrument_types`
# leaves code untouched, so a program still runs - just unchecked.
_PLL_TYPEGUARD_READY = False
_pll_typeguard_transformer = None
_pll_type_check_error = None

# Whether a bool is rejected where int / float is annotated. Set per run
# from the language level; see `levelRejectsBoolAsNumber` in level.ts.
# Python counts True as 1 and both mypy and typeguard follow it, which is a
# hole at the teaching levels: a student who annotates `int` and passes
# `True` has almost always made a mistake. `advanced` keeps Python's rule.
_PLL_STRICT_NUMBERS = False

# Whether annotations are instrumented at all. Set per run from the language
# level, and decided only here: False only at `#level raw`, which exists so a
# file can opt out. There is no separate setting: the level is the single
# input, so nothing can disagree with it.
_PLL_TYPE_CHECK = False


def _pll_check_strict_int(value, origin_type, args, memo):
    """Replaces typeguard's `int` check; bools are not whole numbers here.

    The wording matches typeguard's own so the host-side explainer needs
    no special case: it sees the actual type (bool) and the expected one.
    """
    if isinstance(value, bool) or not isinstance(value, int):
        raise _pll_type_check_error("is not an instance of int")


def _pll_check_strict_float(value, origin_type, args, memo):
    """As `_pll_check_strict_int`, for the int-or-float numeric tower."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _pll_type_check_error("is neither float or int")


def _pll_strict_number_lookup(origin_type, args, extras):
    """typeguard checker lookup; consulted on every check, so the flag
    can be flipped per run without re-registering."""
    if not _PLL_STRICT_NUMBERS:
        return None
    if origin_type is int:
        return _pll_check_strict_int
    if origin_type is float:
        return _pll_check_strict_float
    return None


def _pll_apply_level(level):
    """Set the per-run strictness implied by the language level.

    The level is the only input. `raw` checks nothing; `advanced` checks
    annotations by Python's own rules; the two teaching levels additionally
    reject a bool where a number is annotated. Must agree with level.ts.
    """
    global _PLL_STRICT_NUMBERS, _PLL_TYPE_CHECK
    _PLL_TYPE_CHECK = level != _PLL_LEVEL_RAW
    _PLL_STRICT_NUMBERS = level in _PLL_TEACHING_LEVELS


def _pll_enable_type_checking():
    """Put the vendored wheels on sys.path and import typeguard.

    Returns True when runtime type checking is available. A failure here
    is deliberately not fatal: students' code must still run, so the
    feature degrades to "no type checks" rather than breaking the editor.
    """
    global _PLL_TYPEGUARD_READY, _pll_typeguard_transformer, _pll_type_check_error
    if _PLL_TYPEGUARD_READY:
        return True
    try:
        for name in ("typing_extensions.whl", "typeguard.whl"):
            path = _PLL_VENDOR_DIR + "/" + name
            # Appended, not prepended: a real package in site-packages
            # (Pyodide ships typing_extensions too) should still win.
            if path not in _sys.path:
                _sys.path.append(path)
        from typeguard import TypeCheckError, TypeCheckMemo
        from typeguard._checkers import checker_lookup_functions
        from typeguard._config import CollectionCheckStrategy, global_config
        from typeguard._functions import check_variable_assignment
        from typeguard._transformer import TypeguardTransformer

        # `list[int]` should mean *every* item is an int. typeguard only
        # checks the first item by default, which silently accepts
        # [1, 2, "three"] - confusing when the annotation says otherwise.
        global_config.collection_check_strategy = CollectionCheckStrategy.ALL_ITEMS

        # Referenced by name in the AST that `_PllTopLevelAnnAssign`
        # injects, so they have to be visible in user globals.
        _pll_initial_globals["_pll_tg_memo"] = TypeCheckMemo
        _pll_initial_globals["_pll_tg_check_assign"] = check_variable_assignment
        # Referenced by name in the AST that `_PllDataclassChecks` injects.
        _pll_initial_globals["_pll_check_dataclass_fields"] = _pll_check_dataclass_fields
        # Consulted before typeguard's builtin lookup, and gated on
        # `_PLL_STRICT_NUMBERS` so it is a no-op at `advanced`.
        _pll_type_check_error = TypeCheckError
        if _pll_strict_number_lookup not in checker_lookup_functions:
            checker_lookup_functions.insert(0, _pll_strict_number_lookup)

        _pll_typeguard_transformer = TypeguardTransformer
        _PLL_TYPEGUARD_READY = True
    except BaseException:
        _PLL_TYPEGUARD_READY = False
    return _PLL_TYPEGUARD_READY
