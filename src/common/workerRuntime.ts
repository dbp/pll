import { deliverDisplay, deliverRunResult } from "./deliverResult";
import type {
  ExamplarBuildResult,
  ExamplarRunResult,
  RawStaticFinding,
  ReactorStepResult,
} from "./wire";
import { requestInterrupt, tryCreateInterruptBuffer } from "./interruptBuffer";
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
import { PythonLostError } from "./pythonLost";
import type { WorkspaceFile } from "./workspaceFilePolicy";

/** Why a request could not be sent: there is no Python to send it to. */
const NOT_RUNNING = "Python is not running.";

/** A spawned Pyodide worker, normalized across `worker_threads` and browser `Worker`. */
export interface WorkerHandle {
  post(msg: WorkerInbound): void;
  terminate(): void;
}

export interface WorkerHandlers {
  onMessage(msg: WorkerOutbound): void;
  onError(err: Error): void;
  /**
   * The worker has gone - crashed or was ended. Only a Node worker can say:
   * a browser `Worker` survives its own errors and has no exit event.
   */
  onExit?(): void;
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
  private packageNoteHandler: ((text: string, failed: boolean) => void) | null = null;
  private pythonLostHandler: (() => void) | null = null;
  /** Event sink for the in-flight run or reactor step, so live displays can stream. */
  private live: { onEvent: ExecutionEventHandler; fileName: string } | null = null;

  /** Start the worker and wire it to the given handlers. */
  protected abstract spawn(handlers: WorkerHandlers): WorkerHandle;
  /** Base URL / directory Pyodide loads its assets from. */
  protected abstract resolveIndexUrl(): string;

  /** Start the worker, once - or again, if the last attempt failed. */
  async initialize(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInitialize().catch((err: unknown) => {
        // A failed start is not remembered: the next run tries again, with
        // a fresh worker, instead of failing until the window is reloaded.
        this.initPromise = null;
        this.worker?.terminate();
        this.worker = null;
        throw err;
      });
    }
    await this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const indexUrl = this.resolveIndexUrl();
    const worker = this.spawn({
      onMessage: (msg) => this.handleMessage(msg, worker),
      onError: (err) => this.rejectAllPending(err),
      onExit: () => this.pythonLost(worker),
    });
    this.worker = worker;
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

  async examplarBuild(sources: string): Promise<ExamplarBuildResult> {
    await this.initialize();
    const { result } = await this.request({ type: "examplarBuild", sources }, "examplarBuilt");
    return result;
  }

  async examplarRun(testSource: string, bundle: string): Promise<ExamplarRunResult> {
    await this.initialize();
    const { result } = await this.request(
      { type: "examplarRun", testSource, bundle },
      "examplarRan",
    );
    return result;
  }

  async reactorStep(
    reactorId: string,
    event: string,
    output?: { onEvent: ExecutionEventHandler; fileName: string },
  ): Promise<ReactorStepResult> {
    await this.initialize();
    // The worker streams a step's output live, as it does a file run's.
    this.live = output ?? null;
    try {
      const { result } = await this.request(
        { type: "reactorStep", reactorId, event },
        "reactorFrame",
      );
      return result;
    } finally {
      this.live = null;
    }
  }

  async reactorSeek(reactorId: string, index: number): Promise<ReactorStepResult> {
    await this.initialize();
    const { result } = await this.request(
      { type: "reactorSeek", reactorId, index },
      "reactorFrame",
    );
    return result;
  }

  async reactorDispose(reactorId: string): Promise<void> {
    await this.initialize();
    await this.request({ type: "reactorDispose", reactorId }, "reactorDisposed");
  }

  async endSession(sessionKey: string): Promise<void> {
    // A Python that was never started has no sessions to forget, and one
    // started now would only be started to do nothing.
    if (!this.initPromise) return;
    await this.initialize();
    await this.request({ type: "endSession", sessionKey }, "sessionEnded");
  }

  interrupt(): boolean {
    if (!this.interruptBuffer) {
      return false;
    }
    // Retried until Python acknowledges it, but only while the requests
    // that were running when Stop was pressed are still running - so a
    // retry cannot carry over into whatever runs next.
    const running = new Set(this.pending.keys());
    requestInterrupt(this.interruptBuffer, () => {
      for (const id of running) {
        if (this.pending.has(id)) return true;
      }
      return false;
    });
    return true;
  }

  setPythonLostHandler(handler: (() => void) | null): void {
    this.pythonLostHandler = handler;
  }

  setPackageNoteHandler(handler: ((text: string, failed: boolean) => void) | null): void {
    this.packageNoteHandler = handler;
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
      // Started, and gone again before this was sent.
      throw new Error(NOT_RUNNING);
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

  private handleMessage(msg: WorkerOutbound, worker: WorkerHandle): void {
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
    if (msg.type === "packageNote") {
      // With no one to say it to, the host's own log rather than nowhere.
      if (this.packageNoteHandler) this.packageNoteHandler(msg.text, msg.failed);
      else console.error(msg.text);
      return;
    }
    if (msg.type === "error" && msg.finished) {
      this.pythonLost(worker);
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

  /**
   * Python is gone: the worker exited (only a Node worker can say so), or
   * the interpreter in it is finished and refuses everything. Either way
   * nothing sent to it can succeed. Fail what was waiting, end the worker,
   * and forget it, so that the next request starts a new Python.
   *
   * Every session's names went with the old one - but they were gone
   * already: this follows Python stopping by itself, and never ends a
   * Python that could still run. Whoever set `setPythonLostHandler` is told,
   * so that each file can say so rather than only the one that was running.
   */
  private pythonLost(worker: WorkerHandle): void {
    if (this.worker !== worker) return;
    this.rejectAllPending(new PythonLostError());
    this.worker = null;
    this.initPromise = null;
    this.live = null;
    worker.terminate();
    this.pythonLostHandler?.();
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
