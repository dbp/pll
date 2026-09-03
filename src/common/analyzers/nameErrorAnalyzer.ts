import { explainNameError } from "../errors/nameErrorExplainer";
import type { AnalysisFinding, RuntimeAnalyzer, RuntimeAnalyzerInput } from "./types";

export const nameErrorAnalyzer: RuntimeAnalyzer = {
  handles: ["NameError"],
  analyze(input: RuntimeAnalyzerInput): AnalysisFinding | null {
    const { parsedError, fileName, level } = input;
    if (parsedError.errorType !== "NameError") {
      return null;
    }
    const explanation = explainNameError(parsedError);
    return {
      id: "name-error",
      errorType: "NameError",
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
