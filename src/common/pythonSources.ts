/**
 * The Python that runs inside Pyodide, as strings. The code itself lives in
 * the `.py` files beside this one, which esbuild's `text` loader inlines at
 * build time - so the libraries stay editable as real Python rather than as
 * template literals.
 *
 * Loaded once, in this order, into one interpreter (see `installPll`):
 *   1. PLL_BOOTSTRAP_PY      - the files in `bootstrap/`, in its order:
 *                              running files, prompt lines and tests; the
 *                              static checks; describing errors; the
 *                              packages a program imports; importing the
 *                              student's files at their own levels
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
 *
 * The host calls these entry points, each returning JSON-friendly data:
 *
 *   _pll_run_file(code, filename, session_key, level, run_tests)  running.py
 *   _pll_repl_eval(code, session_key, level)                running.py
 *   _pll_repl_check(source)                                 running.py
 *   _pll_has_tests(code)                                    tests.py
 *   _pll_package_imports(code, siblings_json)               packages.py
 *   _pll_static_analyze(code, level, filename, session_key) staticAnalysis.py
 */

import typeCheckingSource from "./bootstrap/typeChecking.py";
import errorInfoSource from "./bootstrap/errorInfo.py";
import codeFactsSource from "./bootstrap/codeFacts.py";
import sessionsSource from "./bootstrap/sessions.py";
import stopSource from "./bootstrap/stop.py";
import compileSource from "./bootstrap/compile.py";
import libraryHelpersSource from "./bootstrap/libraryHelpers.py";
import packagesSource from "./bootstrap/packages.py";
import runningSource from "./bootstrap/running.py";
import testsSource from "./bootstrap/tests.py";
import staticAnalysisSource from "./bootstrap/staticAnalysis.py";
import importsSource from "./bootstrap/imports.py";
import imageLibSource from "./imageLib.py";
import tableLibSource from "./tableLib.py";
import reactorLibSource from "./reactorLib.py";
import examplarLibSource from "./examplarLib.py";
import installSource from "./install.py";
import httpSource from "./http.py";
import matplotlibBackendSource from "./matplotlibBackend.py";
import { bootstrapFile, PLL_HTTP_FILE, PLL_INSTALL_FILE, PLL_LIBRARY_FILES } from "./pythonFiles";

/** One of PLL's Python files, and the name its frames show (`pythonFiles.ts`). */
export interface PythonSource {
  file: string;
  source: string;
}

/**
 * The bootstrap, one file per concern. They share one set of globals, so a
 * function may call one defined in any of them; the order matters only for
 * what runs as a file loads - `errorInfo` reads the vendor directory from
 * `typeChecking`, and `tests` decorates with `running`'s `_pll_stoppable`.
 */
export const PLL_BOOTSTRAP_PY: ReadonlyArray<PythonSource> = [
  { file: bootstrapFile("typeChecking"), source: typeCheckingSource },
  { file: bootstrapFile("errorInfo"), source: errorInfoSource },
  { file: bootstrapFile("codeFacts"), source: codeFactsSource },
  { file: bootstrapFile("sessions"), source: sessionsSource },
  { file: bootstrapFile("stop"), source: stopSource },
  { file: bootstrapFile("compile"), source: compileSource },
  { file: bootstrapFile("libraryHelpers"), source: libraryHelpersSource },
  { file: bootstrapFile("packages"), source: packagesSource },
  { file: bootstrapFile("running"), source: runningSource },
  { file: bootstrapFile("tests"), source: testsSource },
  { file: bootstrapFile("staticAnalysis"), source: staticAnalysisSource },
  { file: bootstrapFile("imports"), source: importsSource },
];
export const PLL_IMAGE_LIB_PY: PythonSource = { file: PLL_LIBRARY_FILES.image, source: imageLibSource };
export const PLL_TABLE_LIB_PY: PythonSource = { file: PLL_LIBRARY_FILES.table, source: tableLibSource };
export const PLL_REACTOR_LIB_PY: PythonSource = { file: PLL_LIBRARY_FILES.reactor, source: reactorLibSource };
export const PLL_EXAMPLAR_LIB_PY: PythonSource = { file: PLL_LIBRARY_FILES.examplar, source: examplarLibSource };
/** PLL's matplotlib backend, imported by matplotlib as `_pll_matplotlib` (install.py). */
export const PLL_MATPLOTLIB_PY: PythonSource = { file: PLL_LIBRARY_FILES.matplotlib, source: matplotlibBackendSource };

/**
 * Routes `urllib`/`requests` (and therefore pandas URL readers) through the
 * host's network, after the `pyodide-http` package is loaded (`http.py`).
 * Idempotent, and run each time a program imports one of those modules, so
 * `requests` is patched once it is loaded too. In the web worker this uses
 * synchronous XHR; on desktop a Node XMLHttpRequest polyfill does the same
 * job, fetching on a helper thread (`syncHttp.ts`).
 */
export const PYODIDE_HTTP_PATCH_PY: PythonSource = { file: PLL_HTTP_FILE, source: httpSource };

/** The install step, run after the libraries (`install.py`). */
export const PYODIDE_INSTALL_PY: PythonSource = { file: PLL_INSTALL_FILE, source: installSource };
