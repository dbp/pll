import type {
  DisplayData,
  ExamplarBuildResult,
  ExamplarRunResult,
  RawStaticFinding,
  ReactorStepResult,
  RunResult,
  TestRunResult,
} from "./wire";
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
      level?: string;
    }
  | {
      id: number;
      type: "replEval";
      code: string;
      sessionKey: string;
      level?: string;
    }
  | { id: number; type: "checkSyntax"; code: string }
  | { id: number; type: "loadPackages"; code: string }
  | { id: number; type: "hasTests"; code: string }
  | { id: number; type: "loadPytest" }
  | {
      id: number;
      type: "runTests";
      code: string;
      fileName: string;
      level?: string;
    }
  | { id: number; type: "staticAnalyze"; code: string; level: string; fileName: string; sessionKey?: string }
  | { id: number; type: "mountWorkspace"; files: WorkspaceFile[] }
  | { id: number; type: "collectWorkspace" }
  /** Apply one event (tick / key / mouse / receive) to a running reactor. */
  | { id: number; type: "reactorStep"; reactorId: string; event: string }
  /** Show an earlier or later frame without applying an event. */
  | { id: number; type: "reactorSeek"; reactorId: string; index: number }
  | { id: number; type: "reactorDispose"; reactorId: string }
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
  | { id: number; type: "testResult"; result: TestRunResult }
  | { id: number; type: "static"; result: RawStaticFinding[] }
  | { id: number; type: "workspaceReady" }
  | { id: number; type: "workspaceFiles"; files: WorkspaceFile[] }
  | { id: number; type: "reactorFrame"; result: ReactorStepResult }
  | { id: number; type: "reactorDisposed" }
  | { id: number; type: "examplarBuilt"; result: ExamplarBuildResult }
  | { id: number; type: "examplarRan"; result: ExamplarRunResult }
  | { id: number; type: "error"; message: string }
  | { type: "display"; payload: DisplayData }
  | { type: "stdinRequest" };
