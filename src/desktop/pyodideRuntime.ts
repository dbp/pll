import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { deliverDisplay, deliverRunResult, deliverTestResult } from "../common/deliverResult";
import type { RunResult, RawStaticFinding, TestRunResult } from "../common/pyodideRunner";
import { tryCreateStdinBuffer, writeStdinLine } from "../common/stdinBuffer";
import type {
  ExecutionEventHandler,
  PythonRuntime,
  ReplCheckResult,
  ReplEvalRequest,
  RunFileRequest,
  StaticAnalyzeRequest,
} from "../common/types";
import type { WorkspaceFile } from "../common/workspaceFilePolicy";
import type { RawReplCheck, WorkerInbound, WorkerOutbound } from "../common/workerProtocol";

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type WorkerInboundPayload = DistributiveOmit<WorkerInbound, "id">;
type AnyReply =
  | "ready"
  | "packagesReady"
  | "pytestReady"
  | boolean
  | RunResult
  | RawReplCheck
  | RawStaticFinding[]
  | TestRunResult
  | "workspaceReady"
  | WorkspaceFile[];

interface Pending {
  resolve: (value: AnyReply) => void;
  reject: (err: Error) => void;
}

function hasPyodideAssets(dir: string): boolean {
  return fs.existsSync(path.join(dir, "pyodide.asm.wasm"));
}

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
 * Desktop Python runtime: Pyodide lives in a `worker_threads` Worker so
 * `input()` can block without freezing the extension host, and so live
 * output can stream the same way as the web worker.
 */
export class DesktopPyodideRuntime implements PythonRuntime {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private initPromise: Promise<void> | null = null;
  private stdinBuffer: SharedArrayBuffer | null = null;
  private stdinHandler: (() => Promise<string | null>) | null = null;
  private liveOnEvent: ExecutionEventHandler | null = null;
  private liveFileName = "";

  constructor(private readonly extensionPath: string) {}

  isReady(): boolean {
    return this.worker !== null;
  }

  async initialize(): Promise<void> {
    if (this.worker) {
      return;
    }
    if (!this.initPromise) {
      this.initPromise = this.doInitialize();
    }
    await this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const workerPath = path.join(this.extensionPath, "dist", "desktop", "pyodideWorker.js");
    const indexUrl = resolvePyodideIndexURL(this.extensionPath);

    this.worker = new Worker(workerPath);
    this.worker.on("message", (msg: WorkerOutbound) => {
      this.handleMessage(msg);
    });
    this.worker.on("error", (err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
    });

    this.stdinBuffer = tryCreateStdinBuffer();
    await this.send({
      type: "init",
      indexUrl,
      ...(this.stdinBuffer ? { stdinBuffer: this.stdinBuffer } : {}),
    });
  }

  async runFile(request: RunFileRequest, onEvent: ExecutionEventHandler): Promise<void> {
    await this.initialize();
    this.liveOnEvent = onEvent;
    this.liveFileName = request.fileName;
    try {
      const result = await this.send({
        type: "runFile",
        code: request.code,
        fileName: request.fileName,
        sessionKey: request.sessionKey,
      });
      deliverRunResult(result as RunResult, onEvent, request.fileName);
    } finally {
      this.liveOnEvent = null;
      this.liveFileName = "";
    }
  }

  async replEval(request: ReplEvalRequest, onEvent: ExecutionEventHandler): Promise<void> {
    await this.initialize();
    const result = await this.send({
      type: "replEval",
      code: request.code,
      sessionKey: request.sessionKey,
    });
    deliverRunResult(result as RunResult, onEvent, "<repl>");
  }

  async checkReplComplete(code: string): Promise<ReplCheckResult> {
    await this.initialize();
    const result = (await this.send({ type: "checkSyntax", code })) as RawReplCheck;
    return {
      status: result.status,
      errorType: result.error_type,
      message: result.message,
      lineNumber: result.lineno,
      offset: result.offset,
    };
  }

  async hasTests(code: string): Promise<boolean> {
    await this.initialize();
    return Boolean(await this.send({ type: "hasTests", code }));
  }

  async ensurePackages(code: string): Promise<void> {
    await this.initialize();
    await this.send({ type: "loadPackages", code });
  }

  async ensurePytest(): Promise<void> {
    await this.initialize();
    await this.send({ type: "loadPytest" });
  }

  async runTests(request: RunFileRequest, onEvent: ExecutionEventHandler): Promise<void> {
    await this.initialize();
    const result = await this.send({
      type: "runTests",
      code: request.code,
      fileName: request.fileName,
    });
    deliverTestResult(result as TestRunResult, onEvent, request.fileName);
  }

  async staticAnalyze(request: StaticAnalyzeRequest): Promise<RawStaticFinding[]> {
    await this.initialize();
    const result = (await this.send({
      type: "staticAnalyze",
      code: request.code,
      level: request.level,
      fileName: request.fileName,
      sessionKey: request.sessionKey,
    })) as RawStaticFinding[];
    return result ?? [];
  }

  async mountWorkspaceFiles(files: WorkspaceFile[]): Promise<void> {
    await this.initialize();
    await this.send({ type: "mountWorkspace", files });
  }

  async collectWorkspaceFiles(): Promise<WorkspaceFile[]> {
    await this.initialize();
    return (await this.send({ type: "collectWorkspace" })) as WorkspaceFile[];
  }

  dispose(): void {
    void this.worker?.terminate();
    this.worker = null;
    this.initPromise = null;
    this.stdinBuffer = null;
    this.liveOnEvent = null;
    for (const pending of this.pending.values()) {
      pending.reject(new Error("Runtime disposed"));
    }
    this.pending.clear();
  }

  setStdinHandler(handler: (() => Promise<string | null>) | null): void {
    this.stdinHandler = handler;
  }

  private send(msg: WorkerInboundPayload): Promise<AnyReply> {
    if (!this.worker) {
      return Promise.reject(new Error("Worker not initialized"));
    }
    const id = this.nextId++;
    const promise = new Promise<AnyReply>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.worker.postMessage({ id, ...msg } as WorkerInbound);
    return promise;
  }

  private handleMessage(msg: WorkerOutbound): void {
    if (msg.type === "display") {
      if (this.liveOnEvent) {
        deliverDisplay(msg.payload, this.liveOnEvent, this.liveFileName);
      }
      return;
    }
    if (msg.type === "stdinRequest") {
      void this.handleStdinRequest();
      return;
    }
    const pending = this.pending.get(msg.id);
    if (!pending) {
      return;
    }
    this.pending.delete(msg.id);
    switch (msg.type) {
      case "ready":
        pending.resolve("ready");
        break;
      case "result":
        pending.resolve(msg.result);
        break;
      case "syntax":
        pending.resolve(msg.result);
        break;
      case "hasTests":
        pending.resolve(msg.result);
        break;
      case "packagesReady":
        pending.resolve("packagesReady");
        break;
      case "pytestReady":
        pending.resolve("pytestReady");
        break;
      case "testResult":
        pending.resolve(msg.result);
        break;
      case "static":
        pending.resolve(msg.result);
        break;
      case "workspaceReady":
        pending.resolve("workspaceReady");
        break;
      case "workspaceFiles":
        pending.resolve(msg.files);
        break;
      case "error":
        pending.reject(new Error(msg.message));
        break;
    }
  }

  private async handleStdinRequest(): Promise<void> {
    let line: string | null = null;
    try {
      line = this.stdinHandler ? await this.stdinHandler() : null;
    } catch {
      line = null;
    }
    if (this.stdinBuffer) {
      writeStdinLine(this.stdinBuffer, line);
    }
  }
}
