import { collectChangedWorkspaceFiles, mountWorkspaceFiles } from "./memfsWorkspace";
import { NETWORK_IMPORT_RE, PANDAS_METHOD_RE } from "./packages";
import { installPll, type PyodideCore } from "./pythonInstall";
import { PYODIDE_HTTP_PATCH_PY } from "./pythonSources";
import type {
  DisplayData,
  ExamplarBuildResult,
  ExamplarRunResult,
  RawStaticFinding,
  ReactorStepResult,
  RunResult,
} from "./wire";
import { clearInterrupt } from "./interruptBuffer";
import { waitForStdinLine } from "./stdinBuffer";
import type { RawReplCheck, WorkerInbound, WorkerOutbound } from "./workerProtocol";
import { errorText } from "./errorText";
import { onceSuccessful } from "./onceSuccessful";

export interface PackageLoadOptions {
  messageCallback?: (message: string) => void;
  errorCallback?: (message: string) => void;
}

/** The slice of the Pyodide API the worker uses. */
export interface PyodideInstance extends PyodideCore {
  loadPackage(names: string | string[], options?: PackageLoadOptions): Promise<unknown>;
  loadPackagesFromImports(code: string, options?: PackageLoadOptions): Promise<unknown>;
  setStdin(options: {
    stdin?: () => string | null | undefined;
    autoEOF?: boolean;
    isatty?: boolean;
  }): void;
  /** Poll this buffer for pending signals; a 2 raises `KeyboardInterrupt`. */
  setInterruptBuffer(buffer: Uint8Array): void;
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
 * Whether `err` says the interpreter is finished. After a fatal error -
 * or after something ends the process it thinks it is running in -
 * Pyodide replaces its whole API with functions that throw this, so no
 * later request can succeed in this worker.
 */
function interpreterFinished(err: unknown): boolean {
  return (
    (err as { pyodide_fatal_error?: unknown } | null)?.pyodide_fatal_error === true ||
    /^Pyodide already (?:exited|fatally failed)\b/.test(errorText(err))
  );
}

/** A request's reply, before its id is put on it. */
type Reply = WithoutId<WorkerOutbound>;
type WithoutId<Message> = Message extends { id: number } ? Omit<Message, "id"> : never;

/**
 * How long live stdout/stderr may be buffered before it is posted. Small
 * enough that an `input()` prompt still appears promptly, large enough that
 * a runaway print loop cannot starve the extension host.
 */
const LIVE_FLUSH_MS = 50;

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
  /** Where `init` said Pyodide's assets are; read by the first successful start. */
  let indexUrl = "";
  let stdinBuffer: SharedArrayBuffer | null = null;
  let interruptBuffer: SharedArrayBuffer | null = null;
  /** Buffered live stream text, waiting to be posted as one message. */
  let livePending: { type: "stdout" | "stderr"; text: string } | null = null;
  let liveLastPost = 0;

  /**
   * Where Pyodide's package-loading messages go: to the host, which decides
   * whether to show them - only it knows whether it was asked to be quiet.
   * Left out, Pyodide logs to `console.log`, which in Node is **stdout**,
   * where the command line promises only the program's own output appears.
   */
  const packageProgress: PackageLoadOptions = {
    messageCallback: (text: string) => adapter.post({ type: "packageNote", text, failed: false }),
    errorCallback: (text: string) => adapter.post({ type: "packageNote", text, failed: true }),
  };

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

  const ensurePyodide = onceSuccessful(async (): Promise<PyodideInstance> => {
    const instance = await adapter.loadPyodide(indexUrl);
    instance.setStdin({ stdin: readStdin, autoEOF: true });
    if (interruptBuffer) {
      instance.setInterruptBuffer(new Uint8Array(interruptBuffer));
    }
    installPll(instance, { interruptBuffer });
    pyodide = instance;
    return instance;
  });

  /** Pyodide, or a thrown error if `init` has not completed. */
  function ready(): PyodideInstance {
    if (!pyodide) {
      throw new Error("Pyodide not initialized");
    }
    return pyodide;
  }

  /** Route `urllib` / `requests` through the host network. Once per interpreter. */
  const ensureHttpShim = onceSuccessful(async (): Promise<void> => {
    const instance = ready();
    await instance.loadPackage("pyodide-http", packageProgress);
    instance.runPython(PYODIDE_HTTP_PATCH_PY);
  });

  const ensurePytest = onceSuccessful(() => ready().loadPackage("pytest", packageProgress));

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
   * Drop a pending Stop before every request. Without this, a Stop that
   * arrived after the interpreter finished (or one it never polled, pressed
   * while files were loading) would raise `KeyboardInterrupt` in whatever
   * ran next - the next run's static checks, typically, which then reported
   * that they had failed.
   *
   * This cannot lose a Stop: `requestInterrupt` puts one back for as long as
   * a request that was running when it was pressed is still running.
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

  /**
   * What each request does, and its reply. One per kind of request, so a
   * new one in `WorkerInbound` does not compile until it is handled here.
   */
  const requests: {
    [Type in WorkerInbound["type"]]: (
      data: Extract<WorkerInbound, { type: Type }>,
    ) => Reply | Promise<Reply>;
  } = {
    async init(data) {
      stdinBuffer = data.stdinBuffer ?? null;
      interruptBuffer = data.interruptBuffer ?? null;
      indexUrl = data.indexUrl;
      await ensurePyodide();
      return { type: "ready" };
    },
    runFile(data) {
      const result = withLiveEmit(() =>
        callPython<RunResult>("_pll_run_file", [
          data.code,
          data.fileName,
          data.sessionKey,
          data.level ?? "raw",
          data.withTests ?? false,
        ]),
      );
      // Already streamed live; returning them again would duplicate.
      result.displays = [];
      return { type: "result", result };
    },
    replEval(data) {
      const result = callPython<RunResult>("_pll_repl_eval", [
        data.code,
        data.sessionKey,
        data.level ?? "raw",
      ]);
      return { type: "result", result };
    },
    checkSyntax(data) {
      const result = callPython<RawReplCheck>("_pll_repl_check", [data.code]);
      return { type: "syntax", result };
    },
    hasTests(data) {
      // Returns a bare bool, so there is no proxy to convert.
      const fn = ready().globals.get("_pll_has_tests");
      try {
        return { type: "hasTests", result: Boolean(fn(data.code)) };
      } finally {
        fn.destroy?.();
      }
    },
    async loadPackages(data) {
      await ready().loadPackagesFromImports(data.code, packageProgress);
      // `loadPackagesFromImports` only sees imports, and `to_pandas`
      // keeps its own inside the method, so it has to be asked for
      // by name.
      if (PANDAS_METHOD_RE.test(data.code)) {
        await ready().loadPackage("pandas", packageProgress);
      }
      if (NETWORK_IMPORT_RE.test(data.code)) {
        await ensureHttpShim();
      }
      return { type: "packagesReady" };
    },
    async loadPytest() {
      await ensurePytest();
      return { type: "pytestReady" };
    },
    staticAnalyze(data) {
      const result =
        callPython<RawStaticFinding[]>("_pll_static_analyze", [
          data.code,
          data.level,
          data.fileName,
          data.sessionKey ?? null,
        ]) ?? [];
      return { type: "static", result };
    },
    reactorStep(data) {
      const result = withLiveEmit(() =>
        callPython<ReactorStepResult>("_pll_reactor_step", [
          data.reactorId,
          data.event,
        ]),
      );
      return { type: "reactorFrame", result };
    },
    reactorSeek(data) {
      const result = callPython<ReactorStepResult>("_pll_reactor_seek", [
        data.reactorId,
        data.index,
      ]);
      return { type: "reactorFrame", result };
    },
    reactorDispose(data) {
      const fn = ready().globals.get("_pll_reactor_dispose");
      try {
        fn(data.reactorId);
      } finally {
        fn.destroy?.();
      }
      return { type: "reactorDisposed" };
    },
    endSession(data) {
      const fn = ready().globals.get("_pll_end_session");
      try {
        fn(data.sessionKey);
      } finally {
        fn.destroy?.();
      }
      return { type: "sessionEnded" };
    },
    examplarBuild(data) {
      const result = callPython<ExamplarBuildResult>("_pll_examplar_build", [
        data.sources,
      ]);
      return { type: "examplarBuilt", result };
    },
    examplarRun(data) {
      const result = callPython<ExamplarRunResult>("_pll_examplar_run", [
        data.testSource,
        data.bundle,
      ]);
      return { type: "examplarRan", result };
    },
    mountWorkspace(data) {
      mountWorkspaceFiles(ready().FS, data.files);
      return { type: "workspaceReady" };
    },
    collectWorkspace() {
      const files = collectChangedWorkspaceFiles(ready().FS);
      return { type: "workspaceFiles", files };
    },
  };

  return async function handle(data: WorkerInbound): Promise<void> {
    if (data.type !== "init") {
      dropPendingInterrupt();
    }
    try {
      const request = requests[data.type] as (data: WorkerInbound) => Reply | Promise<Reply>;
      adapter.post({ id: data.id, ...(await request(data)) });
    } catch (err) {
      adapter.post({
        id: data.id,
        type: "error",
        message: errorText(err),
        ...(interpreterFinished(err) ? { finished: true } : {}),
      });
    }
  };
}
