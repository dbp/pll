/**
 * Putting PLL into a Pyodide interpreter. The Python itself lives in the
 * `.py` files under `src/python`, which esbuild's `text` loader inlines at
 * build time - so it stays editable as real Python rather than as template
 * literals - and the two wheels runtime type checking needs are inlined by
 * its `base64` loader.
 *
 * Loaded once, in this order, into one set of globals:
 *   1. the bootstrap         - `bootstrap/`, one file per concern: running
 *                              files, prompt lines and tests; the static
 *                              checks; describing errors; the packages a
 *                              program imports; importing the student's
 *                              files at their own levels
 *   2. the explanations      - `explain/`: what each error and finding
 *                              says to the student
 *   3. the libraries         - images, tables and charts, reactors (after
 *                              images: handlers draw with them), Examplar
 *   4. `install.py`          - registers `pll.image` / `pll.table` /
 *                              `pll.reactor` and copies their public names
 *                              into `_pll_initial_globals`
 *   5. type checking         - the vendored wheels, and typeguard switched on
 *
 * The bootstrap and the explanations depend on none of the libraries: they duck-type
 * `_pll_image_data` / `_pll_table_data` when it displays a value, and looks
 * up the few library functions it calls when it calls them. The functions
 * the host calls are listed, typed, in `run/python.ts`.
 */

import typeCheckingSource from "../python/bootstrap/typeChecking.py";
import errorInfoSource from "../python/bootstrap/errorInfo.py";
import codeFactsSource from "../python/bootstrap/codeFacts.py";
import sessionsSource from "../python/bootstrap/sessions.py";
import stopSource from "../python/bootstrap/stop.py";
import compileSource from "../python/bootstrap/compile.py";
import libraryHelpersSource from "../python/bootstrap/libraryHelpers.py";
import packagesSource from "../python/bootstrap/packages.py";
import runningSource from "../python/bootstrap/running.py";
import testsSource from "../python/bootstrap/tests.py";
import staticAnalysisSource from "../python/bootstrap/staticAnalysis.py";
import importsSource from "../python/bootstrap/imports.py";
import findingSource from "../python/explain/finding.py";
import namesSource from "../python/explain/names.py";
import typeCheckSource from "../python/explain/typeCheck.py";
import stockSource from "../python/explain/stock.py";
import staticWordingSource from "../python/explain/static.py";
import imageLibSource from "../python/libraries/image.py";
import tableLibSource from "../python/libraries/table.py";
import reactorLibSource from "../python/libraries/reactor.py";
import examplarLibSource from "../python/libraries/examplar.py";
import installSource from "../python/install.py";
import httpSource from "../python/libraries/http.py";
import matplotlibBackendSource from "../python/libraries/matplotlibBackend.py";
import typeguardWheel from "../../vendor/python/typeguard-4.6.0-py3-none-any.whl";
import typingExtensionsWheel from "../../vendor/python/typing_extensions-4.15.0-py3-none-any.whl";
import { bootstrapFile, explainFile, PLL_HTTP_FILE, PLL_INSTALL_FILE, PLL_LIBRARY_FILES } from "./fileNames";
import { waitForStop } from "./sharedMemory";
import { ensureWorkDir, type MemFS } from "./workspace";

/** One of PLL's Python files, and the name its frames show (`fileNames.ts`). */
export interface PythonSource {
  file: string;
  source: string;
}

/**
 * The bootstrap. Its files share one set of globals, so a function may call
 * one defined in any of them; the order matters only for what runs as a
 * file loads - `errorInfo` reads the vendor directory from `typeChecking`,
 * and `tests` decorates with `running`'s `_pll_stoppable`.
 */
const PLL_BOOTSTRAP_PY: ReadonlyArray<PythonSource> = [
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

/**
 * The explanations, which the bootstrap calls when there is something to
 * explain: `finding` first, which the rules in the others register with.
 */
const PLL_EXPLAIN_PY: ReadonlyArray<PythonSource> = [
  { file: explainFile("finding"), source: findingSource },
  { file: explainFile("names"), source: namesSource },
  { file: explainFile("typeCheck"), source: typeCheckSource },
  { file: explainFile("stock"), source: stockSource },
  { file: explainFile("static"), source: staticWordingSource },
];

/**
 * The libraries, after the bootstrap: reactors after images, since `to_draw`
 * handlers use the image primitives, and Examplar after the bootstrap,
 * whose `_pll_fix_ast_ranges` it borrows for pytest's assertion rewriting.
 */
const PLL_LIBRARIES_PY: ReadonlyArray<PythonSource> = [
  { file: PLL_LIBRARY_FILES.image, source: imageLibSource },
  { file: PLL_LIBRARY_FILES.table, source: tableLibSource },
  { file: PLL_LIBRARY_FILES.reactor, source: reactorLibSource },
  { file: PLL_LIBRARY_FILES.examplar, source: examplarLibSource },
];

/**
 * Routes `urllib`/`requests` (and therefore pandas URL readers) through the
 * host's network (`http.py`). Idempotent, and run each time a program
 * imports one of those modules, so `requests` is set up once it is loaded.
 */
export const PLL_HTTP_PY: PythonSource = { file: PLL_HTTP_FILE, source: httpSource };

/** What a request through the host's network gives back. */
export interface HttpAnswer {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

/**
 * One request through the host's network, waited for: Python's only way to
 * the network (`_pll_http_request` in libraryHelpers.py). No answer
 * (`undefined`, Python's None) when a Stop ended the wait: the host has
 * taken the Stop from the interrupt buffer and acknowledged it, for Python
 * to deliver at the program's line - left there, Pyodide would raise it as
 * the call returns, unacknowledged. A request that gets no answer throws an
 * `Error` named as a browser's XHR names them, `NetworkError` or
 * `TimeoutError`, with what went wrong in a few words. A `timeoutMs` of 0
 * is the host's own limit.
 */
export type HostHttp = (
  method: string,
  url: string,
  headers: Record<string, string>,
  body: Uint8Array | null | undefined,
  timeoutMs: number,
) => HttpAnswer | undefined;

/**
 * Pure-Python wheels bundled into the extension so runtime type checking
 * works with no network and no `micropip` step. They are written into
 * MEMFS and put on `sys.path`, where zipimport reads them in place (a wheel
 * is a zip with the package at its root, so no unpacking is needed).
 *
 * `typing_extensions` is pinned to the version in Pyodide's own lockfile,
 * so a program that later pulls in Pyodide's copy (pandas depends on it)
 * sees the same code either way. These entries are *appended* to
 * `sys.path`, so a real package installed into site-packages still wins.
 * Ordered so dependencies are importable before the packages that need them.
 */
const VENDORED_WHEELS: ReadonlyArray<{ name: string; base64: string }> = [
  { name: "typing_extensions.whl", base64: typingExtensionsWheel },
  { name: "typeguard.whl", base64: typeguardWheel },
];

/** Directory the wheels are written to inside MEMFS; `_PLL_VENDOR_DIR` in typeChecking.py. */
const PLL_VENDOR_DIR = "/pll_vendor";

/** The slice of the Pyodide API that putting PLL into an interpreter uses. */
export interface PyodideCore {
  runPython(code: string, options?: { filename?: string }): unknown;
  FS: MemFS;
  globals: {
    get(name: string): PyCallable;
    set(name: string, value: unknown): void;
  };
}

export interface PyCallable {
  (...args: unknown[]): unknown;
  destroy?(): void;
}

/**
 * Put PLL into a fresh interpreter: the bootstrap, the libraries, the
 * install step, type checking and the work directory, in that order.
 *
 * The worker starts this way, and so do the tests that drive Python
 * directly, so what they test is what a student's program runs in.
 */
export function installPll(
  instance: PyodideCore,
  { interruptBuffer = null, http = null }: { interruptBuffer?: SharedArrayBuffer | null; http?: HostHttp | null } = {},
): void {
  for (const python of [...PLL_BOOTSTRAP_PY, ...PLL_EXPLAIN_PY]) {
    run(instance, python);
  }
  if (http) {
    instance.globals.set("_pll_host_http", http);
  }
  if (interruptBuffer) {
    // PLL's SIGINT handler acknowledges a delivered Stop here, so the host
    // knows to stop re-asserting it (see sharedMemory.ts).
    const view = new Uint8Array(interruptBuffer);
    instance.globals.set("_pll_interrupt_view", view);
    instance.globals.set("_pll_wait_for_stop", waitForStop(view));
  }
  // Imported by matplotlib as `_pll_matplotlib` (install.py).
  instance.globals.set("_pll_matplotlib_backend_source", matplotlibBackendSource);
  instance.globals.set("_PLL_MATPLOTLIB_FILE", PLL_LIBRARY_FILES.matplotlib);
  for (const python of PLL_LIBRARIES_PY) {
    run(instance, python);
  }
  run(instance, { file: PLL_INSTALL_FILE, source: installSource });
  // After install.py: it seeds `_pll_initial_globals`, which this adds the
  // typeguard helpers to.
  enableTypeChecking(instance);
  ensureWorkDir(instance.FS);
}

/** Run one of PLL's files, under its own name. */
function run(instance: PyodideCore, python: PythonSource): void {
  instance.runPython(python.source, { filename: python.file });
}

/** `atob` exists in both the browser worker and Node's worker_threads. */
function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Write the vendored wheels into MEMFS and switch on runtime type
 * checking. Best effort: if anything here fails the interpreter is still
 * perfectly usable, just without type checks.
 */
function enableTypeChecking(instance: PyodideCore): void {
  try {
    try {
      instance.FS.mkdir(PLL_VENDOR_DIR);
    } catch {
      /* already there */
    }
    for (const wheel of VENDORED_WHEELS) {
      instance.FS.writeFile(`${PLL_VENDOR_DIR}/${wheel.name}`, decodeBase64(wheel.base64));
    }
    const enable = instance.globals.get("_pll_enable_type_checking");
    try {
      enable();
    } finally {
      enable.destroy?.();
    }
  } catch {
    /* type checking stays off */
  }
}
