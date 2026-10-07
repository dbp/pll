import type { SerializedFinding } from "./analyzers/findingLocation";
import type { PythonError } from "./errors/pythonError";
import type { Level } from "./level";
import type {
  ExamplarBuildResult,
  ExamplarOutcome,
  ReactorFrame,
  ReactorStep,
  StaticFinding,
} from "./fromPython";
import type { WorkspaceFile } from "./workspaceFilePolicy";

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
  /** The exception, as Python described it. */
  error: PythonError;
  /** The file that was running. */
  fileName: string | null;
}

/**
 * A reactor asking to be shown. The only event that starts something
 * ongoing: the host drives it afterwards by `id`.
 */
export interface ExecutionReactorChunk {
  kind: "reactor";
  id: string;
  title: string;
  tickRate: number;
  ticking: boolean;
  wantsKeys: boolean;
  wantsMouse: boolean;
  register: string | null;
  frame: ReactorFrame;
  index: number;
  length: number;
  atEnd: boolean;
  stopped: boolean;
  valueRepr: string;
}

export interface ExecutionDoneChunk {
  kind: "done";
  /**
   * The status the program ended itself with - `sys.exit(3)` is 3, and
   * `sys.exit()` 0 - or absent when it simply finished.
   */
  exitCode?: number;
}

export interface ExecutionTestReportChunk {
  kind: "testReport";
  fileName: string;
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  tests: TestCaseResult[];
  /**
   * A Stop ended the tests. The tests listed ran (the last, if any, with
   * outcome "stopped"); the rest did not.
   */
  stopped?: boolean;
  /** The test that was running when it stopped, or null if none had started. */
  stoppedIn?: string | null;
}

export interface TestCaseResult {
  name: string;
  outcome: "passed" | "failed" | "skipped" | "error" | "stopped" | string;
  lineNumber: number | null;
  /** The one line a report has room for: a failed assertion, or Python's message. */
  message: string | null;
  stdout: string | null;
  /** For a test that raised: the exception, until the host explains it. */
  error?: PythonError | null;
  /** That explanation, put there by `explainTestReport`. */
  finding?: SerializedFinding;
}

export type ExecutionEvent =
  | ExecutionStdoutChunk
  | ExecutionStderrChunk
  | ExecutionResultChunk
  | ExecutionImageChunk
  | ExecutionTableChunk
  | ExecutionErrorChunk
  | ExecutionTestReportChunk
  | ExecutionReactorChunk
  | ExecutionDoneChunk;

export type ExecutionEventHandler = (event: ExecutionEvent) => void;

export interface RunFileRequest {
  code: string;
  /** Display name shown in tracebacks; doesn't have to exist on disk. */
  fileName: string;
  /** Opaque per-file session id; the file's globals dict is keyed by this. */
  sessionKey: string;
  /**
   * Language level. The only input that decides what is checked: whether
   * annotations are instrumented at all, and how strictly. Defaults to
   * `raw` (nothing checked).
   */
  level?: Level;
  /**
   * Run the file's own tests once the program finishes, against the names
   * it defined; their report follows its output. pytest must be loaded.
   */
  withTests?: boolean;
}

export interface ReplEvalRequest {
  code: string;
  /** Opaque per-file session id; the prompt evaluates against this file's globals. */
  sessionKey: string;
  /** Language level; see `RunFileRequest.level`. */
  level?: Level;
}

export interface ReplCheckResult {
  status: "complete" | "incomplete" | "invalid";
  errorType?: string;
  message?: string;
  lineNumber?: number;
  offset?: number;
}

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
  /** Decide whether `code` is a complete REPL input (codeop.compile_command). */
  checkReplComplete(code: string): Promise<ReplCheckResult>;
  /**
   * Run language-level static checks against a file. Returns an empty array
   * for `advanced` (no checks) or when the file doesn't parse (let runtime
   * surface SyntaxErrors).
   */
  staticAnalyze(request: StaticAnalyzeRequest): Promise<StaticFinding[]>;
  /**
   * Copy sibling workspace files into Pyodide's work directory so
   * `open("data.csv")` / `pd.read_csv("data.csv")` see them. Replaces any
   * files from a previous mount.
   */
  mountWorkspaceFiles(files: WorkspaceFile[]): Promise<void>;
  /**
   * Data files Python created or changed since the last mount, to write
   * back next to the running script.
   */
  collectWorkspaceFiles(): Promise<WorkspaceFile[]>;
  /**
   * Compile Examplar wheats and chaffs into a bundle. `sources` is the JSON
   * of `{wheats: {id: source}, chaffs: {id: source}}`. Authoring only; the
   * bytecode is produced by *this* interpreter so its magic number matches
   * by construction.
   */
  examplarBuild(sources: string): Promise<ExamplarBuildResult>;
  /** Run a student's tests against every implementation in a bundle. */
  /** `fileName` is the student's file, whose own errors are told from the implementation's. */
  examplarRun(testSource: string, bundle: string, fileName: string): Promise<ExamplarOutcome>;
  /**
   * Apply one event to a running reactor and get the frame it produced.
   * `event` is the JSON of `{kind, ...}`; see `Reactor.react`.
   */
  /**
   * Apply one event to a running reactor. What its handlers print or show
   * arrives through `onEvent`, as a run's output does, labelled `fileName`.
   */
  reactorStep(
    reactorId: string,
    event: string,
    output?: { onEvent: ExecutionEventHandler; fileName: string },
  ): Promise<ReactorStep>;
  /** Show an earlier or later recorded frame, applying no event. */
  reactorSeek(reactorId: string, index: number): Promise<ReactorStep>;
  /** Forget a reactor, so its recorded states can be collected. */
  reactorDispose(reactorId: string): Promise<void>;
  /** Forget a session and the names its runs defined. */
  endSession(sessionKey: string): Promise<void>;
  /**
   * Ask a running program to stop, by raising `KeyboardInterrupt` at the
   * interpreter's next bytecode check. Synchronous on purpose: the worker is
   * blocked inside `runPython` and would not read a message until it
   * returned. Returns false when there is no interrupt channel (no
   * `SharedArrayBuffer`), so callers can say so rather than appear to work.
   */
  interrupt(): boolean;
  /**
   * Register the handler used when a running program calls `input()`.
   * Both hosts block the Pyodide worker until this resolves with a line
   * (no trailing newline) or `null` (EOF / cancel).
   */
  setStdinHandler(handler: (() => Promise<string | null>) | null): void;
  /**
   * Who hears what Pyodide says while it loads a package: "Loading pytest,
   * ..." or, `failed`, why it could not. Without one, the host's log.
   */
  setPackageNoteHandler(handler: ((text: string, failed: boolean) => void) | null): void;
  /**
   * Told when Python had to be replaced - its worker stopped, or it could
   * no longer run - and so every session's names are gone. The request in
   * flight fails with `PythonLostError`; the next starts a new Python.
   */
  setPythonLostHandler(handler: (() => void) | null): void;
  dispose(): void;
}
