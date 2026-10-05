import { pythonErrorFrom } from "./errors/pythonError";
import type { DisplayData, RunResult, TestCaseData, TestRunResult } from "./wire";
import type { ExecutionEvent, ExecutionEventHandler, TestCaseResult } from "./types";

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
