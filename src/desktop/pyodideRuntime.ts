import * as fs from "fs";
import * as path from "path";
import type { PyodideInterface } from "pyodide";
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
import { deliverRunResult, deliverTestResult } from "../common/deliverResult";
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

function hasPyodideAssets(dir: string): boolean {
  return fs.existsSync(path.join(dir, "pyodide.asm.wasm"));
}

/**
 * Published VSIX ships wasm/stdlib under vendor/pyodide. Local `pnpm run
 * build` copies the same files there; F5 before the first build can still
 * fall back to the npm package in node_modules.
 */
function resolvePyodideIndexURL(extensionPath: string): string {
  const candidates = [
    path.join(extensionPath, "vendor", "pyodide"),
    path.join(extensionPath, "node_modules", "pyodide"),
  ];
  const found = candidates.find(hasPyodideAssets);
  if (!found) {
    throw new Error(
      "Pyodide runtime assets not found. Run `pnpm run build` to copy them into vendor/pyodide.",
    );
  }
  return found;
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
  private pytestPromise: Promise<void> | null = null;
  private httpPatchPromise: Promise<void> | null = null;

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
    const indexURL = resolvePyodideIndexURL(this.extensionPath);
    this.pyodide = await pyodideModule.loadPyodide({ indexURL });
    this.pyodide.runPython(PYODIDE_BOOTSTRAP_PY);
    this.pyodide.runPython(PLL_IMAGE_LIB_PY);
    this.pyodide.runPython(PLL_TABLE_LIB_PY);
    this.pyodide.runPython(PYODIDE_INSTALL_PY);
    this.pyodide.runPython(`
def _pll_desktop_input(prompt=""):
    raise RuntimeError(
        "input() is not supported in desktop VS Code yet. "
        "Open this folder on vscode.dev to run interactive programs."
    )
_pll_initial_globals["input"] = _pll_desktop_input
`);
  }

  async runFile(request: RunFileRequest, onEvent: ExecutionEventHandler): Promise<void> {
    await this.initialize();
    if (!this.pyodide) {
      throw new Error("Pyodide failed to initialize");
    }
    const fn = this.pyodide.globals.get("_pll_run_file");
    try {
      const proxy = fn(request.code, request.fileName, request.sessionKey);
      const obj = proxy.toJs({ dict_converter: Object.fromEntries }) as RunResult;
      proxy.destroy?.();
      deliverRunResult(obj, onEvent, request.fileName);
    } finally {
      fn.destroy?.();
    }
  }

  async replEval(request: ReplEvalRequest, onEvent: ExecutionEventHandler): Promise<void> {
    await this.initialize();
    if (!this.pyodide) {
      throw new Error("Pyodide failed to initialize");
    }
    const fn = this.pyodide.globals.get("_pll_repl_eval");
    try {
      const proxy = fn(request.code, request.sessionKey);
      const obj = proxy.toJs({ dict_converter: Object.fromEntries }) as RunResult;
      proxy.destroy?.();
      deliverRunResult(obj, onEvent, "<repl>");
    } finally {
      fn.destroy?.();
    }
  }

  async checkReplComplete(code: string): Promise<ReplCheckResult> {
    await this.initialize();
    if (!this.pyodide) {
      throw new Error("Pyodide failed to initialize");
    }
    const fn = this.pyodide.globals.get("_pll_repl_check");
    try {
      const proxy = fn(code);
      const obj = proxy.toJs({ dict_converter: Object.fromEntries }) as RawReplCheck;
      proxy.destroy?.();
      return adaptReplCheck(obj);
    } finally {
      fn.destroy?.();
    }
  }

  async hasTests(code: string): Promise<boolean> {
    await this.initialize();
    if (!this.pyodide) {
      throw new Error("Pyodide failed to initialize");
    }
    const fn = this.pyodide.globals.get("_pll_has_tests");
    try {
      return Boolean(fn(code));
    } finally {
      fn.destroy?.();
    }
  }

  async ensurePackages(code: string): Promise<void> {
    await this.initialize();
    if (!this.pyodide) {
      throw new Error("Pyodide failed to initialize");
    }
    await this.pyodide.loadPackagesFromImports(code);
    if (NETWORK_IMPORT_RE.test(code)) {
      await this.ensureHttpShim();
    }
  }

  /** Load pyodide-http and patch urllib/requests, once per interpreter. */
  private async ensureHttpShim(): Promise<void> {
    if (!this.pyodide) {
      return;
    }
    if (!this.httpPatchPromise) {
      const pyodide = this.pyodide;
      this.httpPatchPromise = pyodide.loadPackage("pyodide-http").then(() => {
        pyodide.runPython(PYODIDE_HTTP_PATCH_PY);
      });
    }
    await this.httpPatchPromise;
  }

  async ensurePytest(): Promise<void> {
    await this.initialize();
    if (!this.pyodide) {
      throw new Error("Pyodide failed to initialize");
    }
    if (!this.pytestPromise) {
      this.pytestPromise = this.pyodide.loadPackage("pytest").then(() => undefined);
    }
    await this.pytestPromise;
  }

  async runTests(request: RunFileRequest, onEvent: ExecutionEventHandler): Promise<void> {
    await this.ensurePytest();
    if (!this.pyodide) {
      throw new Error("Pyodide failed to initialize");
    }
    const fn = this.pyodide.globals.get("_pll_run_tests");
    try {
      const proxy = fn(request.code, request.fileName);
      const obj = proxy.toJs({ dict_converter: Object.fromEntries }) as TestRunResult;
      proxy.destroy?.();
      deliverTestResult(obj, onEvent, request.fileName);
    } finally {
      fn.destroy?.();
    }
  }

  async staticAnalyze(request: StaticAnalyzeRequest): Promise<RawStaticFinding[]> {
    await this.initialize();
    if (!this.pyodide) {
      throw new Error("Pyodide failed to initialize");
    }
    const fn = this.pyodide.globals.get("_pll_static_analyze");
    try {
      const proxy = fn(
        request.code,
        request.level,
        request.fileName,
        request.sessionKey ?? null,
      );
      const obj = proxy.toJs({ dict_converter: Object.fromEntries }) as RawStaticFinding[];
      proxy.destroy?.();
      return obj ?? [];
    } finally {
      fn.destroy?.();
    }
  }

  dispose(): void {
    this.pyodide = null;
    this.initPromise = null;
    this.pytestPromise = null;
    this.httpPatchPromise = null;
  }

  setStdinHandler(_handler: (() => Promise<string | null>) | null): void {
    // Desktop runs Pyodide on the extension-host thread; blocking there
    // would freeze VS Code. input() is overridden at init to raise instead.
  }
}
