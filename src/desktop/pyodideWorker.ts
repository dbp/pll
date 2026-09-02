import { parentPort } from "node:worker_threads";
import {
  NETWORK_IMPORT_RE,
  PLL_IMAGE_LIB_PY,
  PLL_TABLE_LIB_PY,
  PYODIDE_BOOTSTRAP_PY,
  PYODIDE_HTTP_PATCH_PY,
  PYODIDE_INSTALL_PY,
  type RunResult,
  type RawStaticFinding,
  type TestRunResult,
} from "../common/pyodideRunner";
import {
  collectChangedWorkspaceFiles,
  ensureWorkDir,
  mountWorkspaceFiles,
  type MemFS,
} from "../common/memfsWorkspace";
import { waitForStdinLine } from "../common/stdinBuffer";
import type { RawReplCheck, WorkerInbound, WorkerOutbound } from "../common/workerProtocol";
import { installNodeXHR } from "./xhrPolyfill";

if (!parentPort) {
  throw new Error("desktop pyodide worker must be started as a worker_thread");
}

interface PyodideInstance {
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

let pyodideInstance: PyodideInstance | null = null;
let initPromise: Promise<void> | null = null;
let pytestPromise: Promise<void> | null = null;
let httpPatchPromise: Promise<void> | null = null;
let stdinBuffer: SharedArrayBuffer | null = null;

function post(msg: WorkerOutbound): void {
  parentPort!.postMessage(msg);
}

function emitDisplay(json: string): void {
  try {
    const payload = JSON.parse(String(json));
    post({ type: "display", payload });
  } catch {
    /* malformed payload: skip */
  }
}

function readStdin(): string | null {
  if (!stdinBuffer) {
    throw new Error("input() is unavailable (SharedArrayBuffer was not provided).");
  }
  return waitForStdinLine(stdinBuffer, () => {
    post({ type: "stdinRequest" });
  });
}

function enableLiveEmit(): void {
  pyodideInstance?.globals.set("_pll_live_emit", emitDisplay);
}

function disableLiveEmit(): void {
  pyodideInstance?.runPython("_pll_live_emit = None");
}

function ensureStdioFds(): void {
  const streams: Array<[NodeJS.ReadStream | NodeJS.WriteStream, number]> = [
    [process.stdin, 0],
    [process.stdout, 1],
    [process.stderr, 2],
  ];
  for (const [stream, fd] of streams) {
    if (stream && (stream as { fd?: number }).fd == null) {
      Object.defineProperty(stream, "fd", { value: fd });
    }
  }
}

async function ensurePyodide(indexUrl: string): Promise<void> {
  if (pyodideInstance) {
    return;
  }
  if (!initPromise) {
    initPromise = (async () => {
      ensureStdioFds();
      installNodeXHR();
      const { loadPyodide } = await import("pyodide");
      pyodideInstance = (await loadPyodide({ indexURL: indexUrl })) as unknown as PyodideInstance;
      pyodideInstance.setStdin({ stdin: readStdin, autoEOF: true });
      pyodideInstance.runPython(PYODIDE_BOOTSTRAP_PY);
      pyodideInstance.runPython(PLL_IMAGE_LIB_PY);
      pyodideInstance.runPython(PLL_TABLE_LIB_PY);
      pyodideInstance.runPython(PYODIDE_INSTALL_PY);
      ensureWorkDir(pyodideInstance.FS);
    })();
  }
  await initPromise;
}

async function ensureHttpShim(): Promise<void> {
  if (!pyodideInstance) {
    throw new Error("Pyodide not initialized");
  }
  if (!httpPatchPromise) {
    installNodeXHR();
    const pyodide = pyodideInstance;
    httpPatchPromise = pyodide.loadPackage("pyodide-http").then(() => {
      pyodide.runPython(PYODIDE_HTTP_PATCH_PY);
    });
  }
  await httpPatchPromise;
}

async function ensurePytest(): Promise<void> {
  if (!pyodideInstance) {
    throw new Error("Pyodide not initialized");
  }
  if (!pytestPromise) {
    pytestPromise = pyodideInstance.loadPackage("pytest").then(() => undefined);
  }
  await pytestPromise;
}

function callPyFunction<T>(name: string, args: unknown[]): T {
  if (!pyodideInstance) {
    throw new Error("Pyodide not initialized");
  }
  const fn = pyodideInstance.globals.get(name);
  try {
    const proxy = fn(...args);
    const result = proxy.toJs({ dict_converter: Object.fromEntries }) as T;
    proxy.destroy?.();
    return result;
  } finally {
    fn.destroy?.();
  }
}

parentPort.on("message", async (data: WorkerInbound) => {
  try {
    switch (data.type) {
      case "init": {
        stdinBuffer = data.stdinBuffer ?? null;
        await ensurePyodide(data.indexUrl);
        post({ id: data.id, type: "ready" });
        break;
      }
      case "runFile": {
        enableLiveEmit();
        try {
          const result = callPyFunction<RunResult>("_pll_run_file", [
            data.code,
            data.fileName,
            data.sessionKey,
          ]);
          result.displays = [];
          post({ id: data.id, type: "result", result });
        } finally {
          disableLiveEmit();
        }
        break;
      }
      case "replEval": {
        const result = callPyFunction<RunResult>("_pll_repl_eval", [
          data.code,
          data.sessionKey,
        ]);
        post({ id: data.id, type: "result", result });
        break;
      }
      case "checkSyntax": {
        const result = callPyFunction<RawReplCheck>("_pll_repl_check", [data.code]);
        post({ id: data.id, type: "syntax", result });
        break;
      }
      case "hasTests": {
        if (!pyodideInstance) {
          throw new Error("Pyodide not initialized");
        }
        const fn = pyodideInstance.globals.get("_pll_has_tests");
        try {
          post({ id: data.id, type: "hasTests", result: Boolean(fn(data.code)) });
        } finally {
          fn.destroy?.();
        }
        break;
      }
      case "loadPackages": {
        if (!pyodideInstance) {
          throw new Error("Pyodide not initialized");
        }
        await pyodideInstance.loadPackagesFromImports(data.code);
        if (NETWORK_IMPORT_RE.test(data.code)) {
          await ensureHttpShim();
        }
        post({ id: data.id, type: "packagesReady" });
        break;
      }
      case "loadPytest": {
        await ensurePytest();
        post({ id: data.id, type: "pytestReady" });
        break;
      }
      case "runTests": {
        await ensurePytest();
        const result = callPyFunction<TestRunResult>("_pll_run_tests", [
          data.code,
          data.fileName,
        ]);
        post({ id: data.id, type: "testResult", result });
        break;
      }
      case "staticAnalyze": {
        const result =
          callPyFunction<RawStaticFinding[]>("_pll_static_analyze", [
            data.code,
            data.level,
            data.fileName,
            data.sessionKey ?? null,
          ]) ?? [];
        post({ id: data.id, type: "static", result });
        break;
      }
      case "mountWorkspace": {
        if (!pyodideInstance) {
          throw new Error("Pyodide not initialized");
        }
        mountWorkspaceFiles(pyodideInstance.FS, data.files);
        post({ id: data.id, type: "workspaceReady" });
        break;
      }
      case "collectWorkspace": {
        if (!pyodideInstance) {
          throw new Error("Pyodide not initialized");
        }
        const files = collectChangedWorkspaceFiles(pyodideInstance.FS);
        post({ id: data.id, type: "workspaceFiles", files });
        break;
      }
    }
  } catch (err) {
    post({
      id: data.id,
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});
