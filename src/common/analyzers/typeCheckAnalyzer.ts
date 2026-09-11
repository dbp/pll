import { userTracebackFrames } from "../errors/pythonErrorParser";
import {
  explainTypeCheckError,
  parseTypeCheckMessage,
} from "../errors/typeCheckExplainer";
import type { AnalysisFinding, RuntimeAnalyzer, RuntimeAnalyzerInput } from "./types";

/**
 * typeguard raises `TypeCheckError`; the traceback spells it
 * `typeguard.TypeCheckError`, so both spellings have to be handled.
 */
const HANDLED = ["TypeCheckError", "typeguard.TypeCheckError"];

/**
 * typeguard's union failures span several lines:
 *
 *   argument "x" (str) did not match any element in the union:
 *     int: is not an instance of int
 *     NoneType: is not an instance of NoneType
 *
 * `parsePythonError` keeps only the first line, which drops exactly the
 * part naming the accepted types, so recover the rest from the traceback.
 */
function messageWithDetail(traceback: string, fallback: string): string {
  const lines = traceback.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const marker = line.indexOf("TypeCheckError:");
    if (line.startsWith(" ") || marker < 0) continue;
    const detail = [line.slice(marker + "TypeCheckError:".length).trim()];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === "") continue;
      if (!lines[j].startsWith(" ")) break;
      detail.push(lines[j]);
    }
    return detail.join("\n");
  }
  return fallback;
}

export const typeCheckAnalyzer: RuntimeAnalyzer = {
  handles: HANDLED,
  analyze(input: RuntimeAnalyzerInput): AnalysisFinding | null {
    const { parsedError, fileName, level } = input;
    if (!HANDLED.includes(parsedError.errorType)) {
      return null;
    }
    const message = messageWithDetail(parsedError.traceback, parsedError.message);
    const parsed = parseTypeCheckMessage(message);
    const frames = userTracebackFrames(parsedError.traceback);
    const innermost = frames.length > 0 ? frames[frames.length - 1] : null;

    // An argument is checked on entry to the callee, so the innermost frame
    // is the `def` line. The mistake is at the call, one frame out.
    const blamed =
      parsed.kind === "argument" && frames.length >= 2
        ? frames[frames.length - 2]
        : innermost;

    const explanation = explainTypeCheckError(
      message,
      innermost ? innermost.functionName : null,
      level,
    );

    return {
      id: "type-check",
      // Not a real Python exception name; "TypeCheckError" means nothing to
      // a student, and "TypeError" would name a different Python error.
      errorType: "TypeMismatch",
      message,
      headline: explanation.headline,
      howToFix: explanation.howToFix,
      fileName: blamed ? blamed.fileName : fileName,
      lineNumber: blamed ? blamed.line : parsedError.lineNumber,
      column: null,
      nameToken: parsed.name,
      severity: "error",
      raw: parsedError.traceback,
      origin: "runtime",
      level,
    };
  },
};
