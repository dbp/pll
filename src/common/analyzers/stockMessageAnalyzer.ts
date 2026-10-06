import { explainStockMessage, stockErrorTypes } from "../errors/stockMessageExplainer";
import { placeOf } from "./errorPlace";
import { analyzeRuntimeError } from "./runtimeErrorAnalyzer";
import type { AnalysisFinding, RuntimeAnalyzer, RuntimeAnalyzerInput } from "./types";

/**
 * Reword the stock Python messages that a beginner cannot act on.
 *
 * Sits between the error-specific analyzers and the catch-all: those know
 * their error completely and win, while this one claims whatever it
 * recognises and leaves the rest to `analyzeRuntimeError`, which shows
 * Python's own words. The location, the caret and the traceback all come
 * from the catch-all, so there is one copy of that reasoning - only the
 * sentence a student reads is different.
 */
export const stockMessageAnalyzer: RuntimeAnalyzer = {
  // Exactly what the rules are for: the list is theirs, not a copy of it.
  handles: stockErrorTypes(),

  analyze(input: RuntimeAnalyzerInput): AnalysisFinding | null {
    const { error } = input;
    const explanation = explainStockMessage(error.errorType, error.message, {
      // The line that raised, which several rules need - `for x in len(xs)`
      // is only told apart from any other `'int' object is not iterable` by
      // reading it.
      offendingLine: placeOf(input).text,
      frames: error.frames,
      facts: error.facts,
    });
    if (explanation === null) {
      return null;
    }
    return {
      ...analyzeRuntimeError(input),
      id: "stock-message",
      headline: explanation.headline,
      howToFix: explanation.howToFix,
    };
  },
};
