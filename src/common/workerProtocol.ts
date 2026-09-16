import type {
  DisplayData,
  RawStaticFinding,
  ReactorStepResult,
  RunResult,
  TestRunResult,
} from "./pyodideRunner";
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
  | { id: number; type: "reactorDispose"; reactorId: string };

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
  | { id: number; type: "error"; message: string }
  | { type: "display"; payload: DisplayData }
  | { type: "stdinRequest" };
