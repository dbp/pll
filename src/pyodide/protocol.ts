import type { DisplayData } from "../run/types";
import type { LeftOut, WorkspaceChanges, WorkspaceFile } from "../core/files";

/**
 * What the host asks the worker, and what a success is answered with. A
 * call into Python is a `call`, naming the function; the other four do what
 * Python in the worker cannot do for itself: start Pyodide, load packages,
 * and move the files beside the program in and out of MEMFS. The functions
 * a `call` names, and what each returns, are in `run/python.ts`.
 */
export interface Requests {
  init: {
    send: {
      indexUrl: string;
      /** Node only: where downloaded packages are kept, when not beside Pyodide. */
      packageCacheDir?: string;
      stdinBuffer?: SharedArrayBuffer;
      interruptBuffer?: SharedArrayBuffer;
    };
    reply: null;
  };
  /** `fn(*args)` in Python. `live`: its output streams to the host as it runs. */
  call: { send: { fn: string; args: unknown[]; live: boolean }; reply: unknown };
  /**
   * Load the packages Pyodide has for these modules; `network` routes
   * `urllib` and `requests` through the host's network. Fails if Pyodide
   * could not load one.
   */
  load: { send: { modules: string[]; network: boolean }; reply: null };
  mount: { send: { files: WorkspaceFile[]; leftOut: LeftOut[] }; reply: null };
  collect: { send: Record<string, never>; reply: WorkspaceChanges };
}

export type RequestType = keyof Requests;

export type WorkerInbound = {
  [T in RequestType]: { id: number; type: T } & Requests[T]["send"];
}[RequestType];

export type WorkerOutbound =
  | { id: number; type: "reply"; value: unknown }
  | { id: number; type: "error"; message: string; kind: WorkerErrorKind }
  /** Output as the program produces it, for the request that is running. */
  | { type: "display"; requestId: number; payload: DisplayData }
  /** Pyodide saying what it is loading - or, `failed`, what went wrong. */
  | { type: "packageNote"; text: string; failed: boolean }
  /** Python is waiting for stdin: `request` is the number to answer it with. */
  | { type: "stdinRequest"; request: number };

/**
 * Why a request failed. `interrupted`: a Stop ended it. `finished`: the
 * interpreter can no longer run anything, in this worker. `failed`:
 * anything else.
 */
export type WorkerErrorKind = "failed" | "interrupted" | "finished";
