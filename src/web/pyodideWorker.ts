/// <reference lib="WebWorker" />
import {
  PLL_IMAGE_LIB_PY,
  PLL_TABLE_LIB_PY,
  PYODIDE_BOOTSTRAP_PY,
  PYODIDE_INSTALL_PY,
  type RunResult,
  type RawStaticFinding,
  type TestRunResult,
} from "../common/pyodideRunner";

declare const self: DedicatedWorkerGlobalScope & {
  loadPyodide?: (config: { indexURL: string }) => Promise<PyodideInstance>;
};

interface PyodideInstance {
  runPython(code: string): unknown;
  loadPackage(names: string | string[]): Promise<unknown>;
  globals: {
    get(name: string): PyCallable;
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

export interface RawReplCheck {
  status: "complete" | "incomplete" | "invalid";
  error_type?: string;
  message?: string;
  lineno?: number;
  offset?: number;
}

export type WorkerInbound =
  | { id: number; type: "init"; indexUrl: string }
  | { id: number; type: "runFile"; code: string; fileName: string; sessionKey: string }
  | { id: number; type: "replEval"; code: string; sessionKey: string }
  | { id: number; type: "checkSyntax"; code: string }
  | { id: number; type: "hasTests"; code: string }
  | { id: number; type: "loadPytest" }
  | { id: number; type: "runTests"; code: string; fileName: string }
  | { id: number; type: "staticAnalyze"; code: string; level: string; fileName: string };

export type WorkerOutbound =
  | { id: number; type: "ready" }
  | { id: number; type: "result"; result: RunResult }
  | { id: number; type: "syntax"; result: RawReplCheck }
  | { id: number; type: "hasTests"; result: boolean }
  | { id: number; type: "pytestReady" }
  | { id: number; type: "testResult"; result: TestRunResult }
  | { id: number; type: "static"; result: RawStaticFinding[] }
  | { id: number; type: "error"; message: string };

let pyodideInstance: PyodideInstance | null = null;
let initPromise: Promise<void> | null = null;
let pytestPromise: Promise<void> | null = null;

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
      pyodideInstance.runPython(PYODIDE_BOOTSTRAP_PY);
      pyodideInstance.runPython(PLL_IMAGE_LIB_PY);
      pyodideInstance.runPython(PLL_TABLE_LIB_PY);
      pyodideInstance.runPython(PYODIDE_INSTALL_PY);
    })();
  }
  await initPromise;
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
        await ensurePyodide(data.indexUrl);
        const reply: WorkerOutbound = { id: data.id, type: "ready" };
        self.postMessage(reply);
        break;
      }
      case "runFile": {
        const result = callPyFunction<RunResult>("_pll_run_file", [
          data.code,
          data.fileName,
          data.sessionKey,
        ]);
        const reply: WorkerOutbound = { id: data.id, type: "result", result };
        self.postMessage(reply);
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
        ]) ?? [];
        const reply: WorkerOutbound = { id: data.id, type: "static", result };
        self.postMessage(reply);
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
