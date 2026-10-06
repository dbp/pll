import type { Level } from "../level";
import type { PythonError } from "../errors/pythonError";
import type { StaticFinding } from "../fromPython";
import { placeOf } from "./errorPlace";

export interface AnalysisFinding {
  /** Short id like "name-error" or "shadowing". */
  id: string;
  /** The exception/lint type, e.g. "NameError", "Shadowing", "Reassignment". */
  errorType: string;
  /** Beginner-friendly headline (single line). */
  headline: string;
  /** Beginner-friendly next steps, one entry per bullet. */
  howToFix: string[];
  /** Display file name passed to the analyzer (e.g. "hello.py" or "<repl>"). */
  fileName: string;
  /** 1-based line number in the analyzed file (null if unknown). */
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

export interface AnalyzerContext {
  /** Source code being analyzed. */
  source: string;
  /** Display name (path) for diagnostics. */
  fileName: string;
  /** Active language level. */
  level: Level;
}

export interface RuntimeAnalyzerInput extends AnalyzerContext {
  error: PythonError;
}

/**
 * A runtime finding about `input.error`, given only what this one says
 * differently. Everything else - what Python called it, and where it is
 * (`placeOf`) - is the error's own.
 */
export function runtimeFindingFor(
  input: RuntimeAnalyzerInput,
  fields: Pick<AnalysisFinding, "id" | "headline" | "howToFix"> & Partial<AnalysisFinding>,
): AnalysisFinding {
  const { error, level } = input;
  const place = placeOf(input);
  return {
    errorType: error.errorType,
    fileName: place.fileName,
    lineNumber: place.lineNumber,
    column: place.column,
    nameToken: error.nameToken,
    severity: "error",
    origin: "runtime",
    level,
    ...fields,
  };
}

/**
 * A static finding about `raw`, given its explanation. What it is and where
 * are the raw finding's own.
 */
export function staticFindingFor(
  raw: StaticFinding,
  level: Level,
  fileName: string,
  fields: Pick<AnalysisFinding, "headline" | "howToFix"> & Partial<AnalysisFinding>,
): AnalysisFinding {
  return {
    id: raw.id,
    errorType: raw.errorType,
    fileName,
    lineNumber: raw.lineNumber,
    column: raw.column,
    nameToken: raw.nameToken,
    severity: "error",
    origin: "static",
    level,
    ...fields,
  };
}

/**
 * Turns the runtime errors it `handles` into a friendly finding, or returns
 * null to leave one to the analyzers after it. The `level` on the input lets
 * an analyzer tailor the explanation to what that level allows.
 */
export interface RuntimeAnalyzer {
  /** Errors this analyzer handles (e.g. ["NameError"]). */
  readonly handles: ReadonlyArray<string>;
  analyze(input: RuntimeAnalyzerInput): AnalysisFinding | null;
}
