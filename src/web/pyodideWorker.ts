/// <reference lib="WebWorker" />
import {
  BONNIE_IMAGE_LIB_PY,
  BONNIE_TABLE_LIB_PY,
  PYODIDE_BOOTSTRAP_PY,
  PYODIDE_INSTALL_PY,
  type BonnieRunResult,
  type RawStaticFinding,
} from "../common/pyodideRunner";

declare const self: DedicatedWorkerGlobalScope & {
  loadPyodide?: (config: { indexURL: string }) => Promise<PyodideInstance>;
};

interface PyodideInstance {
  runPython(code: string): unknown;
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
  | { id: number; type: "staticAnalyze"; code: string; level: string; fileName: string };

export type WorkerOutbound =
  | { id: number; type: "ready" }
  | { id: number; type: "result"; result: BonnieRunResult }
  | { id: number; type: "syntax"; result: RawReplCheck }
  | { id: number; type: "static"; result: RawStaticFinding[] }
  | { id: number; type: "error"; message: string };

let pyodideInstance: PyodideInstance | null = null;
let initPromise: Promise<void> | null = null;

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
      pyodideInstance.runPython(BONNIE_IMAGE_LIB_PY);
      pyodideInstance.runPython(BONNIE_TABLE_LIB_PY);
      pyodideInstance.runPython(PYODIDE_INSTALL_PY);
    })();
  }
  await initPromise;
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
        const result = callPyFunction<BonnieRunResult>("_bonnie_run_file", [
          data.code,
          data.fileName,
          data.sessionKey,
        ]);
        const reply: WorkerOutbound = { id: data.id, type: "result", result };
        self.postMessage(reply);
        break;
      }
      case "replEval": {
        const result = callPyFunction<BonnieRunResult>("_bonnie_repl_eval", [
          data.code,
          data.sessionKey,
        ]);
        const reply: WorkerOutbound = { id: data.id, type: "result", result };
        self.postMessage(reply);
        break;
      }
      case "checkSyntax": {
        const result = callPyFunction<RawReplCheck>("_bonnie_repl_check", [data.code]);
        const reply: WorkerOutbound = { id: data.id, type: "syntax", result };
        self.postMessage(reply);
        break;
      }
      case "staticAnalyze": {
        const result = callPyFunction<RawStaticFinding[]>("_bonnie_static_analyze", [
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
