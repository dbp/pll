import { levelHeaderProblem, type Level } from "../core/level";
import type { ExecutionTestReportChunk, PythonError } from "./types";

/**
 * A finding, on the host: its record, where it is and its label, its plain
 * text, the `#level` line check - which runs before Python - and Python's
 * finding for a runtime error, taken as the run's. What a finding says is
 * Python's (`src/python/explain/`).
 */

export interface AnalysisFinding {
  /** Short id like "name-error" or "shadowing". */
  id: string;
  /** The exception/lint type, e.g. "NameError", "Shadowing", "Reassignment". */
  errorType: string;
  /** Beginner-friendly headline (single line). */
  headline: string;
  /** Beginner-friendly next steps, one entry per bullet. */
  howToFix: string[];
  /** The file it is in, as the student knows it (e.g. "hello.py", or "<repl>" for the prompt). */
  fileName: string;
  /** 1-based line number in that file (null if unknown). */
  lineNumber: number | null;
  /** 0-based column (null if unknown); labels show it 1-based. */
  column: number | null;
  /** Identifier the issue is about (used to narrow the highlight). */
  nameToken: string | null;
  /** Severity hint - matches vscode.DiagnosticSeverity values without importing it here. */
  severity: "error" | "warning" | "info";
  /**
   * Where the finding came from. Used so the diagnostics layer can label
   * the source ("pll / runtime" vs "pll / static") and so future
   * suppression rules can target one or the other.
   */
  origin: "runtime" | "static";
  /** Language level under which this finding was produced. */
  level: Level;
}

/**
 * Where a finding points, in the form every renderer needs: the structured
 * position plus the `file:line[:col]` label shown to the user.
 *
 * `line` and `column` keep the finding's own conventions, while `label`
 * displays the column 1-based the way editors number it.
 */
export interface FindingLocation {
  fileName: string;
  /** 1-based. */
  line: number;
  /** 0-based, or null when unknown. */
  column: number | null;
  /** Display form, e.g. "hello.py:2:5". */
  label: string;
}

/**
 * A finding as the views render it: the interactions panel, a test row, the
 * command line. Plain data, so it crosses into the webview as it is.
 */
export interface SerializedFinding {
  errorType: string;
  headline: string;
  howToFix: string[];
  location: FindingLocation | null;
}

export function serializeFinding(finding: AnalysisFinding): SerializedFinding {
  return {
    errorType: finding.errorType,
    headline: finding.headline,
    howToFix: [...finding.howToFix],
    location: findingLocation(finding),
  };
}

/**
 * The finding's location, or null when there is none worth showing.
 *
 * Null for a finding with no line, and for prompt input: `<repl>` and
 * `<input>` are not real files, so a location reads as noise there.
 *
 * Both renderers go through this - the diagnostic tooltip via
 * `formatFriendlyError` and the interactions view via `serializeFinding` - so the
 * suppression rule and the label format are decided in exactly one place.
 */
export function findingLocation(finding: AnalysisFinding): FindingLocation | null {
  if (finding.lineNumber === null) {
    return null;
  }
  if (finding.fileName === "<repl>" || finding.fileName === "<input>") {
    return null;
  }
  // Positions from Python are numbers or null by the time they get here:
  // JSON sees to it.
  const column = finding.column;
  const label =
    column !== null
      ? `${finding.fileName}:${finding.lineNumber}:${column + 1}`
      : `${finding.fileName}:${finding.lineNumber}`;
  return {
    fileName: finding.fileName,
    line: finding.lineNumber,
    column,
    label,
  };
}

/**
 * Plain-text rendering of an analysis finding: the squiggle's hover text in
 * the editor, and a finding on the command line.
 *
 * The interactions view renders findings as structured HTML instead (see
 * `appendFinding` in `media/interactionsView/main.js`), from the same
 * `serializeFinding` fields.
 *
 * Layout:
 *   ErrorType: headline.
 *     at hello.py:2:5
 *
 *   How to fix:
 *     - bullet 1
 *     - bullet 2
 */
export function formatFriendlyError(finding: AnalysisFinding): string[] {
  return serializedFindingLines(serializeFinding(finding));
}

/** `formatFriendlyError`'s lines, for a finding as the views have it. */
export function serializedFindingLines(finding: SerializedFinding): string[] {
  const lines: string[] = [];
  lines.push(`${finding.errorType}: ${finding.headline}`);

  if (finding.location) {
    lines.push(`  at ${finding.location.label}`);
  }

  if (finding.howToFix.length > 0) {
    lines.push("");
    lines.push("How to fix:");
    for (const item of finding.howToFix) {
      lines.push(`  - ${item}`);
    }
  }
  return lines;
}

/** Newline-joined plain string for `vscode.Diagnostic.message`. */
export function formatFriendlyErrorPlain(finding: AnalysisFinding): string {
  return formatFriendlyError(finding).join("\n");
}

/**
 * A broken `#level` line, as a finding that stops the run.
 *
 * It has to stop the run. The whole point of the line is to ask for
 * checks, and a file that asked and silently got none is worse than one
 * that never asked: the student believes `beginner` is watching. So this is
 * reported before anything else, at any level - there is no level to
 * consult, which is exactly the problem.
 */
export function levelHeaderFinding(
  source: string,
  fileName: string,
  level: Level,
): AnalysisFinding | null {
  const problem = levelHeaderProblem(source);
  if (problem === null) {
    return null;
  }
  return {
    id: "level-header",
    errorType: "Level",
    headline: problem.message,
    howToFix: problem.howToFix,
    fileName,
    lineNumber: problem.line,
    column: null,
    nameToken: null,
    severity: "error",
    origin: "static",
    level,
  };
}

/**
 * The finding for a runtime error: Python's (`explain/finding.py`), in the
 * file the error is in - or the run's, when it is in none of the student's
 * files - at the run's level.
 */
export function findRuntimeFinding(fileName: string, level: Level, error: PythonError): AnalysisFinding {
  return { ...error.finding, fileName: error.finding.fileName ?? fileName, level };
}

/**
 * The test report with each error that a test raised explained, exactly as
 * the same error is explained when the program raises it, and each test
 * that could not be run with Python's finding for it. The report keeps the
 * finding and drops the exception it came from.
 */
export function explainTestReport(
  event: ExecutionTestReportChunk,
  fileName: string,
  level: Level,
): ExecutionTestReportChunk {
  return {
    ...event,
    tests: event.tests.map(({ error, ...test }) =>
      error ? { ...test, finding: serializeFinding(findRuntimeFinding(fileName, level, error)) } : test,
    ),
    ...(event.malformed
      ? {
          malformed: event.malformed.map(({ problem, ...test }) =>
            problem
              ? { ...test, finding: serializeFinding({ ...problem, fileName: problem.fileName ?? fileName, level }) }
              : test,
          ),
        }
      : {}),
  };
}
