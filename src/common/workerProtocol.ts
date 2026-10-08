import type {
  DisplayData,
  ExamplarBuildResult,
  ExamplarRunResult,
  RawReplCheck,
  RawStaticFinding,
  ReactorStepResult,
  RunResult,
} from "./wire";
import type { Level } from "./level";
import type { WorkspaceChanges, WorkspaceFile } from "./workspaceFilePolicy";

export type WorkerInbound =
  | {
      id: number;
      type: "init";
      indexUrl: string;
      /** Node only: where downloaded packages are kept, when not beside Pyodide. */
      packageCacheDir?: string;
      stdinBuffer?: SharedArrayBuffer;
      interruptBuffer?: SharedArrayBuffer;
    }
  | {
      id: number;
      type: "runFile";
      code: string;
      fileName: string;
      sessionKey: string;
      /** Language level; the only input deciding what gets checked. */
      level?: Level;
      /** Run the file's tests once it finishes; pytest must be loaded. */
      withTests?: boolean;
    }
  | {
      id: number;
      type: "replEval";
      code: string;
      sessionKey: string;
      level?: Level;
    }
  | { id: number; type: "checkSyntax"; code: string; whole?: boolean }
  | { id: number; type: "loadPackages"; code: string }
  | { id: number; type: "hasTests"; code: string }
  | { id: number; type: "loadPytest" }
  | { id: number; type: "staticAnalyze"; code: string; level: Level; fileName: string; sessionKey?: string }
  | { id: number; type: "mountWorkspace"; files: WorkspaceFile[] }
  | { id: number; type: "collectWorkspace" }
  /** Apply one event (tick / key / mouse / receive) to a running reactor. */
  | { id: number; type: "reactorStep"; reactorId: string; event: string }
  /** Show an earlier or later frame without applying an event. */
  | { id: number; type: "reactorSeek"; reactorId: string; index: number }
  | { id: number; type: "reactorDispose"; reactorId: string }
  /** Forget a session's names; its file was closed. */
  | { id: number; type: "endSession"; sessionKey: string }
  /** Compile wheats and chaffs into a bundle (authoring). */
  | { id: number; type: "examplarBuild"; sources: string }
  /** Run a student's tests against every implementation in a bundle. */
  | { id: number; type: "examplarRun"; testSource: string; bundle: string; fileName: string };

export type WorkerOutbound =
  | { id: number; type: "ready" }
  | { id: number; type: "result"; result: RunResult }
  | { id: number; type: "syntax"; result: RawReplCheck }
  | { id: number; type: "hasTests"; result: boolean }
  | { id: number; type: "packagesReady" }
  | { id: number; type: "pytestReady" }
  | { id: number; type: "static"; result: RawStaticFinding[] }
  | { id: number; type: "workspaceReady" }
  | { id: number; type: "workspaceFiles"; changes: WorkspaceChanges }
  | { id: number; type: "reactorFrame"; result: ReactorStepResult }
  | { id: number; type: "reactorDisposed" }
  | { id: number; type: "sessionEnded" }
  | { id: number; type: "examplarBuilt"; result: ExamplarBuildResult }
  | { id: number; type: "examplarRan"; result: ExamplarRunResult }
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

/** The replies that answer a request, as opposed to output and notes. */
export type WorkerReply = Extract<WorkerOutbound, { id: number }>;

/**
 * The reply each request is answered with when it succeeds. Both ends are
 * typed from it: the worker's handler for a request returns this reply, and
 * the runtime waits for it.
 */
export const REPLY_TO = {
  init: "ready",
  runFile: "result",
  replEval: "result",
  checkSyntax: "syntax",
  loadPackages: "packagesReady",
  hasTests: "hasTests",
  loadPytest: "pytestReady",
  staticAnalyze: "static",
  mountWorkspace: "workspaceReady",
  collectWorkspace: "workspaceFiles",
  reactorStep: "reactorFrame",
  reactorSeek: "reactorFrame",
  reactorDispose: "reactorDisposed",
  endSession: "sessionEnded",
  examplarBuild: "examplarBuilt",
  examplarRun: "examplarRan",
} as const satisfies Record<WorkerInbound["type"], WorkerReply["type"]>;

/** The reply to a request of type `T`. */
export type ReplyFor<T extends WorkerInbound["type"]> = Extract<
  WorkerReply,
  { type: (typeof REPLY_TO)[T] }
>;
