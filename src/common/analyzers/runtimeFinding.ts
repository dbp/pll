import type { Level } from "../level";
import { parsePythonError } from "../errors/pythonErrorParser";
import type { ExecutionErrorChunk } from "../types";
import { findRuntimeFinding } from "./registry";
import type { AnalysisFinding } from "./types";

/**
 * The friendly finding for a runtime error event, or null to show the real
 * traceback.
 *
 * The traceback text is the primary source and the event's own fields only
 * fill gaps: the innermost frame in the traceback is where the error
 * actually happened, which can differ from the exception's attributes -
 * exactly the distinction `typeCheckAnalyzer` uses to blame a bad argument
 * on the call rather than the `def` line.
 *
 * Shared by the editor and the command line so a program reports the same
 * thing in both. Returning null rather than inventing a finding is what
 * keeps friendly errors strictly additive.
 */
export function findingForErrorEvent(
  event: ExecutionErrorChunk,
  source: string,
  fileName: string,
  level: Level,
): AnalysisFinding | null {
  const traceback = event.traceback || `${event.errorType}: ${event.message}`;
  const parsed = parsePythonError(traceback);
  if (parsed.lineNumber === null && event.lineNumber !== null) {
    parsed.lineNumber = event.lineNumber;
  }
  if (parsed.column === null && event.column !== null) {
    parsed.column = event.column;
  }
  if (parsed.fileName === null && event.fileName) {
    parsed.fileName = event.fileName;
  }
  return findRuntimeFinding(source, fileName, level, parsed);
}
