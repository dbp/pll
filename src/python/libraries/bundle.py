# Python Language Levels: bundles.
#
# A bundle is a module a course has written and compiled, which a program
# names with `#bundle <name> <url>` and then uses by that name, with no
# import: functions to call whose code the student does not see, as in a
# lab on working out what unknown code does.
#
#   _pll_bundle_build(source, filename) -> {ok, bundle | error}    (authoring)
#   _pll_bundle_load(session_key, entries_json) -> {ok, error?}    (each run)
#
# The code travels as bytecode compiled by this interpreter, as Examplar's
# implementations do (examplar.py), and is trusted as they are: it comes
# from an https address the course chose, and runs unchecked.

import ast as _bd_ast
import base64 as _bd_b64
import builtins as _bd_builtins
import importlib.util as _bd_util
import json as _bd_json
import marshal as _bd_marshal
import re as _bd_re
import sys as _bd_sys
import types as _bd_types

BUNDLE_FORMAT = 1

_PLL_BUNDLE_LEVEL_RE = _bd_re.compile(r"^#\s*level\s+([a-z]+)\s*$")


def _pll_bundle_level(source):
    """The level `source`'s `#level` line names, or `raw` without one."""
    for line in source.splitlines():
        if line.strip():
            found = _PLL_BUNDLE_LEVEL_RE.match(line.strip())
            if found is not None and found.group(1) in _PLL_STUDENT_LEVELS:
                return found.group(1)
            return _PLL_LEVEL_RAW
    return _PLL_LEVEL_RAW


def _pll_bundle_is_test(node):
    """Whether a top-level statement is the author's testing: a `test_`
    function, or an import of pytest for one."""
    if isinstance(node, (_bd_ast.FunctionDef, _bd_ast.AsyncFunctionDef)):
        return node.name.startswith("test_")
    if isinstance(node, _bd_ast.Import):
        return all(alias.name == "pytest" for alias in node.names)
    if isinstance(node, _bd_ast.ImportFrom):
        return node.module == "pytest"
    return False


def _pll_bundle_defines(tree):
    """The public names a module's top level defines, in order."""
    names = []
    for node in tree.body:
        if isinstance(node, (_bd_ast.FunctionDef, _bd_ast.AsyncFunctionDef, _bd_ast.ClassDef, _bd_ast.TypeAlias)):
            found = [node.name.id if isinstance(node, _bd_ast.TypeAlias) else node.name]
        elif isinstance(node, (_bd_ast.Assign, _bd_ast.AnnAssign)):
            targets = node.targets if isinstance(node, _bd_ast.Assign) else [node.target]
            found = [t.id for t in targets if isinstance(t, _bd_ast.Name)]
        else:
            continue
        names.extend(n for n in found if not n.startswith("_") and n not in names)
    return names


def _pll_bundle_build(source, filename):
    """Compile `source` into a bundle. Returns `{"ok": True, "bundle": ...}`
    or `{"ok": False, "error": ...}`.

    Its top-level `test_` functions are left out, and an `import pytest`:
    they are the author's checks, and in the bundle they would say what its
    functions do. Nothing is run.
    """
    name = filename.replace("\\", "/").rsplit("/", 1)[-1]
    try:
        tree = _bd_ast.parse(source, filename=name)
    except SyntaxError as e:
        return {"ok": False, "error": "%s does not parse: %s (line %s)" % (name, e.msg, e.lineno)}
    if _pll_bundle_lines(source):
        line = min(_pll_bundle_lines(source).values())
        return {
            "ok": False,
            "error": "%s has a `#bundle` line (line %s), and a bundle can't use another bundle" % (name, line),
        }
    tree.body = [node for node in tree.body if not _pll_bundle_is_test(node)]
    try:
        code = compile(tree, "<bundle:%s>" % name, "exec", dont_inherit=True)
    except SyntaxError as e:
        return {"ok": False, "error": "%s does not compile: %s (line %s)" % (name, e.msg, e.lineno)}
    return {
        "ok": True,
        "bundle": {
            "bundle": BUNDLE_FORMAT,
            "built": {
                "python": _bd_sys.version.split()[0],
                "magic": _bd_util.MAGIC_NUMBER.hex(),
            },
            "level": _pll_bundle_level(source),
            "defines": _pll_bundle_defines(tree),
            "pyc": _bd_b64.b64encode(_bd_marshal.dumps(code)).decode("ascii"),
        },
    }


def _pll_bundle_load(session_key, entries_json):
    """Make the modules a run's `#bundle` lines name, for `_pll_run_file` to
    give its program. `entries_json` is `[{"name", "json"}]`, `json` being
    a bundle as `_pll_bundle_build` wrote it.

    Returns `{"ok": True}`, or `{"ok": False, "name", "error"}` for the
    first that could not be made. Each module's top level runs here, before
    the program: a Stop pressed during it gets out.
    """
    modules = {}
    _pll_session_bundles.pop(session_key, None)
    for entry in _bd_json.loads(entries_json):
        name = entry["name"]
        module, error = _pll_bundle_module(name, entry["json"])
        if error is not None:
            return {"ok": False, "name": name, "error": error}
        modules[name] = module
    _pll_session_bundles[session_key] = modules
    return {"ok": True}


def _pll_bundle_module(name, bundle_json):
    """-> (module, None), or (None, what is wrong) for a bundle that
    cannot be made into one."""
    if hasattr(_bd_builtins, name):
        return None, "`%s` is the name of a Python built-in, which the bundle would hide: give it another name" % name
    if name in _pll_initial_globals or name in _pll_level_names(_PLL_LEVEL_BEGINNER):
        return None, "`%s` is already a name in PLL, which the bundle would hide: give it another name" % name
    try:
        bundle = _bd_json.loads(bundle_json)
        blob = bundle["pyc"]
        format_ = bundle["bundle"]
    except (ValueError, KeyError, TypeError):
        return None, "it is not a bundle `pll bundle build` made"
    if format_ != BUNDLE_FORMAT:
        return None, "it was made by another version of PLL: build it again with `pll bundle build`"
    built = bundle.get("built") or {}
    if built.get("magic") != _bd_util.MAGIC_NUMBER.hex():
        return None, (
            "it was built for Python %s, and PLL runs Python %s: build it again with `pll bundle build`"
            % (built.get("python", "?"), _bd_sys.version.split()[0])
        )
    try:
        code = _bd_marshal.loads(_bd_b64.b64decode(blob))
    except (ValueError, EOFError, TypeError):
        return None, "its code could not be read: build it again with `pll bundle build`"
    level = bundle.get("level")
    if level not in _PLL_STUDENT_LEVELS:
        level = _PLL_LEVEL_RAW
    module = _bd_types.ModuleType(name)
    own = module.__dict__
    for key, value in _pll_initial_globals.items():
        if key not in _PLL_MODULE_OWN:
            own.setdefault(key, value)
    own.update(_pll_level_names(level))
    own["__pll_level__"] = level
    try:
        exec(code, own)
    except KeyboardInterrupt:
        raise
    except BaseException as e:
        return None, "its code stopped with %s: %s" % (type(e).__name__, e)
    return module, None
