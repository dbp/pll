import { collectChangedWorkspaceFiles, mountWorkspaceFiles } from "./memfsWorkspace";
import { whyNotLoaded, type WorkspaceFile } from "./workspaceFilePolicy";
import { PANDAS_METHOD_RE } from "./packages";
import { installPll, type PyodideCore } from "./pythonInstall";
import { PYODIDE_HTTP_PATCH_PY } from "./pythonSources";
import type {
  DisplayData,
  ExamplarBuildResult,
  ExamplarRunResult,
  RawReplCheck,
  RawStaticFinding,
  ReactorStepResult,
  RunResult,
} from "./wire";
import { clearInterrupt } from "./interruptBuffer";
import { waitForStdin } from "./stdinBuffer";
import type { ReplyFor, WorkerErrorKind, WorkerInbound, WorkerOutbound } from "./workerProtocol";
import { errorText } from "./errorText";
import { DEFAULT_LEVEL, levelHeaderProblem, parseLevel } from "./level";
import { onceSuccessful } from "./onceSuccessful";

export interface PackageLoadOptions {
  messageCallback?: (message: string) => void;
  errorCallback?: (message: string) => void;
}

/** The slice of the Pyodide API the worker uses. */
export interface PyodideInstance extends PyodideCore {
  loadPackage(names: string | string[], options?: PackageLoadOptions): Promise<unknown>;
  loadPackagesFromImports(code: string, options?: PackageLoadOptions): Promise<unknown>;
  setStdin(options: { read: (buffer: Uint8Array) => number; isatty?: boolean }): void;
  /** Poll this buffer for pending signals; a 2 raises `KeyboardInterrupt`. */
  setInterruptBuffer(buffer: Uint8Array): void;
}

/** What the desktop and web workers have to supply themselves. */
export interface WorkerHostAdapter {
  /** Send a message back to the extension host. */
  post(msg: WorkerOutbound): void;
  /** Boot Pyodide (importScripts in the browser, `import("pyodide")` on Node). */
  loadPyodide(indexUrl: string, packageCacheDir?: string): Promise<PyodideInstance>;
  /** Raised by `input()` when the host could not provide a SharedArrayBuffer. */
  stdinUnavailableMessage: string;
}

/**
 * A converted Python value with every `None` as `null`. `toJs` makes a
 * `None` `undefined`, which the wire types do not admit; this is the one
 * place it is turned back.
 */
function nullForNone(value: unknown): unknown {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(nullForNone);
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, nullForNone(inner)]));
  }
  return value;
}

/** Why a request failed, for the runtime to act on rather than read. */
function errorKind(err: unknown): WorkerErrorKind {
  if (interpreterFinished(err)) return "finished";
  // Pyodide's `PythonError` names the Python exception it carries.
  if ((err as { type?: unknown } | null)?.type === "KeyboardInterrupt") return "interrupted";
  return "failed";
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

/** The reply to a request of type `T`, before its id is put on it. */
type Reply<T extends WorkerInbound["type"]> = Omit<ReplyFor<T>, "id">;

/**
 * How long live stdout/stderr may be buffered before it is posted. Small
 * enough that an `input()` prompt still appears promptly, large enough that
 * a runaway print loop cannot starve the extension host.
 */
const LIVE_FLUSH_MS = 50;

/**
 * How many finished lines may be posted at once, each as it is printed,
 * and how many a second after that. A program that prints now and then
 * has each line shown as it prints it, however long it computes after; a
 * print loop gets `LIVE_LINES_PER_SECOND` posts, each of every line since
 * the last.
 */
const LIVE_LINE_BURST = 10;
const LIVE_LINES_PER_SECOND = 100;

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
  let packageCacheDir: string | undefined;
  let stdinBuffer: SharedArrayBuffer | null = null;
  let interruptBuffer: SharedArrayBuffer | null = null;
  /** Buffered live stream text, waiting to be posted as one message. */
  let livePending: { type: "stdout" | "stderr"; text: string } | null = null;
  let liveLastPost = 0;
  /** Lines that may be posted now, as they are printed (`LIVE_LINE_BURST`). */
  let liveLineTokens = LIVE_LINE_BURST;
  let liveTokensAt = 0;
  /** The request whose output is being streamed. */
  let liveRequest = 0;

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
    adapter.post({ type: "display", requestId: liveRequest, payload });
  }

  /** Whether a finished line may be posted now, using up one if so. */
  function takeLineToken(): boolean {
    const now = Date.now();
    const earned = ((now - liveTokensAt) * LIVE_LINES_PER_SECOND) / 1000;
    liveLineTokens = Math.min(LIVE_LINE_BURST, liveLineTokens + earned);
    liveTokensAt = now;
    if (liveLineTokens < 1) {
      return false;
    }
    liveLineTokens -= 1;
    return true;
  }

  /**
   * Stream one display to the host. Text is posted when a line is finished,
   * as long as lines are not coming faster than `LIVE_LINES_PER_SECOND`,
   * and otherwise at most once per `LIVE_FLUSH_MS`; a partial line waits
   * for the rest, a `flush()`, an `input()` or the end of the run.
   *
   * Without the limit, `while True: print("hello")` posts a few hundred
   * thousand messages per second. The extension host cannot drain them
   * faster than the worker produces them, so its queue grows without bound
   * and the Stop the student presses is never processed - the one moment it
   * has to work. Images and tables flush the pending text first so the
   * interleaved order of output and cards is preserved exactly.
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
      if ((payload.text.includes("\n") && takeLineToken()) || Date.now() - liveLastPost >= LIVE_FLUSH_MS) {
        flushLive();
      }
      return;
    }
    flushLive();
    adapter.post({ type: "display", requestId: liveRequest, payload });
  }

  /** Bytes of stdin the host gave that Python has not read yet. */
  let stdinCarry: Uint8Array = new Uint8Array(0);

  /**
   * Python reading its stdin (fd 0): fill `buffer` with what the host gives,
   * exactly - nothing added, nothing cut off - and 0 at its end.
   */
  function readStdin(buffer: Uint8Array): number {
    if (stdinCarry.length === 0) {
      if (!stdinBuffer) {
        throw new Error(adapter.stdinUnavailableMessage);
      }
      // The prompt of `input("Choice: ")` is unflushed stdout. It has to
      // reach the host before this thread parks, or the student is asked
      // for a line with nothing on screen telling them what for.
      flushLive();
      const got = waitForStdin(stdinBuffer, (request) => adapter.post({ type: "stdinRequest", request }));
      if (got === "interrupted") {
        // An interrupted read: Python checks for the Stop - pending in the
        // interrupt buffer - and raises `KeyboardInterrupt` in `input()`.
        throw Object.assign(new Error("interrupted"), { code: "EINTR" });
      }
      if (got === null) {
        return 0;
      }
      stdinCarry = got;
    }
    const n = Math.min(buffer.length, stdinCarry.length);
    buffer.set(stdinCarry.subarray(0, n));
    stdinCarry = stdinCarry.subarray(n);
    return n;
  }

  const ensurePyodide = onceSuccessful(async (): Promise<PyodideInstance> => {
    const instance = await adapter.loadPyodide(indexUrl, packageCacheDir);
    instance.setStdin({ read: readStdin });
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

  const loadHttpShim = onceSuccessful(() => ready().loadPackage("pyodide-http", packageProgress));

  /**
   * Route `urllib` / `requests` through the host network. The package is
   * loaded once; the patch runs every time, so a `requests` loaded since
   * the last is patched too.
   */
  async function ensureHttpShim(): Promise<void> {
    await loadHttpShim();
    ready().runPython(PYODIDE_HTTP_PATCH_PY.source, { filename: PYODIDE_HTTP_PATCH_PY.file });
  }

  const ensurePytest = onceSuccessful(() => ready().loadPackage("pytest", packageProgress));

  /**
   * Call a Python global, and give back what it returns as plain JS - a dict
   * or list converted, a `None` as `null`.
   */
  function callPython<T>(name: string, args: unknown[]): T {
    const fn = ready().globals.get(name);
    try {
      const value = fn(...args);
      if (typeof value?.toJs !== "function") {
        return nullForNone(value) as T;
      }
      try {
        return nullForNone(value.toJs({ dict_converter: Object.fromEntries })) as T;
      } finally {
        // Both proxies are freed even if `toJs` throws: a PyProxy is a
        // handle to a live Python object, so dropping one leaks it.
        value.destroy?.();
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
  function withLiveEmit<T>(requestId: number, run: () => T): T {
    liveRequest = requestId;
    ready().globals.set("_pll_live_emit", emitDisplay);
    ready().globals.set("_pll_live_flush", flushLive);
    livePending = null;
    // Zero, not `Date.now()`, so a run's first output is posted immediately.
    liveLastPost = 0;
    liveLineTokens = LIVE_LINE_BURST;
    liveTokensAt = Date.now();
    try {
      return run();
    } finally {
      // The result's own `displays` are dropped by the caller, so anything
      // still buffered here is the only copy of the tail of the output.
      flushLive();
      ready().runPython("_pll_live_emit = None\n_pll_live_flush = None");
    }
  }

  /**
   * What each request does, and its reply. One per kind of request, so a
   * new one in `WorkerInbound` does not compile until it is handled here.
   */
  const requests: {
    [Type in WorkerInbound["type"]]: (
      data: Extract<WorkerInbound, { type: Type }>,
    ) => Reply<Type> | Promise<Reply<Type>>;
  } = {
    async init(data) {
      stdinBuffer = data.stdinBuffer ?? null;
      interruptBuffer = data.interruptBuffer ?? null;
      indexUrl = data.indexUrl;
      packageCacheDir = data.packageCacheDir;
      await ensurePyodide();
      return { type: "ready" };
    },
    runFile(data) {
      const result = withLiveEmit(data.id, () =>
        callPython<RunResult>("_pll_run_file", [
          data.code,
          data.fileName,
          data.sessionKey,
          data.level ?? DEFAULT_LEVEL,
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
        data.level ?? DEFAULT_LEVEL,
      ]);
      return { type: "result", result };
    },
    checkSyntax(data) {
      const result = callPython<RawReplCheck>("_pll_repl_check", [data.code, data.whole === true]);
      return { type: "syntax", result };
    },
    hasTests(data) {
      return { type: "hasTests", result: callPython<boolean>("_pll_has_tests", [data.code]) };
    },
    async loadPackages(data) {
      const siblings = data.siblings ?? [];
      const found = callPython<{ modules: string[]; network: boolean }>("_pll_package_imports", [
        data.code,
        JSON.stringify(siblings),
      ]);
      // `to_pandas` keeps its import inside the method, so it is asked
      // for by the call.
      const modules = [...found.modules];
      if ([data.code, ...siblings.map((s) => s.text)].some((text) => PANDAS_METHOD_RE.test(text))) {
        modules.push("pandas");
      }
      // Pyodide's own map from what is imported to the package that has
      // it; names it does not know - the standard library, or none at
      // all - it leaves alone.
      if (modules.length > 0) {
        await ready().loadPackagesFromImports(modules.map((name) => `import ${name}`).join("\n"), packageProgress);
      }
      if (found.network || modules.includes("pandas")) {
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
      const result = withLiveEmit(data.id, () =>
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
      callPython("_pll_reactor_dispose", [data.reactorId]);
      return { type: "reactorDisposed" };
    },
    endSession(data) {
      callPython("_pll_end_session", [data.sessionKey]);
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
        data.fileName,
      ]);
      return { type: "examplarRan", result };
    },
    mountWorkspace(data) {
      mountWorkspaceFiles(ready().FS, data.files);
      callPython("_pll_note_file_levels", [JSON.stringify(levelsOf(data.files))]);
      const leftOut = (data.leftOut ?? []).map((file) => ({ name: file.name, why: whyNotLoaded(file) }));
      callPython("_pll_note_left_out", [JSON.stringify(leftOut)]);
      return { type: "workspaceReady" };
    },
    collectWorkspace() {
      return { type: "workspaceFiles", changes: collectChangedWorkspaceFiles(ready().FS) };
    },
  };

  async function handleOne(data: WorkerInbound): Promise<void> {
    if (data.type !== "init") {
      dropPendingInterrupt();
    }
    try {
      const request = requests[data.type] as (
        data: WorkerInbound,
      ) => Reply<WorkerInbound["type"]> | Promise<Reply<WorkerInbound["type"]>>;
      adapter.post({ id: data.id, ...(await request(data)) } as WorkerOutbound);
    } catch (err) {
      adapter.post({ id: data.id, type: "error", message: errorText(err), kind: errorKind(err) });
    }
  }

  // One request at a time, in the order they arrive: a handler that awaits
  // - loading Pyodide or a package - finishes before the next one starts,
  // so no Python runs while a package is half installed.
  let queue: Promise<void> = Promise.resolve();
  return function handle(data: WorkerInbound): Promise<void> {
    queue = queue.then(() => handleOne(data));
    return queue;
  };
}

/**
 * Each Python file's level, read from its `#level` line as a run of it
 * would read it - and what is wrong with the line, if anything - so that
 * Python can hold the file to it when another file imports it. Keyed by
 * the file's path under the work directory: `helpers/shapes.py`.
 */
function levelsOf(files: WorkspaceFile[]): Record<string, [string, { line: number; message: string } | null]> {
  const levels: Record<string, [string, { line: number; message: string } | null]> = {};
  const decoder = new TextDecoder();
  for (const file of files) {
    if (!file.name.endsWith(".py")) continue;
    const text = typeof file.contents === "string" ? file.contents : decoder.decode(file.contents);
    const problem = levelHeaderProblem(text);
    levels[file.name] = [parseLevel(text), problem && { line: problem.line, message: problem.message }];
  }
  return levels;
}
