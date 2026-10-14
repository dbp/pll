import { loadPyodide } from "pyodide";
import { resolve } from "node:path";
import { importSource, ROOT } from "./bundle.mjs";

export const INDEX_URL = resolve(ROOT, "node_modules", "pyodide");

/**
 * A Pyodide with PLL in it, put there by `installPll` - the function the
 * worker starts with - so a test drives the interpreter a student's program
 * runs in, not one assembled by hand. `http` is its network, if any, and
 * `interruptBuffer` where a Stop is sent to it.
 */
export async function bootPll({ http = null, interruptBuffer = null } = {}) {
  const { installPll } = await importSource('export { installPll } from "./src/pyodide/install";');
  const pyodide = await loadPyodide({ indexURL: INDEX_URL });
  if (interruptBuffer) {
    pyodide.setInterruptBuffer(new Uint8Array(interruptBuffer));
  }
  installPll(pyodide, { http, interruptBuffer });
  return pyodide;
}
