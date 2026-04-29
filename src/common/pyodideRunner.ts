/**
 * Python source executed inside Pyodide once on init. The actual code lives
 * in `pyodideBootstrap.py`, `bonnieImageLib.py`, and `bonnieTableLib.py`;
 * esbuild's `text` loader inlines them as strings at build time, which keeps
 * the analyzer + image + table libraries editable as real Python (with IDE
 * support, syntax highlighting, etc.) instead of giant template literals.
 *
 * Initialization order (run sequentially in the same Python interpreter):
 *   1. PYODIDE_BOOTSTRAP_PY   - runtime hooks (run/repl/static-analyze)
 *   2. BONNIE_IMAGE_LIB_PY    - Image class + primitives + combinators
 *   3. BONNIE_TABLE_LIB_PY    - Table class + functional ops + chart helpers
 *   4. PYODIDE_INSTALL_PY     - registers `bonnie.image` / `bonnie.table`
 *                                modules and copies public names into
 *                                `_bonnie_initial_globals`
 *
 * Loading the libraries before the install step means the bootstrap doesn't
 * depend on them; it just duck-types `_bonnie_image_data` / `_bonnie_table_data`
 * during display.
 */
import bootstrapSource from "./pyodideBootstrap.py";
import imageLibSource from "./bonnieImageLib.py";
import tableLibSource from "./bonnieTableLib.py";

export const PYODIDE_BOOTSTRAP_PY = bootstrapSource;
export const BONNIE_IMAGE_LIB_PY = imageLibSource;
export const BONNIE_TABLE_LIB_PY = tableLibSource;

/**
 * Final installation step: register `bonnie.image` and `bonnie.table` as
 * importable modules and inject their public names into the per-session
 * globals template (`_bonnie_initial_globals`) so beginners can use
 * `circle(...)` / `table(...)` with no import in every file's session.
 */
export const PYODIDE_INSTALL_PY = `
import sys as _sys, types as _types

_bonnie_module = _types.ModuleType("bonnie")
_bonnie_image_module = _types.ModuleType("bonnie.image")
_bonnie_table_module = _types.ModuleType("bonnie.table")
for _name in BONNIE_IMAGE_EXPORTS:
    setattr(_bonnie_image_module, _name, globals()[_name])
for _name in BONNIE_TABLE_EXPORTS:
    setattr(_bonnie_table_module, _name, globals()[_name])
_bonnie_module.image = _bonnie_image_module
_bonnie_module.table = _bonnie_table_module
_sys.modules["bonnie"] = _bonnie_module
_sys.modules["bonnie.image"] = _bonnie_image_module
_sys.modules["bonnie.table"] = _bonnie_table_module

# Add image + table library names to the per-session globals template.
# Each new session is initialized as a copy of this template, so every
# file's Run File / REPL prompt sees these names without explicit imports.
for _name in BONNIE_IMAGE_EXPORTS:
    _bonnie_initial_globals[_name] = globals()[_name]
for _name in BONNIE_TABLE_EXPORTS:
    _bonnie_initial_globals[_name] = globals()[_name]
del _name
`;

export interface BonnieRunResult {
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
  displays: BonnieDisplayData[];
}

export type BonnieDisplayData =
  | BonnieStdoutDisplay
  | BonnieStderrDisplay
  | BonnieImageDisplay
  | BonnieTableDisplay;

export interface BonnieStdoutDisplay {
  type: "stdout";
  text: string;
}

export interface BonnieStderrDisplay {
  type: "stderr";
  text: string;
}

export interface BonnieImageDisplay {
  type: "image";
  /** Sub-format: today only "svg". */
  format?: string;
  width: number;
  height: number;
  /** The SVG document, ready to drop into HTML. */
  data: string;
}

export interface BonnieTableDisplay {
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
 * The Python `_bonnie_static_analyze` returns a list of dicts of this shape.
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
  /** For "disallowed-keyword": which keyword was used. */
  keyword?: "global" | "nonlocal";
  /** For "disallowed-keyword": names declared in the statement. */
  names?: string[];
}
