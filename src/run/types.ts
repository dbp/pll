import type { AnalysisFinding, SerializedFinding } from "./finding";
import type { Level } from "../core/level";

/*
 * What Python returns, in the names the host uses (`run/python.ts` says
 * which call returns which), and the events a run is delivered as - most
 * of which Python sends as they are.
 */

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
  /**
   * For each column, whether it holds only numbers - as Python sees them,
   * so text that looks like one, from a CSV, is not.
   */
  numeric: boolean[];
  /** The whole table as CSV, for Save CSV, as far as a size limit. */
  csv: string;
  /** How many rows `csv` holds: `rowCount`, unless the limit cut it short. */
  csvRows: number;
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
  /** Seconds between ticks. */
  tickRate: number;
  /** Whether it has an `on_tick`, so there is anything to play. */
  ticking: boolean;
  wantsKeys: boolean;
  wantsMouse: boolean;
  /** Universe server this world is registered with, if any. */
  register: string | null;
  /** The picture, as SVG. */
  frame: string;
  /** Frame number being shown, and how many have been recorded. */
  index: number;
  length: number;
  /** Whether the shown frame is the latest one (vs. rewound). */
  atEnd: boolean;
  stopped: boolean;
  /** `repr()` of the current state, shown under the picture. */
  valueRepr: string;
}

export interface ExecutionDoneChunk {
  kind: "done";
  /**
   * The status the program ended itself with - `sys.exit(3)` is 3, and
   * `sys.exit()` 0 - or absent when it simply finished.
   */
  exitCode?: number;
  /** A Stop reached the program, even one it caught: the run is stopped. */
  stopped?: boolean;
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
   * The `test_*` functions that take parameters, which are not run: a test
   * is called with nothing. Said above the tests, and in none of the counts.
   */
  malformed?: MalformedTest[];
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

export interface MalformedTest {
  name: string;
  lineNumber: number | null;
  /** The parameters it cannot be called without. */
  parameters: string[];
  /** Python's finding for it, until the host explains it. */
  problem?: PythonFinding | null;
  /** That finding, put there by `explainTestReport`. */
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

/**
 * A Python exception, as the host sees it: Python's own words, and the
 * finding Python made of it (`src/python/explain/`). Python sends more -
 * its frames and what it learned from them - for its tests, not the host.
 */
export interface PythonError {
  errorType: string;
  /** As Python's traceback shows it, suggestion included. */
  message: string;
  finding: PythonFinding;
}

/** A finding as Python makes it: in no file when the error is in none of the student's, and with no level. */
export type PythonFinding = Omit<AnalysisFinding, "fileName" | "level"> & { fileName: string | null };

/** A file run's or a prompt line's result (`_pll_run_result`). */
export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** The value of a prompt line's last expression, as `repr` writes it. */
  resultRepr: string | null;
  /** Everything it printed and showed, in order - none of it when it streamed live. */
  displays: DisplayData[];
  /** The status the program ended itself with (`sys.exit(3)`), if it did. */
  exitCode: number | null;
  /** Whether a Stop reached the program, even one it caught. */
  stopped: boolean;
  /** Its tests, when they were asked for and the program finished. */
  tests: TestRunResult | null;
  error: PythonError | null;
}

/** What a run shows, as Python sends it; the host captions an image or a table with its file. */
export type DisplayData =
  | ExecutionStdoutChunk
  | ExecutionStderrChunk
  | Omit<ExecutionImageChunk, "source">
  | Omit<ExecutionTableChunk, "source">
  | ExecutionReactorChunk;

/** How a file's tests went, run after its program finished: the report, before the host labels it. */
export type TestRunResult = Omit<ExecutionTestReportChunk, "kind" | "fileName">;

/** A reactor after a step or a seek: its new frame, or why there is none. */
export type ReactorStep =
  /** It is no longer registered: its session was reset. */
  | { kind: "gone" }
  /** A handler raised. */
  | { kind: "raised"; error: PythonError }
  | {
      kind: "frame";
      frame: string;
      index: number;
      length: number;
      atEnd: boolean;
      stopped: boolean;
      valueRepr: string;
      /** JSON-encoded messages the handlers asked to send to the server. */
      messages: string[];
    };

/**
 * An Examplar bundle: one URL's worth of known-good ("wheat") and
 * known-bad ("chaff") implementations, as `.pyc` bytecode.
 */
export interface ExamplarBundle {
  /** Format version; `1` today. */
  examplar: number;
  /** What built it, so a stale bundle can say so instead of failing oddly. */
  built: { python: string; magic: string };
  /** Public names every implementation defines. */
  provides: string[];
  wheats: ExamplarImplementation[];
  chaffs: ExamplarImplementation[];
}

export interface ExamplarImplementation {
  id: string;
  /** base64 of the marshalled code object. */
  pyc: string;
}

export interface ExamplarBuildResult {
  ok: boolean;
  bundle?: ExamplarBundle;
  error?: string;
}

export interface ExamplarTestOutcome {
  /**
   * `fail` when the test disagrees with the implementation - an assertion,
   * or an error the implementation itself raised; `error` when the
   * student's own code raised.
   */
  outcome: "pass" | "fail" | "error";
  /**
   * What it failed or raised with. For a failure, for `--verify` only - it
   * states the correct answer, so it never reaches a student's card.
   */
  message: string | null;
}

/** How one implementation fared against the student's tests. */
export interface ExamplarImpl {
  id: string;
  /** For a chaff: the provided function it breaks. Unset on wheats. */
  targets?: string;
  /**
   * False when the *implementation* would not load. The student's own file
   * cannot fail this way: its definitions are loaded one at a time, and one
   * that raises is skipped.
   */
  loaded: boolean;
  /** Keyed by test name. */
  tests: Record<string, ExamplarTestOutcome>;
  /**
   * Provided names the student's own file defines, recorded before the
   * implementation was overlaid. Empty early on, when they have written
   * tests and no code yet.
   */
  studentDefines: string[];
  /** The student's definitions that could not be loaded, by line, and why. */
  unloaded?: { line: number; error: string }[];
  /** The test that ran too long here, null for loading, false for none. */
  timedOut?: string | null | false;
  errorType?: string;
  errorMessage?: string;
}

/** A student's tests, run against every implementation in a bundle. */
export interface ExamplarOutcome {
  ok: boolean;
  error?: string;
  provides?: string[];
  /** test name -> the provided names it exercises. */
  attribution?: Record<string, string[]>;
  wheats?: ExamplarImpl[];
  chaffs?: ExamplarImpl[];
  /**
   * Functions whose chaffs were not run - either their tests did not all
   * pass, or there are no tests for them yet. Coverage is only measured
   * where the suite has been shown to be correct.
   */
  chaffsSkipped?: string[];
  /**
   * What ran past the time a test is given, which ended the check: the
   * implementation it ran against, and the test (null for loading).
   */
  timedOut?: {
    kind: "wheat" | "chaff";
    id: string;
    /** For a chaff, the function it breaks. */
    targets: string | null;
    test: string | null;
    seconds: number;
  } | null;
}
