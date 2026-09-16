import { deliverDisplay, deliverRunResult, deliverTestResult } from "./deliverResult";
import type { RawStaticFinding } from "./pyodideRunner";
import { signalInterrupt, tryCreateInterruptBuffer } from "./interruptBuffer";
import { tryCreateStdinBuffer, writeStdinLine } from "./stdinBuffer";
import type {
  ExecutionEventHandler,
  PythonRuntime,
  ReplCheckResult,
  ReplEvalRequest,
  RunFileRequest,
  StaticAnalyzeRequest,
} from "./types";
import type { WorkerInbound, WorkerOutbound } from "./workerProtocol";
import type { WorkspaceFile } from "./workspaceFilePolicy";

/** A spawned Pyodide worker, normalized across `worker_threads` and browser `Worker`. */
export interface WorkerHandle {
  post(msg: WorkerInbound): void;
  terminate(): void;
}

export interface WorkerHandlers {
  onMessage(msg: WorkerOutbound): void;
  onError(err: Error): void;
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
/** A request as callers write it; `send` adds the correlation id. */
type Request = DistributiveOmit<WorkerInbound, "id">;
/** Replies that answer a specific request (as opposed to `display` / `stdinRequest`). */
type Reply = Extract<WorkerOutbound, { id: number }>;
type ReplyOf<T extends Reply["type"]> = Extract<Reply, { type: T }>;

interface Pending {
  resolve: (reply: Reply) => void;
  reject: (err: Error) => void;
}

/**
 * Host side of the Pyodide worker protocol: correlates request/reply ids,
 * streams live displays into the in-flight run, and services blocking
 * `input()` through the stdin SharedArrayBuffer.
 *
 * Everything host-specific (how to spawn the worker, where Pyodide's assets
 * live) is left to `spawn` / `resolveIndexUrl` in the desktop and web
 * subclasses; the protocol itself is identical on both.
 */
export abstract class WorkerPythonRuntime implements PythonRuntime {
  private worker: WorkerHandle | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private initPromise: Promise<void> | null = null;
  private stdinBuffer: SharedArrayBuffer | null = null;
  private interruptBuffer: SharedArrayBuffer | null = null;
  private stdinHandler: (() => Promise<string | null>) | null = null;
  /** Event sink for the in-flight runFile, so live displays can stream. */
  private live: { onEvent: ExecutionEventHandler; fileName: string } | null = null;

  /** Start the worker and wire it to the given handlers. */
  protected abstract spawn(handlers: WorkerHandlers): WorkerHandle;
  /** Base URL / directory Pyodide loads its assets from. */
  protected abstract resolveIndexUrl(): string;

  async initialize(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInitialize();
    }
    await this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const indexUrl = this.resolveIndexUrl();
    this.worker = this.spawn({
      onMessage: (msg) => this.handleMessage(msg),
      onError: (err) => this.rejectAllPending(err),
    });
    this.stdinBuffer = tryCreateStdinBuffer();
    this.interruptBuffer = tryCreateInterruptBuffer();
    await this.request(
      {
        type: "init",
        indexUrl,
        ...(this.stdinBuffer ? { stdinBuffer: this.stdinBuffer } : {}),
        ...(this.interruptBuffer ? { interruptBuffer: this.interruptBuffer } : {}),
      },
      "ready",
    );
  }

  async runFile(request: RunFileRequest, onEvent: ExecutionEventHandler): Promise<void> {
    await this.initialize();
    this.live = { onEvent, fileName: request.fileName };
    try {
      const { result } = await this.request({ type: "runFile", ...request }, "result");
      deliverRunResult(result, onEvent, request.fileName);
    } finally {
      this.live = null;
    }
  }

  async replEval(request: ReplEvalRequest, onEvent: ExecutionEventHandler): Promise<void> {
    await this.initialize();
    const { result } = await this.request({ type: "replEval", ...request }, "result");
    deliverRunResult(result, onEvent, "<repl>");
  }

  async checkReplComplete(code: string): Promise<ReplCheckResult> {
    await this.initialize();
    const { result } = await this.request({ type: "checkSyntax", code }, "syntax");
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
    const { result } = await this.request({ type: "hasTests", code }, "hasTests");
    return result;
  }

  async ensurePackages(code: string): Promise<void> {
    await this.initialize();
    await this.request({ type: "loadPackages", code }, "packagesReady");
  }

  async ensurePytest(): Promise<void> {
    await this.initialize();
    await this.request({ type: "loadPytest" }, "pytestReady");
  }

  async runTests(request: RunFileRequest, onEvent: ExecutionEventHandler): Promise<void> {
    await this.initialize();
    const { result } = await this.request(
      {
        type: "runTests",
        code: request.code,
        fileName: request.fileName,
        typeCheck: request.typeCheck,
        level: request.level,
      },
      "testResult",
    );
    deliverTestResult(result, onEvent, request.fileName);
  }

  async staticAnalyze(request: StaticAnalyzeRequest): Promise<RawStaticFinding[]> {
    await this.initialize();
    const { result } = await this.request({ type: "staticAnalyze", ...request }, "static");
    return result ?? [];
  }

  async mountWorkspaceFiles(files: WorkspaceFile[]): Promise<void> {
    await this.initialize();
    await this.request({ type: "mountWorkspace", files }, "workspaceReady");
  }

  async collectWorkspaceFiles(): Promise<WorkspaceFile[]> {
    await this.initialize();
    const { files } = await this.request({ type: "collectWorkspace" }, "workspaceFiles");
    return files;
  }

  interrupt(): boolean {
    if (!this.interruptBuffer) {
      return false;
    }
    signalInterrupt(this.interruptBuffer);
    return true;
  }

  setStdinHandler(handler: (() => Promise<string | null>) | null): void {
    this.stdinHandler = handler;
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.initPromise = null;
    this.stdinBuffer = null;
    this.interruptBuffer = null;
    this.live = null;
    this.rejectAllPending(new Error("Runtime disposed"));
  }

  /** Send `msg` and resolve with the reply, asserting it is of type `expected`. */
  private async request<T extends Reply["type"]>(
    msg: Request,
    expected: T,
  ): Promise<ReplyOf<T>> {
    const worker = this.worker;
    if (!worker) {
      throw new Error("Worker not initialized");
    }
    const id = this.nextId++;
    const reply = await new Promise<Reply>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.post({ id, ...msg } as WorkerInbound);
    });
    if (reply.type !== expected) {
      throw new Error(`Pyodide worker replied "${reply.type}", expected "${expected}"`);
    }
    return reply as ReplyOf<T>;
  }

  private handleMessage(msg: WorkerOutbound): void {
    if (msg.type === "display") {
      if (this.live) {
        deliverDisplay(msg.payload, this.live.onEvent, this.live.fileName);
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
    if (msg.type === "error") {
      pending.reject(new Error(msg.message));
    } else {
      pending.resolve(msg);
    }
  }

  private rejectAllPending(err: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(err);
    }
    this.pending.clear();
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
