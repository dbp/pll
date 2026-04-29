/**
 * Python source executed inside Pyodide once on init. The actual code lives
 * in `pyodideBootstrap.py` and `bonnieImageLib.py`; esbuild's `text` loader
 * inlines them as strings at build time, which keeps the analyzer + image
 * library editable as real Python (with IDE support, syntax highlighting,
 * etc.) instead of giant template literals.
 *
 * Initialization order (run sequentially in the same Python interpreter):
 *   1. PYODIDE_BOOTSTRAP_PY   - runtime hooks (run/repl/static-analyze)
 *   2. BONNIE_IMAGE_LIB_PY    - Image class + primitives + combinators
 *   3. PYODIDE_INSTALL_PY     - registers `bonnie.image` module and copies
 *                                public names into `_bonnie_initial_globals`
 *
 * Loading the image library second means the bootstrap doesn't depend on
 * it; it just duck-types the `_bonnie_image_data` method during display.
 */
import bootstrapSource from "./pyodideBootstrap.py";
import imageLibSource from "./bonnieImageLib.py";

export const PYODIDE_BOOTSTRAP_PY = bootstrapSource;
export const BONNIE_IMAGE_LIB_PY = imageLibSource;

/**
 * Final installation step: register `bonnie.image` as an importable module
 * and inject the public names into the per-session globals template
 * (`_bonnie_initial_globals`) so beginners can use `circle(50, "solid", "red")`
 * with no import in every file's session.
 */
export const PYODIDE_INSTALL_PY = `
import sys as _sys, types as _types

_bonnie_module = _types.ModuleType("bonnie")
_bonnie_image_module = _types.ModuleType("bonnie.image")
for _name in BONNIE_IMAGE_EXPORTS:
    setattr(_bonnie_image_module, _name, globals()[_name])
_bonnie_module.image = _bonnie_image_module
_sys.modules["bonnie"] = _bonnie_module
_sys.modules["bonnie.image"] = _bonnie_image_module

# Add image library names to the per-session globals template. Each new
# session is initialized as a copy of this template, so every file's
# Run File / REPL prompt sees these names without an explicit import.
for _name in BONNIE_IMAGE_EXPORTS:
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
  /** Images emitted by top-level expressions and the last REPL expression. */
  images: BonnieImageData[];
}

export interface BonnieImageData {
  type: "svg";
  width: number;
  height: number;
  data: string;
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
