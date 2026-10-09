/**
 * The shapes of what the Python side returns: results of a run and its
 * tests, a reactor step, an Examplar run, and the static checks. Python
 * builds them as dicts; they arrive as plain objects, in snake_case, with
 * every `None` as `null`. Only the protocol and `fromPython.ts`, which turns
 * them into the host's own types, read these.
 */
/**
 * An exception as `_pll_error_info` describes it. Every result that can
 * report one carries these fields; they are null (or absent) when nothing
 * was raised.
 */
export interface WireError {
  error_type: string | null;
  error_message: string | null;
  traceback: string | null;
  /** Where the error is: the innermost frame, or a syntax error's own position. */
  error_file?: string | null;
  line_number: number | null;
  column: number | null;
  /** The text of that line, when it is the student's. */
  error_text?: string | null;
  error_frames?: WireFrame[];
  error_facts?: WireFacts;
}

export interface WireFrame {
  file: string;
  line: number;
  column: number | null;
  function: string | null;
  user: boolean;
  /** The student's line, for a frame of theirs. */
  text?: string | null;
  /** Their function's parameters, for a frame of theirs in one. */
  parameters?: string[] | null;
}

export interface WireFacts {
  name?: string;
  sequence?: string;
  length?: number;
  element_value?: string;
  element_type?: string;
  swapped_with?: string;
  check?: WireTypeCheck;
  definitions?: Record<string, WireDefinition>;
  assigned?: Record<string, { call: string; line: number }>;
  returned_none?: {
    match: WireTrailingMatch | null;
    printed: { line: number; expression: string | null } | null;
  };
  /** For a `KeyboardInterrupt` a Stop raised. */
  stop?: boolean;
  /** For `ChecksFailed`: the imported file, and what its level's checks found. */
  checks?: {
    file: string;
    level: string;
    findings: RawStaticFinding[];
    header_problem: { line: number; message: string } | null;
  };
  /** For a `ModuleNotFoundError`: why the import found nothing (`_pll_enrich_module_not_found`). */
  module?: WireMissingModule;
}

export interface WireMissingModule {
  name: string;
  kind: "missing" | "leftOut" | "notLoaded" | "notSeen";
  /** For `missing`: the student's file it may be a misspelling of. */
  close?: string | null;
  /** For `leftOut`: why the file was not loaded. */
  why?: string;
  /** For `notLoaded` and `notSeen`: the Pyodide package that has it. */
  package?: string;
}

/** What a name in the error is, as `_pll_definition` describes it. */
export type WireDefinition =
  | { kind: "function"; parameters: string[]; required: string[] }
  | { kind: "class"; students: boolean; fields: string[]; dataclass: boolean }
  | { kind: "union"; members: string[] };

/** As `_pll_trailing_match` describes it. */
export interface WireTrailingMatch {
  subject: string;
  patterns: string[];
  fixed_length: string[];
  has_list: boolean;
  uncovered: string[];
}

/** What failed its annotation, as `_pll_type_check_parts` reads it. */
export interface WireTypeCheck {
  kind: "argument" | "return" | "variable" | "field" | "unknown";
  name: string | null;
  element: string | null;
  actual: string | null;
  expected: string[];
  owner?: string;
  value?: string;
  /** The level of the code whose annotation it is. */
  level?: string | null;
  /** For "return": the function's return annotation, as written. */
  annotation?: string | null;
}

/** Whether a prompt line is complete yet, as `_pll_repl_check` says. */
export interface RawReplCheck {
  status: "complete" | "incomplete" | "invalid";
  error_type?: string | null;
  message?: string | null;
  lineno?: number | null;
  offset?: number | null;
}

export interface RunResult extends WireError {
  ok: boolean;
  stdout: string;
  stderr: string;
  result_repr: string | null;
  /** Typed displays produced by top-level expressions (images and tables). */
  displays: DisplayData[];
  /** The status the program ended itself with (`sys.exit(3)`), if it did. */
  exit_code?: number | null;
  /** Whether a Stop reached the program, even one it caught. */
  stopped?: boolean;
  /** Its tests, when they were asked for and the program finished. */
  tests?: TestRunResult | null;
}

export type DisplayData =
  | StdoutDisplay
  | StderrDisplay
  | ImageDisplay
  | TableDisplay
  | ReactorDisplay;

export interface StdoutDisplay {
  type: "stdout";
  text: string;
}

export interface StderrDisplay {
  type: "stderr";
  text: string;
}

export interface ImageDisplay {
  type: "image";
  /** Sub-format: today only "svg". */
  format?: string;
  width: number;
  height: number;
  /** The SVG document, ready to drop into HTML. */
  data: string;
}

export interface TableDisplay {
  type: "table";
  columns: string[];
  /** Pre-formatted display strings, parallel to `columns`. */
  rows: string[][];
  /** Total number of rows in the source table. */
  row_count: number;
  /** How many of the rows above are actually present (truncation cap). */
  shown_count: number;
  /** True iff the host should show a "row N of M" indicator. */
  truncated: boolean;
  /** For each column, whether every shown cell in it is a number. */
  numeric: boolean[];
  /** The whole table as CSV, every digit, for Save CSV - as much as fits its limit. */
  csv: string;
  /** How many rows `csv` holds. */
  csv_rows: number;
}

/**
 * A reactor asking to be shown. Unlike the other displays this one is not a
 * snapshot: the host keeps driving it by id, sending events and receiving
 * new frames, until it is stopped or its session is reset.
 */
export interface ReactorDisplay {
  type: "reactor";
  id: string;
  title: string;
  /** Seconds between ticks. */
  tick_rate: number;
  /** Whether it has an `on_tick`, i.e. whether there is anything to play. */
  ticking: boolean;
  wants_keys: boolean;
  wants_mouse: boolean;
  /** `ws://` URL for the universe client, or null. */
  register: string | null;
  frame: ReactorFrame;
  index: number;
  length: number;
  at_end: boolean;
  stopped: boolean;
  value_repr: string;
}

export interface ReactorFrame {
  data: string;
  width: number;
  height: number;
}

/** Reply from `_pll_reactor_step` / `_pll_reactor_seek`. */
export interface ReactorStepResult {
  ok: boolean;
  /** The reactor is no longer registered (its session was reset). */
  gone?: boolean;
  id?: string;
  frame?: ReactorFrame;
  index?: number;
  length?: number;
  at_end?: boolean;
  stopped?: boolean;
  value_repr?: string;
  /** JSON-encoded messages the handlers asked to send to the server. */
  messages?: string[];
  error_type?: string | null;
  error_message?: string | null;
  traceback?: string | null;
  error_file?: string | null;
  line_number?: number | null;
  column?: number | null;
  error_frames?: WireFrame[];
  error_facts?: WireFacts;
}

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

export interface ExamplarImplResult {
  id: string;
  /** For a chaff: the provided function it breaks. Unset on wheats. */
  targets?: string;
  /**
   * False when the *implementation* would not load. The student's own file
   * cannot fail this way: its definitions are loaded one at a time, and one
   * that raises is skipped.
   */
  loaded: boolean;
  tests: Record<string, ExamplarTestOutcome>;
  /**
   * Provided names the student's own file defines, recorded before the
   * implementation was overlaid. Empty early on, when they have written
   * tests and no code yet.
   */
  student_defines: string[];
  /** The student's definitions that could not be loaded, by line, and why. */
  unloaded?: { line: number; error: string }[];
  /** The test that ran too long here, null for loading, false for none. */
  timed_out?: string | null | false;
  error_type?: string;
  error_message?: string;
  traceback?: string;
}

export interface ExamplarRunResult {
  ok: boolean;
  error?: string;
  provides?: string[];
  /** test name -> the provided names it exercises. */
  attribution?: Record<string, string[]>;
  wheats?: ExamplarImplResult[];
  chaffs?: ExamplarImplResult[];
  /**
   * Functions whose chaffs were not run - either their tests did not all
   * pass, or there are no tests for them yet. Coverage is only measured
   * where the suite has been shown to be correct.
   */
  chaffs_skipped?: string[];
  /**
   * What ran past the time a test is given, which ended the check: the
   * implementation it ran against, and the test (null for loading).
   */
  timed_out?: {
    kind: "wheat" | "chaff";
    id: string;
    /** For a chaff, the function it breaks. */
    targets: string | null;
    test: string | null;
    seconds: number;
  } | null;
}

export interface TestCaseData {
  name: string;
  outcome: string;
  line_number: number | null;
  message: string | null;
  stdout: string | null;
  /** For a test that raised: the exception, for the host's explanations only. */
  error: WireError | null;
}

/** How a file's tests went, run after its program finished. */
export interface TestRunResult {
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  tests: TestCaseData[];
  /** A Stop ended them: the remaining tests did not run. */
  stopped?: boolean;
  /** The test running when it stopped, or null if none had started. */
  stopped_in?: string | null;
}

/** What every static finding carries, whatever it is about. */
interface StaticFindingBase {
  error_type: string;
  /** An error stops the code running; a warning is only said. */
  severity: "error" | "warning";
  line_number: number | null;
  column: number | null;
  name_token: string | null;
}

/**
 * Carried by the checks that walk scopes, which are the ones that know:
 * "module", "function", "lambda", "class" or "comprehension".
 */
interface InScope {
  scope_kind: string;
}

/** The mistakes that would otherwise run in silence: a value thrown away, and the like. */
export type SilenceFindingId =
  | "unused-comparison"
  | "unused-value"
  | "assert-tuple"
  | "method-not-called"
  | "annotation-not-a-type"
  | "field-no-type"
  | "field-assigned-type"
  | "class-needs-dataclass"
  | "compared-with-class"
  | "is-literal";

/**
 * One finding of `_pll_static_analyze`, keyed on `id`: each kind carries the
 * fields its explanation needs, and `explainers` in the static registry must
 * have one for every kind. A Python `None` arrives as `undefined`, so the
 * extras are optional.
 */
export type RawStaticFinding = StaticFindingBase &
  (
    | (InScope & {
        id: "shadowing";
        /** How the name is bound here: "argument", "for", "assign", ... */
        binding?: string | null;
        /** The nearest enclosing binding of the same name, and how it is bound. */
        outer_line_number?: number | null;
        outer_column?: number | null;
        outer_scope_kind?: string | null;
        outer_binding?: string | null;
      })
    | (InScope & { id: "shadowing-builtin" })
    /**
     * `library` is "image", "table", "reactor" or "library"; `binding` how
     * the name is bound ("import", "importfrom", "argument", "functiondef",
     * ...), and `module` what an import imports it from.
     */
    | (InScope & {
        id: "shadowing-library";
        library?: string | null;
        binding?: string | null;
        module?: string | null;
      })
    /** Where the name was first assigned. */
    | (InScope & { id: "reassignment"; first_line_number?: number | null; first_column?: number | null })
    | (InScope & {
        id: "duplicate-definition";
        first_line_number?: number | null;
        first_column?: number | null;
        /** "function" or "class" - or "both", for one of each. */
        definition_kind?: string | null;
      })
    /** `names` are those the statement declares. */
    | { id: "disallowed-keyword"; keyword: "global" | "nonlocal"; names: string[] }
    | { id: "test-not-named" }
    | {
        [Id in SilenceFindingId]: {
          id: Id;
          /** For "field-assigned-type": the type written after `=`, like `int`. */
          written_type?: string | null;
          /** For a value thrown away: the expression, as the student wrote it. */
          expression?: string | null;
          /** For "is-literal": `is` or `is not`, and the literal, as written. */
          operator?: string | null;
          literal?: string | null;
        };
      }[SilenceFindingId]
  );

/** The finding of one kind. */
export type RawStaticFindingOf<Id extends RawStaticFinding["id"]> = Extract<RawStaticFinding, { id: Id }>;
