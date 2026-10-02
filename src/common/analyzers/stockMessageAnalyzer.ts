import type { TracebackFrame } from "../errors/pythonErrorParser";
import { userTracebackFrames } from "../errors/pythonErrorParser";
import { explainStockMessage } from "../errors/stockMessageExplainer";
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
  handles: [
    "TypeError",
    "AttributeError",
    "ValueError",
    "IndexError",
    "RecursionError",
    "KeyError",
  ],

  analyze(input: RuntimeAnalyzerInput): AnalysisFinding | null {
    const { source, fileName, parsedError, level } = input;
    const frames = userTracebackFrames(parsedError.traceback);
    const blamed = frames.length > 0 ? frames[frames.length - 1] : null;
    const explanation = explainStockMessage(parsedError.errorType, parsedError.message, {
      source,
      offendingLine: offendingLine(source, fileName, blamed, parsedError.lineNumber),
      traceback: parsedError.traceback,
      level,
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

/**
 * The student's own text of the line that raised.
 *
 * Several rules need it - `for x in len(xs)` is only distinguishable from
 * any other `'int' object is not iterable` by reading the line. Returns
 * null unless the frame really belongs to the file in hand: a line pulled
 * out of the wrong file would make the explanation confidently wrong.
 */
function offendingLine(
  source: string,
  fileName: string,
  blamed: TracebackFrame | null,
  fallbackLine: number | null,
): string | null {
  const line = blamed !== null ? blamed.line : fallbackLine;
  if (line === null) {
    return null;
  }
  if (blamed !== null && basename(blamed.fileName) !== basename(fileName)) {
    return null;
  }
  const lines = source.split(/\r?\n/);
  return line >= 1 && line <= lines.length ? lines[line - 1] : null;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
