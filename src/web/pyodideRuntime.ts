import * as vscode from "vscode";
import type { BonnieRunResult } from "../common/pyodideRunner";
import type {
  ExecutionEventHandler,
  PythonRuntime,
  ReplEvalRequest,
  RunFileRequest,
} from "../common/types";
import type { WorkerInbound, WorkerOutbound } from "./pyodideWorker";

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type WorkerInboundPayload = DistributiveOmit<WorkerInbound, "id">;

interface Pending {
  resolve: (value: BonnieRunResult | "ready") => void;
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
    const config = vscode.workspace.getConfiguration("bonniePython");
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
    });
    if (result === "ready") {
      throw new Error("Unexpected ready response from runFile");
    }
    deliverResult(result, onEvent, request.fileName);
  }

  async replEval(request: ReplEvalRequest, onEvent: ExecutionEventHandler): Promise<void> {
    await this.initialize();
    const result = await this.send({ type: "replEval", code: request.code });
    if (result === "ready") {
      throw new Error("Unexpected ready response from replEval");
    }
    deliverResult(result, onEvent, "<repl>");
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

  private send(msg: WorkerInboundPayload): Promise<BonnieRunResult | "ready"> {
    if (!this.worker) {
      return Promise.reject(new Error("Worker not initialized"));
    }
    const id = this.nextId++;
    const promise = new Promise<BonnieRunResult | "ready">((resolve, reject) => {
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
      case "error":
        pending.reject(new Error(msg.message));
        break;
    }
  }
}

function deliverResult(
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
