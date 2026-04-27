import type { ParsedPythonError } from "../errors/pythonErrorParser";

export interface AnalysisFinding {
  /** Short id like "name-error" or "shadowing". */
  id: string;
  /** The exception/lint type, e.g. "NameError" or "F811". */
  errorType: string;
  /** Plain Python-style message used as a fallback. */
  message: string;
  /** Beginner-friendly headline (single line). */
  headline: string;
  /** Beginner-friendly explanation, one entry per paragraph. */
  whatHappened: string[];
  whyItHappens: string[];
  howToFix: string[];
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
}

export interface AnalyzerContext {
  /** Source code being analyzed. */
  source: string;
  /** Display name (path) for diagnostics. */
  fileName: string;
}

export interface RuntimeAnalyzerInput extends AnalyzerContext {
  parsedError: ParsedPythonError;
}

/**
 * Analyzer that turns a runtime Python exception into a friendly finding.
 * Implemented today for NameError; later analyzers can layer on for other
 * runtime errors.
 */
export interface RuntimeAnalyzer {
  readonly kind: "runtime";
  /** Errors this analyzer handles (e.g. ["NameError"]). */
  readonly handles: ReadonlyArray<string>;
  analyze(input: RuntimeAnalyzerInput): AnalysisFinding | null;
}

/**
 * Static analyzer (future). Will run over `source` without executing it,
 * useful for checks like variable shadowing where you don't want to wait
 * for a runtime exception.
 */
export interface StaticAnalyzer {
  readonly kind: "static";
  readonly id: string;
  analyze(input: AnalyzerContext): Promise<AnalysisFinding[]>;
}

export type Analyzer = RuntimeAnalyzer | StaticAnalyzer;
