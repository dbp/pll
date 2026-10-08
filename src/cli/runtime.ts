import * as fs from "node:fs";
import * as path from "node:path";
import { DesktopPyodideRuntime } from "../desktop/pyodideRuntime";
import { cacheRoot } from "./bundleStore";

/**
 * The same Node host the desktop extension uses, pointed at this package's
 * own files: Pyodide comes from the `pyodide` dependency rather than a
 * vendored copy, and the worker is this package's bundle.
 *
 * Pyodide's Node loader keeps the wheels it downloads beside its assets,
 * so `node_modules/pyodide` doubles as the package cache - the first
 * `import pandas` needs the network, later ones do not. An install that
 * cannot be written to (`sudo npm i -g`, a Docker image) keeps them in the
 * user's cache instead.
 */
export function createCliRuntime(): DesktopPyodideRuntime {
  return new DesktopPyodideRuntime({
    indexUrlCandidates: pyodideDirectory(),
    workerPath: path.join(__dirname, "worker.cjs"),
    missingAssetsHint:
      "Could not find Pyodide's assets. Reinstall pll-python so its `pyodide` " +
      "dependency is present.",
    // Ample for a first start on a slow machine; an autograder waits no
    // longer than that for a Pyodide that will never start.
    startTimeoutMs: 120_000,
    packageCacheDir: (indexUrl) => (writable(indexUrl) ? undefined : userPackageCache(indexUrl)),
  });
}

function writable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** One folder per Pyodide version: a wheel is built for one. */
function userPackageCache(indexUrl: string): string {
  let version = "unknown";
  try {
    const manifest = fs.readFileSync(path.join(indexUrl, "package.json"), "utf8");
    version = (JSON.parse(manifest) as { version: string }).version;
  } catch {
    /* a folder of its own, all the same */
  }
  return path.join(cacheRoot(), `pyodide-${version}`);
}

/**
 * Where the `pyodide` package is - external in the bundle, so resolved at
 * run time from the installed package - or nowhere, which starting Python
 * then says.
 */
function pyodideDirectory(): string[] {
  try {
    return [path.dirname(require.resolve("pyodide"))];
  } catch {
    return [];
  }
}
