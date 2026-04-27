import { explainNameError } from "../errors/nameErrorExplainer";
import type { AnalysisFinding, RuntimeAnalyzer, RuntimeAnalyzerInput } from "./types";

export const nameErrorAnalyzer: RuntimeAnalyzer = {
  kind: "runtime",
  handles: ["NameError"],
  analyze(input: RuntimeAnalyzerInput): AnalysisFinding | null {
    const { parsedError } = input;
    if (parsedError.errorType !== "NameError") {
      return null;
    }
    const explanation = explainNameError(parsedError);
    return {
      id: "name-error",
      errorType: "NameError",
      message: parsedError.message,
      headline: explanation.headline,
      whatHappened: explanation.whatHappened,
      whyItHappens: explanation.whyItHappens,
      howToFix: explanation.howToFix,
      lineNumber: parsedError.lineNumber,
      column: parsedError.column,
      nameToken: parsedError.nameToken,
      severity: "error",
      raw: parsedError.traceback,
    };
  },
};
