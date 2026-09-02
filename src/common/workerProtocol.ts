import type { DisplayData, RawStaticFinding, RunResult, TestRunResult } from "./pyodideRunner";
import type { WorkspaceFile } from "./workspaceFilePolicy";

export interface RawReplCheck {
  status: "complete" | "incomplete" | "invalid";
  error_type?: string;
  message?: string;
  lineno?: number;
  offset?: number;
}

export type WorkerInbound =
  | { id: number; type: "init"; indexUrl: string; stdinBuffer?: SharedArrayBuffer }
  | { id: number; type: "runFile"; code: string; fileName: string; sessionKey: string }
  | { id: number; type: "replEval"; code: string; sessionKey: string }
  | { id: number; type: "checkSyntax"; code: string }
  | { id: number; type: "loadPackages"; code: string }
  | { id: number; type: "hasTests"; code: string }
  | { id: number; type: "loadPytest" }
  | { id: number; type: "runTests"; code: string; fileName: string }
  | { id: number; type: "staticAnalyze"; code: string; level: string; fileName: string; sessionKey?: string }
  | { id: number; type: "mountWorkspace"; files: WorkspaceFile[] }
  | { id: number; type: "collectWorkspace" };

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
  | { id: number; type: "error"; message: string }
  | { type: "display"; payload: DisplayData }
  | { type: "stdinRequest" };
