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

# matplotlib draws with PLL's backend (`matplotlibBackend.py`), served from
# its source under that name, so `plt.show()` puts a figure in the panel.
import importlib.abc as _pll_importlib_abc
import importlib.util as _pll_importlib_util
import os as _pll_install_os


class _PllMatplotlibFinder(_pll_importlib_abc.MetaPathFinder, _pll_importlib_abc.Loader):
    def find_spec(self, name, path=None, target=None):
        if name != "_pll_matplotlib":
            return None
        return _pll_importlib_util.spec_from_loader(name, self)

    def create_module(self, spec):
        return None

    def exec_module(self, module):
        module._pll_show_figure = _pll_show_figure
        exec(compile(_pll_matplotlib_backend_source, _PLL_MATPLOTLIB_FILE, "exec"), module.__dict__)


_sys.meta_path.append(_PllMatplotlibFinder())
_pll_install_os.environ["MPLBACKEND"] = "module://_pll_matplotlib"

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
