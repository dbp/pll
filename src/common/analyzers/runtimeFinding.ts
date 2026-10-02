import type { Level } from "../level";
import type { ExecutionErrorChunk, ExecutionTestReportChunk } from "../types";
import { serializeFinding } from "./findingLocation";
import { findRuntimeFinding } from "./registry";
import type { AnalysisFinding } from "./types";

/**
 * The friendly finding for a runtime error event.
 *
 * Shared by the editor and the command line so a program reports the same
 * thing in both. Never null: every runtime error becomes a finding, and one
 * no analyzer recognises keeps Python's own words.
 */
export function findingForErrorEvent(
  event: ExecutionErrorChunk,
  source: string,
  fileName: string,
  level: Level,
): AnalysisFinding {
  return findRuntimeFinding(source, fileName, level, event.error);
}

/**
 * The test report with each error that a test raised explained, exactly as
 * the same error is explained when the program raises it. The report keeps
 * the finding and drops the exception it came from.
 */
export function explainTestReport(
  event: ExecutionTestReportChunk,
  source: string,
  fileName: string,
  level: Level,
): ExecutionTestReportChunk {
  return {
    ...event,
    tests: event.tests.map(({ error, ...test }) =>
      error ? { ...test, finding: serializeFinding(findRuntimeFinding(source, fileName, level, error)) } : test,
    ),
  };
}
