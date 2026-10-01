import {
  collectChangedWorkspaceFiles,
  ensureWorkDir,
  mountWorkspaceFiles,
  type MemFS,
} from "./memfsWorkspace";
import {
  NETWORK_IMPORT_RE,
  PANDAS_METHOD_RE,
  PLL_EXAMPLAR_LIB_PY,
  PLL_IMAGE_LIB_PY,
  PLL_REACTOR_LIB_PY,
  PLL_TABLE_LIB_PY,
  PYODIDE_BOOTSTRAP_PY,
  PYODIDE_HTTP_PATCH_PY,
  PYODIDE_INSTALL_PY,
  type DisplayData,
  type ExamplarBuildResult,
  type ExamplarRunResult,
  type RawStaticFinding,
  type ReactorStepResult,
  type RunResult,
  type TestRunResult,
} from "./pyodideRunner";
import { clearInterrupt } from "./interruptBuffer";
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
  /** Poll this buffer for pending signals; a 2 raises `KeyboardInterrupt`. */
  setInterruptBuffer(buffer: Uint8Array): void;
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

/**
 * How long live stdout/stderr may be buffered before it is posted. Small
 * enough that an `input()` prompt still appears promptly, large enough that
 * a runaway print loop cannot starve the extension host.
 */
const LIVE_FLUSH_MS = 50;

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
  let interruptBuffer: SharedArrayBuffer | null = null;
  /** Buffered live stream text, waiting to be posted as one message. */
  let livePending: { type: "stdout" | "stderr"; text: string } | null = null;
  let liveLastPost = 0;

  function flushLive(): void {
    if (!livePending) {
      return;
    }
    const payload = livePending;
    livePending = null;
    liveLastPost = Date.now();
    adapter.post({ type: "display", payload });
  }

  /**
   * Stream one display to the host, coalescing consecutive stdout/stderr
   * writes into at most one message per `LIVE_FLUSH_MS`.
   *
   * Without this, `while True: print("hello")` posts a few hundred thousand
   * messages per second. The extension host cannot drain them faster than
   * the worker produces them, so its queue grows without bound and the Stop
   * the student presses is never processed - the one moment it has to work.
   * Images and tables flush the pending text first so the interleaved order
   * of output and cards is preserved exactly.
   */
  function emitDisplay(json: string): void {
    let payload: DisplayData;
    try {
      payload = JSON.parse(String(json)) as DisplayData;
    } catch {
      /* malformed payload: skip */
      return;
    }
    if (payload.type === "stdout" || payload.type === "stderr") {
      if (livePending && livePending.type === payload.type) {
        livePending.text += payload.text;
      } else {
        flushLive();
        livePending = { type: payload.type, text: payload.text };
      }
      if (Date.now() - liveLastPost >= LIVE_FLUSH_MS) {
        flushLive();
      }
      return;
    }
    flushLive();
    adapter.post({ type: "display", payload });
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
    // The prompt of `input("Choice: ")` is unflushed stdout. It has to reach
    // the host before this thread parks, or the student is asked for a line
    // with nothing on screen telling them what for.
    flushLive();
    return waitForStdinLine(stdinBuffer, () => adapter.post({ type: "stdinRequest" }));
  }

  async function ensurePyodide(indexUrl: string): Promise<PyodideInstance> {
    if (!initPromise) {
      initPromise = (async () => {
        const instance = await adapter.loadPyodide(indexUrl);
        instance.setStdin({ stdin: readStdin, autoEOF: true });
        if (interruptBuffer) {
          instance.setInterruptBuffer(new Uint8Array(interruptBuffer));
        }
        instance.runPython(PYODIDE_BOOTSTRAP_PY);
        instance.runPython(PLL_IMAGE_LIB_PY);
        instance.runPython(PLL_TABLE_LIB_PY);
        // After the image lib: `to_draw` handlers use the image primitives.
        instance.runPython(PLL_REACTOR_LIB_PY);
        // After the bootstrap: it borrows `_pll_fix_ast_ranges` for pytest's
        // assertion rewriting.
        instance.runPython(PLL_EXAMPLAR_LIB_PY);
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
   * Drop a pending Stop before running anything. Without this, a Stop that
   * arrived after the interpreter finished (or one it never polled) would
   * raise `KeyboardInterrupt` in whatever the student ran next.
   */
  function dropPendingInterrupt(): void {
    if (interruptBuffer) {
      clearInterrupt(interruptBuffer);
    }
  }

  /**
   * `_pll_live_emit` streams every stdout write and every image/table to the
   * host as it happens, so an `input()` prompt shows up before the program
   * blocks. Only enabled around a file run, where blocking is possible.
   */
  function withLiveEmit<T>(run: () => T): T {
    ready().globals.set("_pll_live_emit", emitDisplay);
    livePending = null;
    // Zero, not `Date.now()`, so a run's first output is posted immediately.
    liveLastPost = 0;
    try {
      return run();
    } finally {
      // The result's own `displays` are dropped by the caller, so anything
      // still buffered here is the only copy of the tail of the output.
      flushLive();
      ready().runPython("_pll_live_emit = None");
    }
  }

  return async function handle(data: WorkerInbound): Promise<void> {
    try {
      switch (data.type) {
        case "init": {
          stdinBuffer = data.stdinBuffer ?? null;
          interruptBuffer = data.interruptBuffer ?? null;
          await ensurePyodide(data.indexUrl);
          adapter.post({ id: data.id, type: "ready" });
          break;
        }
        case "runFile": {
          dropPendingInterrupt();
          const result = withLiveEmit(() =>
            callPython<RunResult>("_pll_run_file", [
              data.code,
              data.fileName,
              data.sessionKey,
              data.level ?? "raw",
            ]),
          );
          // Already streamed live; returning them again would duplicate.
          result.displays = [];
          adapter.post({ id: data.id, type: "result", result });
          break;
        }
        case "replEval": {
          dropPendingInterrupt();
          const result = callPython<RunResult>("_pll_repl_eval", [
            data.code,
            data.sessionKey,
            data.level ?? "raw",
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
          // `loadPackagesFromImports` only sees imports, and `to_pandas`
          // keeps its own inside the method, so it has to be asked for
          // by name.
          if (PANDAS_METHOD_RE.test(data.code)) {
            await ready().loadPackage("pandas");
          }
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
          dropPendingInterrupt();
          await ensurePytest();
          const result = callPython<TestRunResult>("_pll_run_tests", [
            data.code,
            data.fileName,
            data.level ?? "raw",
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
        case "reactorStep": {
          const result = withLiveEmit(() =>
            callPython<ReactorStepResult>("_pll_reactor_step", [
              data.reactorId,
              data.event,
            ]),
          );
          adapter.post({ id: data.id, type: "reactorFrame", result });
          break;
        }
        case "reactorSeek": {
          const result = callPython<ReactorStepResult>("_pll_reactor_seek", [
            data.reactorId,
            data.index,
          ]);
          adapter.post({ id: data.id, type: "reactorFrame", result });
          break;
        }
        case "reactorDispose": {
          const fn = ready().globals.get("_pll_reactor_dispose");
          try {
            fn(data.reactorId);
          } finally {
            fn.destroy?.();
          }
          adapter.post({ id: data.id, type: "reactorDisposed" });
          break;
        }
        case "examplarBuild": {
          const result = callPython<ExamplarBuildResult>("_pll_examplar_build", [
            data.sources,
          ]);
          adapter.post({ id: data.id, type: "examplarBuilt", result });
          break;
        }
        case "examplarRun": {
          const result = callPython<ExamplarRunResult>("_pll_examplar_run", [
            data.testSource,
            data.bundle,
          ]);
          adapter.post({ id: data.id, type: "examplarRan", result });
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
