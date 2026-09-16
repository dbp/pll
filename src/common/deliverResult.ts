import type { DisplayData, RunResult, TestRunResult } from "./pyodideRunner";
import type { ExecutionEventHandler, TestCaseResult } from "./types";

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
  if (!result.ok && result.error_type) {
    onEvent({
      kind: "error",
      errorType: result.error_type,
      message: result.error_message ?? "",
      traceback: result.traceback ?? "",
      lineNumber: result.line_number,
      column: result.column,
      fileName,
    });
  }
  onEvent({ kind: "done" });
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

function asPlain(value: unknown): unknown {
  if (value instanceof Map) {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of value.entries()) {
      obj[String(k)] = asPlain(v);
    }
    return obj;
  }
  if (Array.isArray(value)) {
    return value.map(asPlain);
  }
  return value;
}

function adaptTestCase(raw: unknown): TestCaseResult {
  const row = (asPlain(raw) ?? {}) as Record<string, unknown>;
  const line = row.line_number;
  return {
    name: String(row.name ?? ""),
    outcome: String(row.outcome ?? "failed"),
    lineNumber: typeof line === "number" ? line : null,
    message: row.message == null ? null : String(row.message),
    stdout: row.stdout == null ? null : String(row.stdout),
  };
}

/**
 * Translate a `_pll_run_tests` result into events. Failed tests are
 * reported as a `testReport` card, not as a runtime `error` — the file
 * still runs afterwards. Internal pytest/load failures do emit `error`.
 */
export function deliverTestResult(
  result: TestRunResult,
  onEvent: ExecutionEventHandler,
  fileName: string,
): void {
  if (result.internal_error && result.error_type) {
    onEvent({
      kind: "error",
      errorType: result.error_type,
      message: result.error_message ?? "",
      traceback: result.traceback ?? "",
      lineNumber: result.line_number,
      column: result.column,
      fileName,
    });
    onEvent({ kind: "done" });
    return;
  }
  const tests = Array.isArray(result.tests) ? result.tests.map(adaptTestCase) : [];
  onEvent({
    kind: "testReport",
    fileName,
    passed: result.passed ?? 0,
    failed: result.failed ?? 0,
    skipped: result.skipped ?? 0,
    errors: result.errors ?? 0,
    tests,
  });
  onEvent({ kind: "done" });
}
