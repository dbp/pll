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

export interface ExecutionTableChunk {
  kind: "table";
  /** Column names in display order. */
  columns: string[];
  /** Pre-formatted display strings, parallel to `columns`, capped to `shownCount`. */
  rows: string[][];
  /** Total rows in the source table. */
  rowCount: number;
  /** Rows actually present in `rows` (may be < rowCount when truncated). */
  shownCount: number;
  /** True when display was truncated for size. */
  truncated: boolean;
  /** Source caption (file name or "<repl>"). */
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

export interface ExecutionTestReportChunk {
  kind: "testReport";
  fileName: string;
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  tests: TestCaseResult[];
}

export interface TestCaseResult {
  name: string;
  outcome: "passed" | "failed" | "skipped" | "error" | string;
  lineNumber: number | null;
  message: string | null;
  stdout: string | null;
}

export type ExecutionEvent =
  | ExecutionStdoutChunk
  | ExecutionStderrChunk
  | ExecutionResultChunk
  | ExecutionImageChunk
  | ExecutionTableChunk
  | ExecutionErrorChunk
  | ExecutionTestReportChunk
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
  /** When set, names already bound in this session count as existing
   *  module-level bindings (used for REPL checks after Run File). */
  sessionKey?: string;
}

export interface PythonRuntime {
  initialize(): Promise<void>;
  isReady(): boolean;
  runFile(request: RunFileRequest, onEvent: ExecutionEventHandler): Promise<void>;
  replEval(request: ReplEvalRequest, onEvent: ExecutionEventHandler): Promise<void>;
  /**
   * Load any Pyodide packages the code imports (pandas, numpy, ...), via
   * Pyodide's `loadPackagesFromImports`. A no-op when the code imports nothing
   * that maps to a known package; needs network the first time it loads one.
   */
  ensurePackages(code: string): Promise<void>;
  /** True if `code` contains pytest-style `test_*` functions or `Test*` classes. */
  hasTests(code: string): Promise<boolean>;
  /** Load the pytest package (no-op if already loaded). Needs network the first time. */
  ensurePytest(): Promise<void>;
  /** Run pytest against `request.code` as `pytest <fileName>`. Isolated from the REPL session. */
  runTests(request: RunFileRequest, onEvent: ExecutionEventHandler): Promise<void>;
  /** Decide whether `code` is a complete REPL input (codeop.compile_command). */
  checkReplComplete(code: string): Promise<ReplCheckResult>;
  /**
   * Run language-level static checks against a file. Returns an empty array
   * for `advanced` (no checks) or when the file doesn't parse (let runtime
   * surface SyntaxErrors).
   */
  staticAnalyze(request: StaticAnalyzeRequest): Promise<RawStaticFinding[]>;
  /**
   * Register the handler used when a running program calls `input()`.
   * Both hosts block the Pyodide worker until this resolves with a line
   * (no trailing newline) or `null` (EOF / cancel).
   */
  setStdinHandler(handler: (() => Promise<string | null>) | null): void;
  dispose(): void;
}
