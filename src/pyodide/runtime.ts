import {
  interruptStdin,
  requestInterrupt,
  tryCreateInterruptBuffer,
  tryCreateStdinBuffer,
  writeStdin,
} from "./sharedMemory";
import type { DisplayData, ExecutionEventHandler } from "../run/types";
import type { Requests, RequestType, WorkerInbound, WorkerOutbound } from "./protocol";

/** Why a request could not be sent: there is no Python to send it to. */
const NOT_RUNNING = "Python is not running.";

/**
 * Python is gone: its worker stopped, or the interpreter inside can no
 * longer run (after a fatal error Pyodide refuses every later call). The
 * request that was waiting fails with this, and the next one starts a new
 * Python - in which every session starts empty.
 */
export class PythonLostError extends Error {
  constructor() {
    super("Python stopped completely.");
    this.name = "PythonLostError";
  }
}

/** A Stop ended the request, in Python (`KeyboardInterrupt`). */
export class StoppedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoppedError";
  }
}

/** A spawned Pyodide worker, normalized across `worker_threads` and browser `Worker`. */
export interface WorkerHandle {
  post(msg: WorkerInbound): void;
  terminate(): void;
}

export interface WorkerHandlers {
  onMessage(msg: WorkerOutbound): void;
  /** The worker raised outside a request, and lives on: a browser `Worker`'s `error`. */
  onError(err: Error): void;
  /**
   * The worker has gone - crashed or was ended. Only a Node worker can say:
   * a browser `Worker` survives its own errors and has no exit event.
   */
  onExit?(): void;
}

/** What a host says about its worker; the protocol is the same on every one. */
export interface WorkerOptions {
  /** Start the worker and wire it to the given handlers. */
  spawn(handlers: WorkerHandlers): WorkerHandle;
  /** The base URL or directory Pyodide loads its assets from. */
  indexUrl(): string;
  /** Where downloaded packages are kept, if not beside Pyodide's assets. */
  packageCacheDir?(indexUrl: string): string | undefined;
  /**
   * Longest Python may take to start; no limit when absent. Pyodide that
   * fails to load can report it and never settle; a host with no one to
   * press Stop - an autograder - sets one.
   */
  startTimeoutMs?: number;
}

/** Where a request's live output goes, while it runs. */
export interface LiveOutput {
  onEvent: ExecutionEventHandler;
  fileName: string;
}

/** One display, as the event it is: an image or a table captioned with the file that made it. */
export function deliverDisplay(display: DisplayData, onEvent: ExecutionEventHandler, fileName: string): void {
  onEvent(display.kind === "image" || display.kind === "table" ? { ...display, source: fileName } : display);
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  live: LiveOutput | null;
}

/**
 * Host side of the Pyodide worker protocol: starts the worker, correlates
 * request/reply ids, streams live displays into the in-flight run, services
 * blocking `input()` through the stdin SharedArrayBuffer, and stops Python
 * through the interrupt one. `Python` (`run/python.ts`) is the calls into
 * Python made over it.
 */
export class WorkerConnection {
  private worker: WorkerHandle | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private initPromise: Promise<void> | null = null;
  private stdinBuffer: SharedArrayBuffer | null = null;
  private interruptBuffer: SharedArrayBuffer | null = null;
  private stdinHandler: (() => Promise<string | Uint8Array | null>) | null = null;
  /** The stdin request being answered, or null; a Stop ends it. */
  private stdinRequest: number | null = null;
  /** Stdin read but not yet given: what did not fit, or what came after a Stop. */
  private stdinCarry: Uint8Array = new Uint8Array(0);
  /** The handler's answer being waited for, which the next request shares. */
  private stdinNext: Promise<Uint8Array | null> | null = null;
  private packageNoteHandler: ((text: string, failed: boolean) => void) | null = null;
  private pythonLostHandler: (() => void) | null = null;

  constructor(private readonly options: WorkerOptions) {}

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
    const indexUrl = this.options.indexUrl();
    const worker = this.options.spawn({
      onMessage: (msg) => this.handleMessage(msg, worker),
      onError: (err) => this.rejectAllPending(err),
      onExit: () => this.pythonLost(worker),
    });
    this.worker = worker;
    this.stdinBuffer = tryCreateStdinBuffer();
    this.interruptBuffer = tryCreateInterruptBuffer();
    const packageCacheDir = this.options.packageCacheDir?.(indexUrl);
    const started = this.send("init", {
      indexUrl,
      ...(packageCacheDir ? { packageCacheDir } : {}),
      ...(this.stdinBuffer ? { stdinBuffer: this.stdinBuffer } : {}),
      ...(this.interruptBuffer ? { interruptBuffer: this.interruptBuffer } : {}),
    });
    const limit = this.options.startTimeoutMs;
    if (limit === undefined) {
      await started;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Python did not start within ${Math.round(limit / 1000)} seconds`)),
        limit,
      );
    });
    try {
      await Promise.race([started, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Whether Python has been started, or is starting. */
  protected get started(): boolean {
    return this.initPromise !== null;
  }

  /** A request, once Python has started; `live` is where its output goes as it runs. */
  protected async request<T extends RequestType>(
    type: T,
    fields: Requests[T]["send"],
    live: LiveOutput | null = null,
  ): Promise<Requests[T]["reply"]> {
    await this.initialize();
    return this.send(type, fields, live);
  }

  /** `fn(*args)` in Python, and what it returns; `live` streams its output. */
  protected async call<Result>(fn: string, args: unknown[], live?: LiveOutput): Promise<Result> {
    return (await this.request("call", { fn, args, live: live !== undefined }, live ?? null)) as Result;
  }

  /**
   * Ask a running program to stop, by raising `KeyboardInterrupt` at the
   * interpreter's next bytecode check. Synchronous on purpose: the worker is
   * blocked inside `runPython` and would not read a message until it
   * returned. Returns false when there is no interrupt channel (no
   * `SharedArrayBuffer`), so callers can say so rather than appear to work.
   */
  interrupt(): boolean {
    if (!this.interruptBuffer) {
      return false;
    }
    // A program waiting for stdin runs no bytecode to see the Stop: end
    // the wait, and the read raises it.
    if (this.stdinBuffer && this.stdinRequest !== null) {
      this.stdinRequest = null;
      interruptStdin(this.stdinBuffer);
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

  /**
   * Told when Python had to be replaced - its worker stopped, or it could
   * no longer run - and so every session's names are gone. The request in
   * flight fails with `PythonLostError`; the next starts a new Python.
   */
  setPythonLostHandler(handler: (() => void) | null): void {
    this.pythonLostHandler = handler;
  }

  /**
   * Who hears what Pyodide says while it loads a package: "Loading pytest,
   * ..." or, `failed`, why it could not. Without one, the host's log.
   */
  setPackageNoteHandler(handler: ((text: string, failed: boolean) => void) | null): void {
    this.packageNoteHandler = handler;
  }

  /**
   * Register the handler asked for the next of stdin when a running program
   * reads it - `input()`, `sys.stdin.read()`. It resolves with the next text
   * or bytes, exactly as the program should read them (a line typed is that
   * line and its newline), or `null` at the end of stdin. The worker waits
   * until it does, or until a Stop, which raises `KeyboardInterrupt` in the
   * read.
   */
  setStdinHandler(handler: (() => Promise<string | Uint8Array | null>) | null): void {
    this.stdinHandler = handler;
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.initPromise = null;
    this.stdinBuffer = null;
    this.interruptBuffer = null;
    this.rejectAllPending(new Error("Runtime disposed"));
  }

  /** Send a request to the worker as it is now, and resolve with its reply. */
  private send<T extends RequestType>(
    type: T,
    fields: Requests[T]["send"],
    live: LiveOutput | null = null,
  ): Promise<Requests[T]["reply"]> {
    const worker = this.worker;
    if (!worker) {
      // Started, and gone again before this was sent.
      return Promise.reject(new Error(NOT_RUNNING));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, live });
      worker.post({ id, type, ...fields } as WorkerInbound);
    });
  }

  private handleMessage(msg: WorkerOutbound, worker: WorkerHandle): void {
    if (msg.type === "display") {
      const live = this.pending.get(msg.requestId)?.live;
      if (live) {
        deliverDisplay(msg.payload, live.onEvent, live.fileName);
      }
      return;
    }
    if (msg.type === "stdinRequest") {
      void this.handleStdinRequest(msg.request);
      return;
    }
    if (msg.type === "packageNote") {
      // With no one to say it to, the host's own log rather than nowhere.
      if (this.packageNoteHandler) this.packageNoteHandler(msg.text, msg.failed);
      else console.error(msg.text);
      return;
    }
    if (msg.type === "error" && msg.kind === "finished") {
      this.pythonLost(worker);
      return;
    }
    const pending = this.pending.get(msg.id);
    if (!pending) {
      return;
    }
    this.pending.delete(msg.id);
    if (msg.type === "error") {
      pending.reject(msg.kind === "interrupted" ? new StoppedError(msg.message) : new Error(msg.message));
    } else {
      pending.resolve(msg.value);
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
    worker.terminate();
    this.pythonLostHandler?.();
  }

  private rejectAllPending(err: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(err);
    }
    this.pending.clear();
  }

  /**
   * The next of stdin from the handler. One call at a time: a request a
   * Stop ended leaves its call waiting, and the next request - a program
   * that caught the `KeyboardInterrupt` and asked again - shares it, so
   * the line typed answers that one.
   */
  private nextStdin(): Promise<Uint8Array | null> {
    if (this.stdinNext === null) {
      const call = (async () => {
        try {
          const next = this.stdinHandler ? await this.stdinHandler() : null;
          return typeof next === "string" ? new TextEncoder().encode(next) : next;
        } catch {
          return null;
        }
      })();
      this.stdinNext = call;
      void call.then(() => {
        if (this.stdinNext === call) this.stdinNext = null;
      });
    }
    return this.stdinNext;
  }

  private async handleStdinRequest(request: number): Promise<void> {
    this.stdinRequest = request;
    let bytes: Uint8Array | null = this.stdinCarry;
    if (bytes.length === 0) {
      bytes = await this.nextStdin();
      if (this.stdinRequest !== request) {
        // A Stop ended the wait. A request since then shares this answer;
        // with none, it is the next of stdin, as a line typed after Ctrl+C
        // is in a terminal.
        if (bytes !== null && this.stdinRequest === null) {
          this.stdinCarry = concatBytes(this.stdinCarry, bytes);
        }
        return;
      }
    }
    this.stdinRequest = null;
    if (!this.stdinBuffer) {
      return;
    }
    const given = writeStdin(this.stdinBuffer, request, bytes);
    if (bytes === null) {
      this.stdinCarry = new Uint8Array(0);
    } else {
      // What did not fit - or, when the wait had ended, all of it.
      this.stdinCarry = bytes.subarray(Math.max(given, 0));
    }
  }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
