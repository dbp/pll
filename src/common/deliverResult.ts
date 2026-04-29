import type { BonnieRunResult } from "./pyodideRunner";
import type { ExecutionEventHandler } from "./types";

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
export function deliverBonnieResult(
  result: BonnieRunResult,
  onEvent: ExecutionEventHandler,
  fileName: string,
): void {
  if (result.displays) {
    for (const display of result.displays) {
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
