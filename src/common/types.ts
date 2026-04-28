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
  | ExecutionErrorChunk
  | ExecutionDoneChunk;

export type ExecutionEventHandler = (event: ExecutionEvent) => void;

export interface RunFileRequest {
  code: string;
  /** Display name shown in tracebacks; doesn't have to exist on disk. */
  fileName: string;
}

export interface ReplEvalRequest {
  code: string;
}

export interface ReplCheckResult {
  status: "complete" | "incomplete" | "invalid";
  errorType?: string;
  message?: string;
  lineNumber?: number;
  offset?: number;
}

export interface PythonRuntime {
  initialize(): Promise<void>;
  isReady(): boolean;
  runFile(request: RunFileRequest, onEvent: ExecutionEventHandler): Promise<void>;
  replEval(request: ReplEvalRequest, onEvent: ExecutionEventHandler): Promise<void>;
  /** Decide whether `code` is a complete REPL input (codeop.compile_command). */
  checkReplComplete(code: string): Promise<ReplCheckResult>;
  dispose(): void;
}
