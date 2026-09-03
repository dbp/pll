import type { Level } from "../level";
import type { ParsedPythonError } from "../errors/pythonErrorParser";

export interface AnalysisFinding {
  /** Short id like "name-error" or "shadowing". */
  id: string;
  /** The exception/lint type, e.g. "NameError", "Shadowing", "Reassignment". */
  errorType: string;
  /** Plain Python-style message used as a fallback. */
  message: string;
  /** Beginner-friendly headline (single line). */
  headline: string;
  /** Beginner-friendly next steps, one entry per bullet. */
  howToFix: string[];
  /** Display file name passed to the analyzer (e.g. "hello.py" or "<repl>"). */
  fileName: string;
  /** 1-based line number in the analyzed file (null if unknown). */
  lineNumber: number | null;
  /** 1-based column (null if unknown). */
  column: number | null;
  /** Identifier the issue is about (used to narrow the highlight). */
  nameToken: string | null;
  /** Severity hint - matches vscode.DiagnosticSeverity values without importing it here. */
  severity: "error" | "warning" | "info";
  /** Original raw traceback / linter output for debugging. */
  raw: string;
  /**
   * Where the finding came from. Used so the diagnostics layer can label
   * the source ("pll / runtime" vs "pll / static") and so future
   * suppression rules can target one or the other.
   */
  origin: "runtime" | "static";
  /** Language level under which this finding was produced. */
  level: Level;
}

export interface AnalyzerContext {
  /** Source code being analyzed. */
  source: string;
  /** Display name (path) for diagnostics. */
  fileName: string;
  /** Active language level. */
  level: Level;
}

export interface RuntimeAnalyzerInput extends AnalyzerContext {
  parsedError: ParsedPythonError;
}

/**
 * Analyzer that turns a runtime Python exception into a friendly finding.
 * Implemented today for NameError; later analyzers can layer on for other
 * runtime errors. The `level` on the input lets analyzers tailor the
 * explanation to features available at that level.
 */
export interface RuntimeAnalyzer {
  /** Errors this analyzer handles (e.g. ["NameError"]). */
  readonly handles: ReadonlyArray<string>;
  analyze(input: RuntimeAnalyzerInput): AnalysisFinding | null;
}
