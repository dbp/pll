import { explainNameError } from "../errors/nameErrorExplainer";
import type { AnalysisFinding, RuntimeAnalyzer, RuntimeAnalyzerInput } from "./types";

/**
 * `UnboundLocalError` is a subclass of `NameError` and the same mistake to
 * a student - a name used before it has a value - but it arrives under its
 * own type, so it was falling through to a bare traceback.
 */
const HANDLED = ["NameError", "UnboundLocalError"];

export const nameErrorAnalyzer: RuntimeAnalyzer = {
  handles: HANDLED,
  analyze(input: RuntimeAnalyzerInput): AnalysisFinding | null {
    const { parsedError, fileName, level } = input;
    if (!HANDLED.includes(parsedError.errorType)) {
      return null;
    }
    const explanation = explainNameError(parsedError);
    return {
      id: "name-error",
      errorType: parsedError.errorType,
      message: parsedError.message,
      headline: explanation.headline,
      howToFix: explanation.howToFix,
      fileName,
      lineNumber: parsedError.lineNumber,
      column: parsedError.column,
      nameToken: parsedError.nameToken,
      severity: "error",
      raw: parsedError.traceback,
      origin: "runtime",
      level,
    };
  },
};
