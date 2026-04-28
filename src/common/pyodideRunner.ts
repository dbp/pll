/**
 * Python source executed inside Pyodide once on init. The actual code lives
 * in `pyodideBootstrap.py`; esbuild's `text` loader inlines it as a string at
 * build time, which keeps the analyzer code editable as real Python (with IDE
 * support, syntax highlighting, etc.) instead of a giant template literal.
 *
 * The bootstrap exposes:
 *   _bonnie_run_file(code: str, filename: str)               -> dict
 *   _bonnie_repl_eval(code: str)                             -> dict
 *   _bonnie_repl_check(source: str)                          -> dict
 *   _bonnie_static_analyze(code: str, level: str, fn: str)   -> list[dict]
 */
import bootstrapSource from "./pyodideBootstrap.py";

export const PYODIDE_BOOTSTRAP_PY = bootstrapSource;

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
}
