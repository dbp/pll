import * as path from "node:path";
import { DesktopPyodideRuntime } from "../desktop/pyodideRuntime";

/**
 * The same Node host the desktop extension uses, pointed at this package's
 * own files: Pyodide comes from the `pyodide` dependency rather than a
 * vendored copy, and the worker is this package's bundle.
 *
 * Note Pyodide's Node loader writes any wheels it downloads back into
 * `indexURL`, so `node_modules/pyodide` doubles as the package cache - the
 * first `import pandas` needs the network, later ones do not.
 */
export function createCliRuntime(): DesktopPyodideRuntime {
  return new DesktopPyodideRuntime({
    // `pyodide` is external in the bundle, so this resolves at run time
    // from the installed package rather than being inlined.
    indexUrlCandidates: [path.dirname(require.resolve("pyodide"))],
    workerPath: path.join(__dirname, "worker.cjs"),
    missingAssetsHint:
      "Could not find Pyodide's assets. Reinstall pll-python so its `pyodide` " +
      "dependency is present.",
  });
}
