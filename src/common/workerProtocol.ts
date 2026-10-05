import type {
  DisplayData,
  ExamplarBuildResult,
  ExamplarRunResult,
  RawStaticFinding,
  ReactorStepResult,
  RunResult,
} from "./wire";
import type { Level } from "./level";
import type { WorkspaceFile } from "./workspaceFilePolicy";

export interface RawReplCheck {
  status: "complete" | "incomplete" | "invalid";
  error_type?: string;
  message?: string;
  lineno?: number;
  offset?: number;
}

export type WorkerInbound =
  | {
      id: number;
      type: "init";
      indexUrl: string;
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
  | { id: number; type: "checkSyntax"; code: string }
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
  | { id: number; type: "examplarRun"; testSource: string; bundle: string };

export type WorkerOutbound =
  | { id: number; type: "ready" }
  | { id: number; type: "result"; result: RunResult }
  | { id: number; type: "syntax"; result: RawReplCheck }
  | { id: number; type: "hasTests"; result: boolean }
  | { id: number; type: "packagesReady" }
  | { id: number; type: "pytestReady" }
  | { id: number; type: "static"; result: RawStaticFinding[] }
  | { id: number; type: "workspaceReady" }
  | { id: number; type: "workspaceFiles"; files: WorkspaceFile[] }
  | { id: number; type: "reactorFrame"; result: ReactorStepResult }
  | { id: number; type: "reactorDisposed" }
  | { id: number; type: "sessionEnded" }
  | { id: number; type: "examplarBuilt"; result: ExamplarBuildResult }
  | { id: number; type: "examplarRan"; result: ExamplarRunResult }
  /** `finished`: the interpreter can no longer run anything, in this worker. */
  | { id: number; type: "error"; message: string; finished?: boolean }
  | { type: "display"; payload: DisplayData }
  /** Pyodide saying what it is loading - or, `failed`, what went wrong. */
  | { type: "packageNote"; text: string; failed: boolean }
  | { type: "stdinRequest" };
