import { explainSyntaxError } from "../errors/syntaxExplainer";
import type { AnalysisFinding, RuntimeAnalyzer, RuntimeAnalyzerInput } from "./types";

/** Parsing failures. `TabError` is a subclass of `IndentationError`. */
const HANDLED = ["SyntaxError", "IndentationError", "TabError"];

export const syntaxErrorAnalyzer: RuntimeAnalyzer = {
  handles: HANDLED,
  analyze(input: RuntimeAnalyzerInput): AnalysisFinding | null {
    const { parsedError, source, fileName, level } = input;
    if (!HANDLED.includes(parsedError.errorType)) {
      return null;
    }
    // The student's own line is what makes these recognisable. Python has
    // already forgotten the construct by the time it reports: `else if`
    // arrives as "expected ':'", because it parsed `else` and then wanted
    // the colon.
    const lines = source.split(/\r?\n/);
    const offendingLine =
      parsedError.lineNumber !== null ? (lines[parsedError.lineNumber - 1] ?? null) : null;
    const explanation = explainSyntaxError(
      parsedError.errorType,
      parsedError.message,
      offendingLine,
    );
    return {
      id: "syntax-error",
      errorType: parsedError.errorType,
      message: parsedError.message,
      headline: explanation.headline,
      howToFix: explanation.howToFix,
      fileName,
      lineNumber: parsedError.lineNumber,
      column: parsedError.column,
      nameToken: null,
      severity: "error",
      raw: parsedError.traceback,
      origin: "runtime",
      level,
    };
  },
};
