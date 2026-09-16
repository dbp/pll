import {
  collectChangedWorkspaceFiles,
  ensureWorkDir,
  mountWorkspaceFiles,
  type MemFS,
} from "./memfsWorkspace";
import {
  NETWORK_IMPORT_RE,
  PLL_IMAGE_LIB_PY,
  PLL_TABLE_LIB_PY,
  PYODIDE_BOOTSTRAP_PY,
  PYODIDE_HTTP_PATCH_PY,
  PYODIDE_INSTALL_PY,
  type RawStaticFinding,
  type RunResult,
  type TestRunResult,
} from "./pyodideRunner";
import { PLL_VENDOR_DIR, VENDORED_WHEELS } from "./pythonVendor";
import { waitForStdinLine } from "./stdinBuffer";
import type { RawReplCheck, WorkerInbound, WorkerOutbound } from "./workerProtocol";

/** The slice of the Pyodide API the worker uses. */
export interface PyodideInstance {
  runPython(code: string): unknown;
  loadPackage(names: string | string[]): Promise<unknown>;
  loadPackagesFromImports(code: string): Promise<unknown>;
  setStdin(options: {
    stdin?: () => string | null | undefined;
    autoEOF?: boolean;
    isatty?: boolean;
  }): void;
  FS: MemFS;
  globals: {
    get(name: string): PyCallable;
    set(name: string, value: unknown): void;
  };
}

interface PyCallable {
  (...args: unknown[]): PyProxy;
  destroy?(): void;
}

interface PyProxy {
  toJs(opts?: { dict_converter?: (entries: Iterable<[unknown, unknown]>) => unknown }): unknown;
  destroy?(): void;
}

/** What the desktop and web workers have to supply themselves. */
export interface WorkerHostAdapter {
  /** Send a message back to the extension host. */
  post(msg: WorkerOutbound): void;
  /** Boot Pyodide (importScripts in the browser, `import("pyodide")` on Node). */
  loadPyodide(indexUrl: string): Promise<PyodideInstance>;
  /** Raised by `input()` when the host could not provide a SharedArrayBuffer. */
  stdinUnavailableMessage: string;
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
 * Worker side of the Pyodide protocol, shared by the desktop
 * (`worker_threads`) and web (browser `Worker`) hosts. Returns the message
 * handler each host wires to its own message source.
 *
 * Everything here runs in the worker: one Pyodide interpreter, loaded once,
 * with the analyzer + image + table libraries installed on init.
 */
export function createWorkerHost(
  adapter: WorkerHostAdapter,
): (data: WorkerInbound) => Promise<void> {
  let pyodide: PyodideInstance | null = null;
  let initPromise: Promise<PyodideInstance> | null = null;
  let pytestPromise: Promise<unknown> | null = null;
  let httpPatchPromise: Promise<void> | null = null;
  let stdinBuffer: SharedArrayBuffer | null = null;

  function emitDisplay(json: string): void {
    try {
      adapter.post({ type: "display", payload: JSON.parse(String(json)) });
    } catch {
      /* malformed payload: skip */
    }
  }

  /**
   * Write the vendored wheels into MEMFS and switch on runtime type
   * checking. Best effort: if anything here fails the interpreter is still
   * perfectly usable, just without type checks.
   */
  function enableTypeChecking(instance: PyodideInstance): void {
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

  function readStdin(): string | null {
    if (!stdinBuffer) {
      throw new Error(adapter.stdinUnavailableMessage);
    }
    return waitForStdinLine(stdinBuffer, () => adapter.post({ type: "stdinRequest" }));
  }

  async function ensurePyodide(indexUrl: string): Promise<PyodideInstance> {
    if (!initPromise) {
      initPromise = (async () => {
        const instance = await adapter.loadPyodide(indexUrl);
        instance.setStdin({ stdin: readStdin, autoEOF: true });
        instance.runPython(PYODIDE_BOOTSTRAP_PY);
        instance.runPython(PLL_IMAGE_LIB_PY);
        instance.runPython(PLL_TABLE_LIB_PY);
        instance.runPython(PYODIDE_INSTALL_PY);
        // After PYODIDE_INSTALL_PY: it seeds `_pll_initial_globals`, which
        // this adds the typeguard helpers to.
        enableTypeChecking(instance);
        ensureWorkDir(instance.FS);
        pyodide = instance;
        return instance;
      })();
    }
    return initPromise;
  }

  /** Pyodide, or a thrown error if `init` has not completed. */
  function ready(): PyodideInstance {
    if (!pyodide) {
      throw new Error("Pyodide not initialized");
    }
    return pyodide;
  }

  /** Route `urllib` / `requests` through the host network. Once per interpreter. */
  function ensureHttpShim(): Promise<void> {
    if (!httpPatchPromise) {
      const instance = ready();
      httpPatchPromise = instance
        .loadPackage("pyodide-http")
        .then(() => void instance.runPython(PYODIDE_HTTP_PATCH_PY));
    }
    return httpPatchPromise;
  }

  function ensurePytest(): Promise<unknown> {
    if (!pytestPromise) {
      pytestPromise = ready().loadPackage("pytest");
    }
    return pytestPromise;
  }

  /** Call a Python global, converting the returned dict/list to plain JS. */
  function callPython<T>(name: string, args: unknown[]): T {
    const fn = ready().globals.get(name);
    try {
      const proxy = fn(...args);
      try {
        return proxy.toJs({ dict_converter: Object.fromEntries }) as T;
      } finally {
        // Both proxies are freed even if `toJs` throws: a PyProxy is a
        // handle to a live Python object, so dropping one leaks it.
        proxy.destroy?.();
      }
    } finally {
      fn.destroy?.();
    }
  }

  /**
   * `_pll_live_emit` streams every stdout write and every image/table to the
   * host as it happens, so an `input()` prompt shows up before the program
   * blocks. Only enabled around a file run, where blocking is possible.
   */
  function withLiveEmit<T>(run: () => T): T {
    ready().globals.set("_pll_live_emit", emitDisplay);
    try {
      return run();
    } finally {
      ready().runPython("_pll_live_emit = None");
    }
  }

  return async function handle(data: WorkerInbound): Promise<void> {
    try {
      switch (data.type) {
        case "init": {
          stdinBuffer = data.stdinBuffer ?? null;
          await ensurePyodide(data.indexUrl);
          adapter.post({ id: data.id, type: "ready" });
          break;
        }
        case "runFile": {
          const result = withLiveEmit(() =>
            callPython<RunResult>("_pll_run_file", [
              data.code,
              data.fileName,
              data.sessionKey,
              data.typeCheck !== false,
              data.level ?? "advanced",
            ]),
          );
          // Already streamed live; returning them again would duplicate.
          result.displays = [];
          adapter.post({ id: data.id, type: "result", result });
          break;
        }
        case "replEval": {
          const result = callPython<RunResult>("_pll_repl_eval", [
            data.code,
            data.sessionKey,
            data.typeCheck !== false,
            data.level ?? "advanced",
          ]);
          adapter.post({ id: data.id, type: "result", result });
          break;
        }
        case "checkSyntax": {
          const result = callPython<RawReplCheck>("_pll_repl_check", [data.code]);
          adapter.post({ id: data.id, type: "syntax", result });
          break;
        }
        case "hasTests": {
          // Returns a bare bool, so there is no proxy to convert.
          const fn = ready().globals.get("_pll_has_tests");
          try {
            adapter.post({ id: data.id, type: "hasTests", result: Boolean(fn(data.code)) });
          } finally {
            fn.destroy?.();
          }
          break;
        }
        case "loadPackages": {
          await ready().loadPackagesFromImports(data.code);
          if (NETWORK_IMPORT_RE.test(data.code)) {
            await ensureHttpShim();
          }
          adapter.post({ id: data.id, type: "packagesReady" });
          break;
        }
        case "loadPytest": {
          await ensurePytest();
          adapter.post({ id: data.id, type: "pytestReady" });
          break;
        }
        case "runTests": {
          await ensurePytest();
          const result = callPython<TestRunResult>("_pll_run_tests", [
            data.code,
            data.fileName,
            data.typeCheck !== false,
            data.level ?? "advanced",
          ]);
          adapter.post({ id: data.id, type: "testResult", result });
          break;
        }
        case "staticAnalyze": {
          const result =
            callPython<RawStaticFinding[]>("_pll_static_analyze", [
              data.code,
              data.level,
              data.fileName,
              data.sessionKey ?? null,
            ]) ?? [];
          adapter.post({ id: data.id, type: "static", result });
          break;
        }
        case "mountWorkspace": {
          mountWorkspaceFiles(ready().FS, data.files);
          adapter.post({ id: data.id, type: "workspaceReady" });
          break;
        }
        case "collectWorkspace": {
          const files = collectChangedWorkspaceFiles(ready().FS);
          adapter.post({ id: data.id, type: "workspaceFiles", files });
          break;
        }
      }
    } catch (err) {
      adapter.post({
        id: data.id,
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
