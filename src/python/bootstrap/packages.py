# The packages a program needs, found before it runs, and what to say when
# an import still fails.
#
# Pyodide has to download a package before Python can import it, and a
# download cannot happen in the middle of a run, so the host loads them
# first (`ensurePackages` in run/python.ts), from what `_pll_package_imports`
# finds here: every import, wherever it is in the program or in the
# student's files beside it, and the modules named to `importlib` or
# `__import__` in so many words.

import ast as _pll_pkg_ast
import json as _pll_pkg_json
import sys as _pll_pkg_sys

#: The modules that read URLs: when one is imported, PLL routes urllib and
#: requests through the host's network (`http.py`). pandas, because its
#: readers take URLs.
_PLL_NETWORK_MODULES = frozenset(
    ("pandas", "requests", "urllib", "urllib3", "httpx", "aiohttp", "http")
)

#: Never loaded for a program: CPython's own tests, which Pyodide ships as
#: a package called `test` - and which would hide a student's `test.py`.
_PLL_NEVER_LOADED = frozenset(("test",))


def _pll_own_modules(siblings):
    """The student's `.py` files by the top-level module they make: `helper`
    for `helper.py`, `shapes` for every file under `shapes/`."""
    own = {}
    for sibling in siblings:
        if sibling["name"].endswith(".py"):
            own.setdefault(sibling["name"][:-3].split("/")[0], []).append(sibling["text"])
    return own


def _pll_imported_names(code):
    """The top-level modules `code` imports, by any statement or a literal
    name - and pandas for a table's `to_pandas()`, whose import is inside it."""
    try:
        # Quietly: the run parses the file too, and says its warnings once.
        with _pll_without_syntax_warnings():
            tree = _pll_pkg_ast.parse(code)
    except (SyntaxError, ValueError):
        return set()
    names = set()
    for node in _pll_pkg_ast.walk(tree):
        if isinstance(node, _pll_pkg_ast.Import):
            names.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, _pll_pkg_ast.ImportFrom):
            if node.level == 0 and node.module:
                names.add(node.module.split(".")[0])
        elif isinstance(node, _pll_pkg_ast.Call):
            func = node.func
            called = func.id if isinstance(func, _pll_pkg_ast.Name) else (
                func.attr if isinstance(func, _pll_pkg_ast.Attribute) else None
            )
            if isinstance(func, _pll_pkg_ast.Attribute) and func.attr == "to_pandas":
                names.add("pandas")
            first = node.args[0] if node.args else None
            if (
                called in ("import_module", "__import__")
                and isinstance(first, _pll_pkg_ast.Constant)
                and isinstance(first.value, str)
                and first.value
            ):
                names.add(first.value.split(".")[0])
    return names


def _pll_package_imports(code, siblings_json):
    """What to load before `code` runs, as `{"modules": [...], "network": bool}`.

    `siblings_json` is the student's other `.py` files, `[{name, text}]`.
    The imports of those the program imports count too, and theirs in turn
    - but not of a file it never imports, another program in the folder.
    Their own names are not packages.
    """
    own = _pll_own_modules(_pll_pkg_json.loads(siblings_json))
    names = set()
    pending = [code]
    visited = set()
    while pending:
        found = _pll_imported_names(pending.pop())
        names |= found
        for module in found:
            if module in own and module not in visited:
                visited.add(module)
                pending.extend(own[module])
    names -= set(own)
    names -= _PLL_NEVER_LOADED
    return {
        "modules": sorted(names),
        "network": bool(names & _PLL_NETWORK_MODULES),
    }


_pll_import_packages = None


def _pll_pyodide_package(module):
    """The Pyodide package that provides `module`, or None."""
    global _pll_import_packages
    if _pll_import_packages is None:
        try:
            import pyodide_js

            packages = pyodide_js.lockfile.packages.to_py()
        except Exception:
            packages = {}
        _pll_import_packages = {}
        for package, info in packages.items():
            for name in info.get("imports", []):
                _pll_import_packages[name] = package
    return _pll_import_packages.get(module)


def _pll_package_loaded(package):
    try:
        import pyodide_js

        return package in pyodide_js.loadedPackages.to_py()
    except Exception:
        return False


def _pll_enrich_module_not_found(exc):
    """Say why a top-level import found nothing (`module`).

    - `leftOut`: it is one of the student's files, and a limit kept it back
      (`why`);
    - `notLoaded`: Pyodide has it, and it was not loaded before the run -
      which takes the internet the first time, and an import PLL can read;
    - `missing`: Pyodide has no such package.
    """
    if type(exc) is not ModuleNotFoundError or not isinstance(getattr(exc, "name", None), str):
        return
    module = exc.name.split(".")[0]
    if module != exc.name or module in _pll_pkg_sys.stdlib_module_names:
        # A part of a package that is there, or Python's own: Python's
        # message is the whole story.
        return
    why = _pll_left_out.get(module + ".py")
    package = _pll_pyodide_package(module) if module not in _PLL_NEVER_LOADED else None
    if why is not None:
        facts = {"kind": "leftOut", "why": why}
    elif package is None:
        facts = {"kind": "missing"}
    elif not _pll_package_loaded(package):
        facts = {"kind": "notLoaded", "package": package}
    else:
        return
    _pll_add_facts(exc, module=dict(facts, name=module))
