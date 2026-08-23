import * as vscode from "vscode";
import { deliverRunResult, deliverTestResult } from "../common/deliverResult";
import type { RunResult, RawStaticFinding, TestRunResult } from "../common/pyodideRunner";
import type {
  ExecutionEventHandler,
  PythonRuntime,
  ReplCheckResult,
  ReplEvalRequest,
  RunFileRequest,
  StaticAnalyzeRequest,
} from "../common/types";
import type { RawReplCheck, WorkerInbound, WorkerOutbound } from "./pyodideWorker";

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type WorkerInboundPayload = DistributiveOmit<WorkerInbound, "id">;
type AnyReply = "ready" | "pytestReady" | boolean | RunResult | RawReplCheck | RawStaticFinding[] | TestRunResult;

interface Pending {
  resolve: (value: AnyReply) => void;
  reject: (err: Error) => void;
}

export class WebPyodideRuntime implements PythonRuntime {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private initPromise: Promise<void> | null = null;

  constructor(private readonly extensionUri: vscode.Uri) {}

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
    const workerUri = vscode.Uri.joinPath(this.extensionUri, "dist", "web", "pyodideWorker.js");
    const config = vscode.workspace.getConfiguration("pll");
    const indexUrl = config.get<string>("pyodideIndexUrl") ?? "https://cdn.jsdelivr.net/pyodide/v0.29.3/full/";

    this.worker = new Worker(workerUri.toString(true));
    this.worker.onmessage = (event: MessageEvent<WorkerOutbound>) => {
      this.handleMessage(event.data);
    };
    this.worker.onerror = (event) => {
      const error = new Error(`Pyodide worker error: ${event.message}`);
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
    };

    await this.send({ type: "init", indexUrl });
  }

  async runFile(request: RunFileRequest, onEvent: ExecutionEventHandler): Promise<void> {
    await this.initialize();
    const result = await this.send({
      type: "runFile",
      code: request.code,
      fileName: request.fileName,
      sessionKey: request.sessionKey,
    });
    deliverRunResult(result as RunResult, onEvent, request.fileName);
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
    })) as RawStaticFinding[];
    return result ?? [];
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.initPromise = null;
    for (const pending of this.pending.values()) {
      pending.reject(new Error("Runtime disposed"));
    }
    this.pending.clear();
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
      case "pytestReady":
        pending.resolve("pytestReady");
        break;
      case "testResult":
        pending.resolve(msg.result);
        break;
      case "static":
        pending.resolve(msg.result);
        break;
      case "error":
        pending.reject(new Error(msg.message));
        break;
    }
  }
}

