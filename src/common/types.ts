export interface ExecutionStdoutChunk {
  kind: "stdout";
  text: string;
}

export interface ExecutionStderrChunk {
  kind: "stderr";
  text: string;
}

export interface ExecutionResultChunk {
  kind: "result";
  repr: string | null;
}

export interface ExecutionImageChunk {
  kind: "image";
  /** The SVG document, ready to drop into HTML. */
  svg: string;
  width: number;
  height: number;
  /** Source phrase shown as a caption (e.g. file name or REPL line). */
  source?: string;
}

export interface ExecutionErrorChunk {
  kind: "error";
  errorType: string;
  message: string;
  traceback: string;
  /** 1-based line number in user file, if extractable. */
  lineNumber: number | null;
  /** 1-based column number, if extractable. */
  column: number | null;
  /** Filename mentioned in the traceback, if any. */
  fileName: string | null;
}

export interface ExecutionDoneChunk {
  kind: "done";
}

export type ExecutionEvent =
  | ExecutionStdoutChunk
  | ExecutionStderrChunk
  | ExecutionResultChunk
  | ExecutionImageChunk
  | ExecutionErrorChunk
  | ExecutionDoneChunk;

export type ExecutionEventHandler = (event: ExecutionEvent) => void;

export interface RunFileRequest {
  code: string;
  /** Display name shown in tracebacks; doesn't have to exist on disk. */
  fileName: string;
  /** Opaque per-file session id; the file's globals dict is keyed by this. */
  sessionKey: string;
}

export interface ReplEvalRequest {
  code: string;
  /** Opaque per-file session id; the prompt evaluates against this file's globals. */
  sessionKey: string;
}

export interface ReplCheckResult {
  status: "complete" | "incomplete" | "invalid";
  errorType?: string;
  message?: string;
  lineNumber?: number;
  offset?: number;
}

import type { Level } from "./level";
import type { RawStaticFinding } from "./pyodideRunner";

export interface StaticAnalyzeRequest {
  code: string;
  fileName: string;
  level: Level;
}

export interface PythonRuntime {
  initialize(): Promise<void>;
  isReady(): boolean;
  runFile(request: RunFileRequest, onEvent: ExecutionEventHandler): Promise<void>;
  replEval(request: ReplEvalRequest, onEvent: ExecutionEventHandler): Promise<void>;
  /** Decide whether `code` is a complete REPL input (codeop.compile_command). */
  checkReplComplete(code: string): Promise<ReplCheckResult>;
  /**
   * Run language-level static checks against a file. Returns an empty array
   * for `expert` (no checks) or when the file doesn't parse (let runtime
   * surface SyntaxErrors).
   */
  staticAnalyze(request: StaticAnalyzeRequest): Promise<RawStaticFinding[]>;
  dispose(): void;
}
