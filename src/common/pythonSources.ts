/**
 * The Python that runs inside Pyodide, as strings. The code itself lives in
 * the `.py` files beside this one, which esbuild's `text` loader inlines at
 * build time - so the libraries stay editable as real Python rather than as
 * template literals.
 *
 * Loaded once, in this order, into one interpreter (see `workerHost.ts`):
 *   1. PYODIDE_BOOTSTRAP_PY  - running files, prompt lines and tests; the
 *                              static checks; describing errors
 *   2. PLL_IMAGE_LIB_PY      - images
 *   3. PLL_TABLE_LIB_PY      - tables and charts
 *   4. PLL_REACTOR_LIB_PY    - reactors, after images: handlers draw with them
 *   5. PLL_EXAMPLAR_LIB_PY   - running a student's tests against a bundle
 *   6. PYODIDE_INSTALL_PY    - registers `pll.image` / `pll.table` /
 *                              `pll.reactor` and copies their public names
 *                              into `_pll_initial_globals`
 *
 * The bootstrap loads first and depends on none of the libraries: it
 * duck-types `_pll_image_data` / `_pll_table_data` when it displays a value,
 * and looks up the few library functions it calls when it calls them.
 */

import bootstrapSource from "./pyodideBootstrap.py";
import imageLibSource from "./imageLib.py";
import tableLibSource from "./tableLib.py";
import reactorLibSource from "./reactorLib.py";
import examplarLibSource from "./examplarLib.py";

export const PYODIDE_BOOTSTRAP_PY = bootstrapSource;
export const PLL_IMAGE_LIB_PY = imageLibSource;
export const PLL_TABLE_LIB_PY = tableLibSource;
export const PLL_REACTOR_LIB_PY = reactorLibSource;
export const PLL_EXAMPLAR_LIB_PY = examplarLibSource;

/**
 * Routes `urllib`/`requests` (and therefore pandas URL readers) through the
 * host's network. Idempotent, but PLL still guards it to run once per
 * interpreter. In the web worker this uses synchronous XHR; on desktop a
 * Node XMLHttpRequest polyfill does the same job via a child-process fetch.
 */
export const PYODIDE_HTTP_PATCH_PY = "import pyodide_http as _pll_ph; _pll_ph.patch_all()";

/**
 * Final installation step: register `pll.image` and `pll.table` as
 * importable modules and inject their public names into the per-session
 * globals template (`_pll_initial_globals`) so beginners can use
 * `circle(...)` / `table(...)` with no import in every file's session.
 */
export const PYODIDE_INSTALL_PY = `
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
`;
