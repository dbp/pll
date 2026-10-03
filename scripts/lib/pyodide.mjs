import { loadPyodide } from "pyodide";
import { resolve } from "node:path";
import { importSource, ROOT } from "./bundle.mjs";

export const INDEX_URL = resolve(ROOT, "node_modules", "pyodide");

/**
 * A Pyodide with PLL in it, put there by `installPll` - the function the
 * worker starts with - so a test drives the interpreter a student's program
 * runs in, not one assembled by hand.
 */
export async function bootPll() {
  const { installPll } = await importSource('export { installPll } from "./src/common/pythonInstall";');
  const pyodide = await loadPyodide({ indexURL: INDEX_URL });
  installPll(pyodide);
  return pyodide;
}
