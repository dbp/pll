# The install step, run after the libraries: register `pll.image`,
# `pll.table` and `pll.reactor` as importable modules, and copy their public
# names into the per-session globals template (`_pll_initial_globals`), so
# every file's runs and prompt lines can use `circle(...)` / `table(...)`
# with no import.

import sys as _sys, types as _types

_pll_module = _types.ModuleType("pll")
_pll_image_module = _types.ModuleType("pll.image")
_pll_table_module = _types.ModuleType("pll.table")
_pll_reactor_module = _types.ModuleType("pll.reactor")
for _name in PLL_IMAGE_EXPORTS:
    setattr(_pll_image_module, _name, globals()[_name])
for _name in PLL_TABLE_EXPORTS:
    setattr(_pll_table_module, _name, globals()[_name])
for _name in PLL_REACTOR_EXPORTS:
    setattr(_pll_reactor_module, _name, globals()[_name])
_pll_module.image = _pll_image_module
_pll_module.table = _pll_table_module
_pll_module.reactor = _pll_reactor_module
_sys.modules["pll"] = _pll_module
_sys.modules["pll.image"] = _pll_image_module
_sys.modules["pll.table"] = _pll_table_module
_sys.modules["pll.reactor"] = _pll_reactor_module

# Add image + table library names to the per-session globals template.
# Each new session is initialized as a copy of this template, so every
# file's Run File / REPL prompt sees these names without explicit imports.
for _name in PLL_IMAGE_EXPORTS:
    _pll_initial_globals[_name] = globals()[_name]
for _name in PLL_TABLE_EXPORTS:
    _pll_initial_globals[_name] = globals()[_name]
for _name in PLL_REACTOR_EXPORTS:
    _pll_initial_globals[_name] = globals()[_name]
del _name
