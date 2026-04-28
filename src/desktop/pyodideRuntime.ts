import * as path from "path";
import type { PyodideInterface } from "pyodide";
import {
  PYODIDE_BOOTSTRAP_PY,
  type BonnieRunResult,
  type RawStaticFinding,
} from "../common/pyodideRunner";
import type {
  ExecutionEventHandler,
  PythonRuntime,
  ReplCheckResult,
  ReplEvalRequest,
  RunFileRequest,
  StaticAnalyzeRequest,
} from "../common/types";

interface RawReplCheck {
  status: "complete" | "incomplete" | "invalid";
  error_type?: string;
  message?: string;
  lineno?: number;
  offset?: number;
}

function adaptReplCheck(raw: RawReplCheck): ReplCheckResult {
  return {
    status: raw.status,
    errorType: raw.error_type,
    message: raw.message,
    lineNumber: raw.lineno,
    offset: raw.offset,
  };
}

/**
 * Desktop Python runtime: loads Pyodide directly in the Node extension host.
 *
 * For MVP we run on the extension host thread; this is acceptable because the
 * extension host is already a separate process from the renderer. Long-term
 * we can migrate to a worker_thread for true isolation.
 */
export class DesktopPyodideRuntime implements PythonRuntime {
  private pyodide: PyodideInterface | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(private readonly extensionPath: string) {}

  isReady(): boolean {
    return this.pyodide !== null;
  }

  async initialize(): Promise<void> {
    if (this.pyodide) {
      return;
    }
    if (!this.initPromise) {
      this.initPromise = this.doInitialize();
    }
    await this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const pyodideModule = await import("pyodide");
    const indexURL = path.join(this.extensionPath, "node_modules", "pyodide");
    this.pyodide = await pyodideModule.loadPyodide({ indexURL });
    this.pyodide.runPython(PYODIDE_BOOTSTRAP_PY);
  }

  async runFile(request: RunFileRequest, onEvent: ExecutionEventHandler): Promise<void> {
    await this.initialize();
    if (!this.pyodide) {
      throw new Error("Pyodide failed to initialize");
    }
    const fn = this.pyodide.globals.get("_bonnie_run_file");
    try {
      const proxy = fn(request.code, request.fileName);
      const obj = proxy.toJs({ dict_converter: Object.fromEntries }) as BonnieRunResult;
      proxy.destroy?.();
      this.deliverResult(obj, onEvent, request.fileName);
    } finally {
      fn.destroy?.();
    }
  }

  async replEval(request: ReplEvalRequest, onEvent: ExecutionEventHandler): Promise<void> {
    await this.initialize();
    if (!this.pyodide) {
      throw new Error("Pyodide failed to initialize");
    }
    const fn = this.pyodide.globals.get("_bonnie_repl_eval");
    try {
      const proxy = fn(request.code);
      const obj = proxy.toJs({ dict_converter: Object.fromEntries }) as BonnieRunResult;
      proxy.destroy?.();
      this.deliverResult(obj, onEvent, "<repl>");
    } finally {
      fn.destroy?.();
    }
  }

  async checkReplComplete(code: string): Promise<ReplCheckResult> {
    await this.initialize();
    if (!this.pyodide) {
      throw new Error("Pyodide failed to initialize");
    }
    const fn = this.pyodide.globals.get("_bonnie_repl_check");
    try {
      const proxy = fn(code);
      const obj = proxy.toJs({ dict_converter: Object.fromEntries }) as RawReplCheck;
      proxy.destroy?.();
      return adaptReplCheck(obj);
    } finally {
      fn.destroy?.();
    }
  }

  async staticAnalyze(request: StaticAnalyzeRequest): Promise<RawStaticFinding[]> {
    await this.initialize();
    if (!this.pyodide) {
      throw new Error("Pyodide failed to initialize");
    }
    const fn = this.pyodide.globals.get("_bonnie_static_analyze");
    try {
      const proxy = fn(request.code, request.level, request.fileName);
      const obj = proxy.toJs({ dict_converter: Object.fromEntries }) as RawStaticFinding[];
      proxy.destroy?.();
      return obj ?? [];
    } finally {
      fn.destroy?.();
    }
  }

  private deliverResult(
    result: BonnieRunResult,
    onEvent: ExecutionEventHandler,
    fileName: string,
  ): void {
    if (result.stdout) {
      onEvent({ kind: "stdout", text: result.stdout });
    }
    if (result.stderr) {
      onEvent({ kind: "stderr", text: result.stderr });
    }
    if (result.result_repr !== null && result.result_repr !== undefined) {
      onEvent({ kind: "result", repr: result.result_repr });
    }
    if (!result.ok && result.error_type) {
      onEvent({
        kind: "error",
        errorType: result.error_type,
        message: result.error_message ?? "",
        traceback: result.traceback ?? "",
        lineNumber: result.line_number,
        column: result.column,
        fileName,
      });
    }
    onEvent({ kind: "done" });
  }

  dispose(): void {
    this.pyodide = null;
    this.initPromise = null;
  }
}
