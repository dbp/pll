import { INTERRUPT_SIGINT } from "./interruptBuffer";
import { ensureWorkDir, type MemFS } from "./memfsWorkspace";
import {
  PLL_BOOTSTRAP_PY,
  PLL_EXAMPLAR_LIB_PY,
  PLL_IMAGE_LIB_PY,
  PLL_MATPLOTLIB_PY,
  PLL_REACTOR_LIB_PY,
  PLL_TABLE_LIB_PY,
  PYODIDE_INSTALL_PY,
  type PythonSource,
} from "./pythonSources";
import { PLL_VENDOR_DIR, VENDORED_WHEELS } from "./pythonVendor";

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
  (...args: unknown[]): PyProxy;
  destroy?(): void;
}

export interface PyProxy {
  toJs(opts?: { dict_converter?: (entries: Iterable<[unknown, unknown]>) => unknown }): unknown;
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
  { interruptBuffer = null }: { interruptBuffer?: SharedArrayBuffer | null } = {},
): void {
  for (const python of PLL_BOOTSTRAP_PY) {
    run(instance, python);
  }
  if (interruptBuffer) {
    // PLL's SIGINT handler acknowledges a delivered Stop here, so the host
    // knows to stop re-asserting it (see interruptBuffer.ts).
    const view = new Uint8Array(interruptBuffer);
    instance.globals.set("_pll_interrupt_view", view);
    instance.globals.set("_pll_wait_for_stop", waitForStop(view));
  }
  instance.globals.set("_pll_matplotlib_backend_source", PLL_MATPLOTLIB_PY.source);
  instance.globals.set("_PLL_MATPLOTLIB_FILE", PLL_MATPLOTLIB_PY.file);
  run(instance, PLL_IMAGE_LIB_PY);
  run(instance, PLL_TABLE_LIB_PY);
  // After the image lib: `to_draw` handlers use the image primitives.
  run(instance, PLL_REACTOR_LIB_PY);
  // After the bootstrap: it borrows `_pll_fix_ast_ranges` for pytest's
  // assertion rewriting.
  run(instance, PLL_EXAMPLAR_LIB_PY);
  run(instance, PYODIDE_INSTALL_PY);
  // After PYODIDE_INSTALL_PY: it seeds `_pll_initial_globals`, which this
  // adds the typeguard helpers to.
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

/**
 * Wait up to `seconds`, or until a Stop is pressed: true if one was. For
 * `time.sleep`, which otherwise runs no bytecode for Pyodide to see a Stop
 * between. Waits in short slices, since the host does not wake this thread
 * when it stores a Stop.
 */
function waitForStop(view: Uint8Array): (seconds: number) => boolean {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  return (seconds) => {
    const end = Date.now() + seconds * 1000;
    for (;;) {
      if (view[0] === INTERRUPT_SIGINT) return true;
      const left = end - Date.now();
      if (left <= 0) return false;
      Atomics.wait(cell, 0, 0, Math.min(left, 20));
    }
  };
}
