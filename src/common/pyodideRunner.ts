/**
 * Python source executed inside Pyodide once on init. The actual code lives
 * in `pyodideBootstrap.py`, `imageLib.py`, and `tableLib.py`;
 * esbuild's `text` loader inlines them as strings at build time, which keeps
 * the analyzer + image + table libraries editable as real Python (with IDE
 * support, syntax highlighting, etc.) instead of giant template literals.
 *
 * Initialization order (run sequentially in the same Python interpreter):
 *   1. PYODIDE_BOOTSTRAP_PY   - runtime hooks (run/repl/static-analyze)
 *   2. PLL_IMAGE_LIB_PY    - Image class + primitives + combinators
 *   3. PLL_TABLE_LIB_PY    - Table class + functional ops + chart helpers
 *   4. PYODIDE_INSTALL_PY     - registers `pll.image` / `pll.table` /
 *                                `pll.reactor`
 *                                modules and copies public names into
 *                                `_pll_initial_globals`
 *
 * Loading the libraries before the install step means the bootstrap doesn't
 * depend on them; it just duck-types `_pll_image_data` / `_pll_table_data`
 * during display.
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
 * Imports whose use implies network access. Pyodide does not wire Python's
 * `urllib` to the host network, so `pd.read_csv(url)` / `requests` / `urllib`
 * fail with "unknown url type: https" until the `pyodide-http` shim is applied.
 * When code imports one of these, PLL loads `pyodide-http` and patches it in
 * (see PYODIDE_HTTP_PATCH_PY). `pandas` is included because its readers take
 * URLs. Programs that import nothing networked never load the shim.
 */
/**
 * Whether code imports anything at all. Gates `loadPackagesFromImports`, so
 * a plain expression never pays a worker round-trip. Shared because the two
 * hosts must agree: if one detects an import and the other doesn't, the same
 * file works in the editor and fails at the command line.
 */
export const ANY_IMPORT_RE = /(^|\n)[ \t]*(import|from)[ \t]+\S/;

/**
 * `t.to_pandas()` needs pandas loaded, but nothing in the file imports it -
 * the import lives inside the method, where `loadPackagesFromImports` cannot
 * see it. So the *call* is the signal, and a file that never makes it never
 * pays for pandas.
 */
export const PANDAS_METHOD_RE = /\.\s*to_pandas\s*\(/;

/**
 * Whether anything in the file needs a package loaded before it runs:
 * either an import, or one of the calls whose import is hidden inside a
 * library method.
 */
export const NEEDS_PACKAGES_RE_LIST = [PANDAS_METHOD_RE];

export function needsPackages(code: string): boolean {
  return ANY_IMPORT_RE.test(code) || NEEDS_PACKAGES_RE_LIST.some((re) => re.test(code));
}

export const NETWORK_IMPORT_RE =
  /(^|\n)[ \t]*(?:import|from)[ \t]+(?:pandas|requests|urllib|urllib3|httpx|aiohttp|http)\b/;

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

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  result_repr: string | null;
  error_type: string | null;
  error_message: string | null;
  traceback: string | null;
  line_number: number | null;
  column: number | null;
  /** Typed displays produced by top-level expressions (images and tables). */
  displays: DisplayData[];
}

export type DisplayData =
  | StdoutDisplay
  | StderrDisplay
  | ImageDisplay
  | TableDisplay
  | ReactorDisplay;

export interface StdoutDisplay {
  type: "stdout";
  text: string;
}

export interface StderrDisplay {
  type: "stderr";
  text: string;
}

export interface ImageDisplay {
  type: "image";
  /** Sub-format: today only "svg". */
  format?: string;
  width: number;
  height: number;
  /** The SVG document, ready to drop into HTML. */
  data: string;
}

export interface TableDisplay {
  type: "table";
  columns: string[];
  /** Pre-formatted display strings, parallel to `columns`. */
  rows: string[][];
  /** Total number of rows in the source table. */
  row_count: number;
  /** How many of the rows above are actually present (truncation cap). */
  shown_count: number;
  /** True iff the host should show a "row N of M" indicator. */
  truncated: boolean;
}

/**
 * A reactor asking to be shown. Unlike the other displays this one is not a
 * snapshot: the host keeps driving it by id, sending events and receiving
 * new frames, until it is stopped or its session is reset.
 */
export interface ReactorDisplay {
  type: "reactor";
  id: string;
  title: string;
  /** Seconds between ticks. */
  tick_rate: number;
  /** Whether it has an `on_tick`, i.e. whether there is anything to play. */
  ticking: boolean;
  wants_keys: boolean;
  wants_mouse: boolean;
  /** `ws://` URL for the universe client, or null. */
  register: string | null;
  frame: ReactorFrame;
  index: number;
  length: number;
  at_end: boolean;
  stopped: boolean;
  value_repr: string;
}

export interface ReactorFrame {
  data: string;
  width: number;
  height: number;
}

/** Reply from `_pll_reactor_step` / `_pll_reactor_seek`. */
export interface ReactorStepResult {
  ok: boolean;
  /** The reactor is no longer registered (its session was reset). */
  gone?: boolean;
  id?: string;
  frame?: ReactorFrame;
  index?: number;
  length?: number;
  at_end?: boolean;
  stopped?: boolean;
  value_repr?: string;
  /** JSON-encoded messages the handlers asked to send to the server. */
  messages?: string[];
  error_type?: string;
  error_message?: string;
  traceback?: string;
}

/**
 * An Examplar bundle: one URL's worth of known-good ("wheat") and
 * known-bad ("chaff") implementations, as `.pyc` bytecode.
 */
export interface ExamplarBundle {
  /** Format version; `1` today. */
  examplar: number;
  /** What built it, so a stale bundle can say so instead of failing oddly. */
  built: { python: string; magic: string };
  /** Public names every implementation defines. */
  provides: string[];
  wheats: ExamplarImplementation[];
  chaffs: ExamplarImplementation[];
}

export interface ExamplarImplementation {
  id: string;
  /** base64 of the marshalled code object. */
  pyc: string;
}

export interface ExamplarBuildResult {
  ok: boolean;
  bundle?: ExamplarBundle;
  error?: string;
}

export interface ExamplarTestOutcome {
  outcome: "pass" | "fail" | "error";
  /**
   * pytest's rewritten assertion text, when it failed. For `--verify` only -
   * it states the correct answer, so it never reaches a student's card.
   */
  message: string | null;
}

export interface ExamplarImplResult {
  id: string;
  /** For a chaff: the provided function it breaks. Unset on wheats. */
  targets?: string;
  /**
   * False when the *implementation* would not load. The student's own file
   * cannot fail this way: its definitions are loaded one at a time, and one
   * that raises is skipped.
   */
  loaded: boolean;
  tests: Record<string, ExamplarTestOutcome>;
  /**
   * Provided names the student's own file defines, recorded before the
   * implementation was overlaid. Empty early on, when they have written
   * tests and no code yet.
   */
  student_defines: string[];
  error_type?: string;
  error_message?: string;
  traceback?: string;
}

export interface ExamplarRunResult {
  ok: boolean;
  error?: string;
  provides?: string[];
  /** test name -> the provided names it exercises. */
  attribution?: Record<string, string[]>;
  wheats?: ExamplarImplResult[];
  chaffs?: ExamplarImplResult[];
  /**
   * Functions whose chaffs were not run - either their tests did not all
   * pass, or there are no tests for them yet. Coverage is only measured
   * where the suite has been shown to be correct.
   */
  chaffs_skipped?: string[];
}

export interface TestCaseData {
  name: string;
  outcome: string;
  line_number: number | null;
  message: string | null;
  stdout: string | null;
}

export interface TestRunResult {
  ok: boolean;
  internal_error: boolean;
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  tests: TestCaseData[];
  stdout: string;
  stderr: string;
  displays: DisplayData[];
  error_type: string | null;
  error_message: string | null;
  traceback: string | null;
  line_number: number | null;
  column: number | null;
}

/**
 * The Python `_pll_static_analyze` returns a list of dicts of this shape.
 * The TS side maps each one through a level-aware explainer to produce the
 * user-facing AnalysisFinding.
 */
export interface RawStaticFinding {
  id: string; // "shadowing" | "shadowing-builtin" | "reassignment" | ...
  error_type: string;
  message: string;
  line_number: number | null;
  column: number | null;
  name_token: string | null;
  scope_kind: string | null;
  /** For "reassignment": location of the *first* assignment of the name. */
  first_line_number?: number | null;
  first_column?: number | null;
  /** For "shadowing": location and kind of the nearest enclosing binding. */
  outer_line_number?: number | null;
  outer_column?: number | null;
  outer_scope_kind?: string | null;
  /** For "shadowing-library": which library owns the name ("image" | "table" | "reactor" | "library"). */
  library?: string | null;
  /** For "disallowed-keyword": which keyword was used. */
  keyword?: "global" | "nonlocal";
  /** For "disallowed-keyword": names declared in the statement. */
  names?: string[];
}
