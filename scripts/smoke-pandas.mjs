#!/usr/bin/env node
/**
 * Smoke test for third-party package auto-loading.
 *
 * Boots Pyodide the way the runtime does, then exercises the same load path
 * PLL uses for user code: `loadPackagesFromImports` (which pulls pandas +
 * numpy from the CDN fallback), followed by the `pyodide-http` shim that the
 * runtime applies when code imports a networked module.
 *
 * Verifies that pandas loads and runs. It does NOT verify URL reads: those
 * need the host's fetch (synchronous XHR in the web worker), which the Node
 * host used here does not provide.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { loadPyodide } from "pyodide";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

// Keep in sync with NETWORK_IMPORT_RE in src/common/pyodideRunner.ts.
const NETWORK_IMPORT_RE =
  /(^|\n)[ \t]*(?:import|from)[ \t]+(?:pandas|requests|urllib|urllib3|httpx|aiohttp|http)\b/;

let ok = true;
function expect(cond, msg) {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    ok = false;
  }
}

async function main() {
  const indexURL = resolve(ROOT, "node_modules", "pyodide");
  const pyodide = await loadPyodide({ indexURL });
  pyodide.runPython(readFileSync(resolve(ROOT, "src/common/pyodideBootstrap.py"), "utf8"));

  const userCode = [
    "import pandas as pd",
    "import io",
    "df = pd.read_csv(io.StringIO('name,mpg\\nvw,29\\nhonda,33\\nford,18'))",
    "(len(df), df[df['mpg'] >= 30]['name'].tolist())",
  ].join("\n");

  console.log("\n[1] loadPackagesFromImports pulls pandas");
  await pyodide.loadPackagesFromImports(userCode);
  const version = pyodide.runPython("import pandas; pandas.__version__");
  console.log(`    pandas ${version}`);
  expect(typeof version === "string" && version.length > 0, "pandas should be importable");

  console.log("\n[2] the code the tool needs actually runs");
  const res = pyodide.runPython(userCode).toJs();
  console.log(`    rows=${res[0]} efficient=${JSON.stringify(res[1])}`);
  expect(res[0] === 3, "expected 3 rows, got " + res[0]);
  expect(
    Array.isArray(res[1]) && res[1].join(",") === "honda",
    "expected only 'honda' at >=30 mpg, got " + JSON.stringify(res[1]),
  );

  console.log("\n[3] network imports trigger the pyodide-http shim");
  expect(NETWORK_IMPORT_RE.test(userCode), "pandas import should match NETWORK_IMPORT_RE");
  expect(!NETWORK_IMPORT_RE.test("import math\nprint(math.pi)"), "plain math import should not match");
  await pyodide.loadPackage("pyodide-http");
  pyodide.runPython("import pyodide_http as _ph; _ph.patch_all()");
  console.log("    pyodide-http loaded and patched (no error)");

  console.log(`\nsmoke-pandas: ${ok ? "ok" : "FAILED"}`);
  if (!ok) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
