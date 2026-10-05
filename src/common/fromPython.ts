/**
 * Where everything Python returns becomes TypeScript: the one module that
 * reads the shapes in `wire.ts`. Python builds its results as snake_case
 * dicts, and they arrive with every `None` as `null` (`callPython` sees to
 * that); past here, the host works only with the types below and in
 * `types.ts`, in camelCase.
 *
 * The runtime calls these on each reply. A run's or a prompt line's result
 * becomes a stream of `ExecutionEvent`s; the others become one value each.
 */

import type { ErrorFrame, PythonError } from "./errors/pythonError";
import type {
  DisplayData,
  ExamplarBuildResult,
  ExamplarBundle,
  ExamplarImplResult,
  ExamplarRunResult,
  ExamplarTestOutcome,
  RawReplCheck,
  RawStaticFinding,
  ReactorFrame,
  ReactorStepResult,
  RunResult,
  SilenceFindingId,
  TestCaseData,
  TestRunResult,
  WireError,
  WireFrame,
} from "./wire";
import type {
  ExecutionEvent,
  ExecutionEventHandler,
  ReplCheckResult,
  TestCaseResult,
} from "./types";

export type { ExamplarBuildResult, ExamplarBundle, ExamplarTestOutcome, ReactorFrame, SilenceFindingId };

/* ---- Names ---------------------------------------------------------- */

/** A snake_case field name in camelCase: `line_number` -> `lineNumber`. */
type Camel<Name extends string> = Name extends `${infer Head}_${infer Tail}`
  ? `${Head}${Capitalize<Camel<Tail>>}`
  : Name;

/** One of Python's records with its field names in camelCase; distributes over a union. */
export type Camelized<Record> = Record extends unknown
  ? { [Key in keyof Record as Key extends string ? Camel<Key> : Key]: Record[Key] }
  : never;

function camelName(name: string): string {
  return name.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

/** `record` with its field names - not its values' - in camelCase. */
function camelized<Record extends object>(record: Record): Camelized<Record> {
  return Object.fromEntries(
    Object.entries(record).map(([name, value]) => [camelName(name), value]),
  ) as Camelized<Record>;
}

/* ---- Runs and prompt lines ------------------------------------------ */

/**
 * Translate the Python-side result dict into the host-side stream of
 * `ExecutionEvent`s. Shared by the desktop and web runtimes so they
 * dispatch the same set of events in the same order.
 *
 * `result.displays` is the canonical, *interleaved* timeline of every
 * stdout/stderr write, every image emission, and every table emission,
 * in the order the user's code produced them. So a file that runs
 *
 *   print("a")
 *   some_table
 *   print("b")
 *
 * produces stdout("a\n") -> table card -> stdout("b\n") in that exact
 * order. (The aggregate `result.stdout` / `result.stderr` strings are
 * still populated for tools that just want "what did the program
 * print?", but we don't use them here.)
 *
 * After draining `displays` we emit, in order:
 *   - `result_repr` (the value of the last REPL expression, if any)
 *   - `error` (if the run raised)
 *   - `testReport` (if its tests ran, which they do after the program)
 *   - `done`
 */
export function deliverRunResult(
  result: RunResult,
  onEvent: ExecutionEventHandler,
  fileName: string,
): void {
  if (result.displays) {
    for (const display of result.displays) {
      deliverDisplay(display, onEvent, fileName);
    }
  }
  if (result.result_repr !== null && result.result_repr !== undefined) {
    onEvent({ kind: "result", repr: result.result_repr });
  }
  const error = result.ok ? null : pythonErrorFrom(result);
  if (error !== null) {
    onEvent({ kind: "error", error, fileName });
  }
  if (result.tests) {
    onEvent(testReportFrom(result.tests, fileName));
  }
  const exitCode = result.exit_code;
  onEvent(typeof exitCode === "number" ? { kind: "done", exitCode } : { kind: "done" });
}

/**
 * Translate one display payload into an `ExecutionEvent`. Used both for the
 * batched end-of-run list and for live streaming during a run (so `input()`
 * prompts appear before the program blocks).
 */
export function deliverDisplay(
  display: DisplayData,
  onEvent: ExecutionEventHandler,
  fileName: string,
): void {
  switch (display.type) {
    case "stdout":
      onEvent({ kind: "stdout", text: display.text });
      break;
    case "stderr":
      onEvent({ kind: "stderr", text: display.text });
      break;
    case "image":
      onEvent({
        kind: "image",
        svg: display.data,
        width: display.width,
        height: display.height,
        source: fileName,
      });
      break;
    case "reactor":
      onEvent({
        kind: "reactor",
        id: display.id,
        title: display.title,
        tickRate: display.tick_rate,
        ticking: display.ticking,
        wantsKeys: display.wants_keys,
        wantsMouse: display.wants_mouse,
        register: display.register,
        frame: display.frame,
        index: display.index,
        length: display.length,
        atEnd: display.at_end,
        stopped: display.stopped,
        valueRepr: display.value_repr,
      });
      break;
    case "table":
      onEvent({
        kind: "table",
        columns: display.columns,
        rows: display.rows,
        rowCount: display.row_count,
        shownCount: display.shown_count,
        truncated: display.truncated,
        source: fileName,
      });
      break;
  }
}

function adaptTestCase(row: TestCaseData): TestCaseResult {
  return {
    name: String(row.name ?? ""),
    outcome: String(row.outcome ?? "failed"),
    lineNumber: typeof row.line_number === "number" ? row.line_number : null,
    message: row.message ?? null,
    stdout: row.stdout ?? null,
    error: pythonErrorFrom(row.error),
  };
}

/** The report of a file's tests: a card, never a runtime `error`. */
function testReportFrom(
  result: TestRunResult,
  fileName: string,
): Extract<ExecutionEvent, { kind: "testReport" }> {
  return {
    kind: "testReport",
    fileName,
    passed: result.passed ?? 0,
    failed: result.failed ?? 0,
    skipped: result.skipped ?? 0,
    errors: result.errors ?? 0,
    tests: Array.isArray(result.tests) ? result.tests.map(adaptTestCase) : [],
    ...(result.stopped ? { stopped: true, stoppedIn: result.stopped_in ?? null } : {}),
  };
}

/* ---- Errors --------------------------------------------------------- */

/**
 * The error a result reports, or null when it reports none.
 *
 * Every position is a number or null by the end, whatever Python sent, so
 * none reaches a label as `file.py:3:NaN`.
 */
export function pythonErrorFrom(wire: Partial<WireError> | null | undefined): PythonError | null {
  if (!wire || !wire.error_type) {
    return null;
  }
  const facts = wire.error_facts ?? {};
  return {
    errorType: wire.error_type,
    message: wire.error_message ?? "",
    traceback: wire.traceback ?? "",
    fileName: wire.error_file ?? null,
    lineNumber: numberOrNull(wire.line_number),
    column: numberOrNull(wire.column),
    nameToken: facts.name ?? null,
    frames: (wire.error_frames ?? []).map(frameFrom),
    facts: {
      name: facts.name ?? undefined,
      sequence: facts.sequence ?? undefined,
      length: numberOrNull(facts.length) ?? undefined,
      elementValue: facts.element_value ?? undefined,
      swappedWith: facts.swapped_with ?? undefined,
    },
  };
}

function frameFrom(frame: WireFrame): ErrorFrame {
  return {
    fileName: frame.file,
    line: frame.line,
    column: numberOrNull(frame.column),
    functionName: frame.function ?? null,
    user: frame.user === true,
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/* ---- Prompt lines --------------------------------------------------- */

export function replCheckFrom(raw: RawReplCheck): ReplCheckResult {
  return {
    status: raw.status,
    errorType: raw.error_type ?? undefined,
    message: raw.message ?? undefined,
    lineNumber: raw.lineno ?? undefined,
    offset: raw.offset ?? undefined,
  };
}

/* ---- Static checks -------------------------------------------------- */

/** One finding of `_pll_static_analyze`, keyed on `id` as `RawStaticFinding` is. */
export type StaticFinding = Camelized<RawStaticFinding>;

/** The finding of one kind. */
export type StaticFindingOf<Id extends StaticFinding["id"]> = Extract<StaticFinding, { id: Id }>;

export function staticFindingsFrom(raw: RawStaticFinding[] | null): StaticFinding[] {
  return (raw ?? []).map((finding) => camelized(finding) as StaticFinding);
}

/* ---- Examplar ------------------------------------------------------- */

/** How one implementation fared against the student's tests. */
export type ExamplarImpl = Camelized<ExamplarImplResult>;

/** A student's tests, run against every implementation in a bundle. */
export type ExamplarOutcome = Omit<Camelized<ExamplarRunResult>, "wheats" | "chaffs"> & {
  wheats?: ExamplarImpl[];
  chaffs?: ExamplarImpl[];
};

export function examplarOutcomeFrom(raw: ExamplarRunResult): ExamplarOutcome {
  return {
    ...camelized(raw),
    // `tests` and `attribution` are keyed by test name: their keys are the
    // student's, and stay as they are.
    wheats: raw.wheats?.map((impl) => camelized(impl)),
    chaffs: raw.chaffs?.map((impl) => camelized(impl)),
  };
}

/* ---- Reactors ------------------------------------------------------- */

/** A reactor after a step or a seek: its new frame, or why there is none. */
export type ReactorStep =
  /** It is no longer registered: its session was reset. */
  | { kind: "gone" }
  /** A handler raised. */
  | { kind: "raised"; error: PythonError }
  | {
      kind: "frame";
      frame: ReactorFrame;
      index: number;
      length: number;
      atEnd: boolean;
      stopped: boolean;
      valueRepr: string;
      /** JSON-encoded messages the handlers asked to send to the server. */
      messages: string[];
    };

export function reactorStepFrom(raw: ReactorStepResult): ReactorStep {
  if (raw.gone) {
    return { kind: "gone" };
  }
  if (!raw.ok || !raw.frame) {
    // Python names the error it caught; the fallback only satisfies the type.
    return { kind: "raised", error: pythonErrorFrom(raw) ?? pythonErrorFrom({ error_type: "Error" })! };
  }
  return {
    kind: "frame",
    frame: raw.frame,
    index: raw.index ?? 0,
    length: raw.length ?? 1,
    atEnd: raw.at_end === true,
    stopped: raw.stopped === true,
    valueRepr: raw.value_repr ?? "",
    messages: raw.messages ?? [],
  };
}
