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

/**
 * Library functions that call the student's own function for them.
 *
 * Their frames are inside `<exec>` and so are filtered out of the user
 * frames, but the traceback still names them - and knowing which one it
 * was changes the advice completely.
 */
const LIBRARY_CALLERS = [
  "filter",
  "transform_column",
  "add_column",
  "animate",
  "big_bang",
];

/**
 * Frames that mean a reactor called the handler.
 *
 * There are several, because a handler is reached through whichever of
 * them is driving at the time - showing the first frame, a tick, a key.
 * They all amount to the same thing for the student, so they map to one
 * name: the value came from the reactor's state, not from any line.
 */
const REACTOR_FRAMES = [
  "_pll_reactor_interact",
  "_pll_reactor_view",
  "_pll_reactor_step",
  "interact",
  "react",
  "tick",
  "step",
];

function libraryCaller(traceback: string): string | null {
  for (const line of traceback.split(/\r?\n/)) {
    const frame = /^\s*File "([^"]+)", line \d+, in (\S+)$/.exec(line);
    if (frame === null || !frame[1].includes("<exec>")) {
      continue;
    }
    if (LIBRARY_CALLERS.includes(frame[2])) {
      return frame[2];
    }
    if (REACTOR_FRAMES.includes(frame[2])) {
      return "reactor";
    }
  }
  return null;
}

/** The student's text of `frame`'s line, when the frame is in this file. */
function lineOf(
  source: string,
  fileName: string,
  frame: { fileName: string; line: number } | null,
): string | null {
  if (frame === null) {
    return null;
  }
  const basename = (path: string) => path.split(/[\\/]/).pop() ?? path;
  if (basename(frame.fileName) !== basename(fileName)) {
    return null;
  }
  const lines = source.split(/\r?\n/);
  return frame.line >= 1 && frame.line <= lines.length ? lines[frame.line - 1] : null;
}

export const typeCheckAnalyzer: RuntimeAnalyzer = {
  handles: HANDLED,
  analyze(input: RuntimeAnalyzerInput): AnalysisFinding | null {
    const { parsedError, fileName, level, source } = input;
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
      // The line the check fired on, which for a return is the `return`
      // itself - or, when the function ran off its end, is not one.
      {
        source,
        line: lineOf(source, fileName, innermost),
        calledBy: libraryCaller(parsedError.traceback),
      },
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
