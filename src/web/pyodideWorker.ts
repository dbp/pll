/// <reference lib="WebWorker" />
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

declare const self: DedicatedWorkerGlobalScope & {
  loadPyodide?: (config: { indexURL: string }) => Promise<PyodideInstance>;
};

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

function emitDisplay(json: string): void {
  try {
    const payload = JSON.parse(String(json));
    const reply: WorkerOutbound = { type: "display", payload };
    self.postMessage(reply);
  } catch {
    /* malformed payload: skip */
  }
}

function readStdin(): string | null {
  if (!stdinBuffer) {
    throw new Error(
      "input() needs cross-origin isolation (SharedArrayBuffer). " +
        "Use `pnpm run test-web` or a vscode.dev session that sets COI.",
    );
  }
  return waitForStdinLine(stdinBuffer, () => {
    const reply: WorkerOutbound = { type: "stdinRequest" };
    self.postMessage(reply);
  });
}

function enableLiveEmit(): void {
  if (!pyodideInstance) {
    return;
  }
  pyodideInstance.globals.set("_pll_live_emit", emitDisplay);
}

function disableLiveEmit(): void {
  if (!pyodideInstance) {
    return;
  }
  pyodideInstance.runPython("_pll_live_emit = None");
}

async function ensurePyodide(indexUrl: string): Promise<void> {
  if (pyodideInstance) {
    return;
  }
  if (!initPromise) {
    initPromise = (async () => {
      const normalized = indexUrl.endsWith("/") ? indexUrl : indexUrl + "/";
      self.importScripts(normalized + "pyodide.js");
      if (!self.loadPyodide) {
        throw new Error("loadPyodide not available after importScripts");
      }
      pyodideInstance = await self.loadPyodide({ indexURL: normalized });
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

self.onmessage = async (event: MessageEvent<WorkerInbound>) => {
  const data = event.data;
  try {
    switch (data.type) {
      case "init": {
        stdinBuffer = data.stdinBuffer ?? null;
        await ensurePyodide(data.indexUrl);
        const reply: WorkerOutbound = { id: data.id, type: "ready" };
        self.postMessage(reply);
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
          // Already streamed live; returning them again would duplicate.
          result.displays = [];
          const reply: WorkerOutbound = { id: data.id, type: "result", result };
          self.postMessage(reply);
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
        const reply: WorkerOutbound = { id: data.id, type: "result", result };
        self.postMessage(reply);
        break;
      }
      case "checkSyntax": {
        const result = callPyFunction<RawReplCheck>("_pll_repl_check", [data.code]);
        const reply: WorkerOutbound = { id: data.id, type: "syntax", result };
        self.postMessage(reply);
        break;
      }
      case "hasTests": {
        if (!pyodideInstance) {
          throw new Error("Pyodide not initialized");
        }
        const fn = pyodideInstance.globals.get("_pll_has_tests");
        try {
          const result = Boolean(fn(data.code));
          const reply: WorkerOutbound = { id: data.id, type: "hasTests", result };
          self.postMessage(reply);
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
        const reply: WorkerOutbound = { id: data.id, type: "packagesReady" };
        self.postMessage(reply);
        break;
      }
      case "loadPytest": {
        await ensurePytest();
        const reply: WorkerOutbound = { id: data.id, type: "pytestReady" };
        self.postMessage(reply);
        break;
      }
      case "runTests": {
        await ensurePytest();
        const result = callPyFunction<TestRunResult>("_pll_run_tests", [
          data.code,
          data.fileName,
        ]);
        const reply: WorkerOutbound = { id: data.id, type: "testResult", result };
        self.postMessage(reply);
        break;
      }
      case "staticAnalyze": {
        const result = callPyFunction<RawStaticFinding[]>("_pll_static_analyze", [
          data.code,
          data.level,
          data.fileName,
          data.sessionKey ?? null,
        ]) ?? [];
        const reply: WorkerOutbound = { id: data.id, type: "static", result };
        self.postMessage(reply);
        break;
      }
      case "mountWorkspace": {
        if (!pyodideInstance) {
          throw new Error("Pyodide not initialized");
        }
        mountWorkspaceFiles(pyodideInstance.FS, data.files);
        const mounted: WorkerOutbound = { id: data.id, type: "workspaceReady" };
        self.postMessage(mounted);
        break;
      }
      case "collectWorkspace": {
        if (!pyodideInstance) {
          throw new Error("Pyodide not initialized");
        }
        const files = collectChangedWorkspaceFiles(pyodideInstance.FS);
        const collected: WorkerOutbound = { id: data.id, type: "workspaceFiles", files };
        self.postMessage(collected);
        break;
      }
    }
  } catch (err) {
    const reply: WorkerOutbound = {
      id: data.id,
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(reply);
  }
};
