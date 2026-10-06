import { innermostUserFrame, type ErrorFrame } from "../errors/pythonError";
import { sourceLine } from "../errors/sourceFacts";
import type { RuntimeAnalyzerInput } from "./types";

/** Where an error is, as a finding reports it, and the student's line there. */
export interface ErrorPlace {
  fileName: string;
  lineNumber: number | null;
  /** 0-based, where Python draws a caret under the student's own line. */
  column: number | null;
  text: string | null;
}

/** The errors Python places itself: the position is the error's, not a frame's. */
const PLACED_BY_PYTHON = ["SyntaxError", "IndentationError", "TabError"];

/**
 * Where an error is, for every analyzer: a syntax error where Python says
 * it is, and anything else at the innermost frame that runs the student's
 * code - in whichever of their files that is, not necessarily the one that
 * was run.
 *
 * With no frame of the student's, the innermost one is PLL's or a
 * library's, and its line means nothing in their file, so there is no line.
 */
export function placeOf(input: RuntimeAnalyzerInput): ErrorPlace {
  const { error, fileName } = input;
  if (PLACED_BY_PYTHON.includes(error.errorType) || error.frames.length === 0) {
    const file = error.fileName ?? fileName;
    return {
      fileName: file,
      lineNumber: error.lineNumber,
      column: error.column,
      text: error.text ?? lineOfRun(input, file, error.lineNumber),
    };
  }
  const frame = innermostUserFrame(error);
  if (frame === null) {
    return { fileName, lineNumber: null, column: null, text: null };
  }
  return {
    fileName: frame.fileName,
    lineNumber: frame.line,
    // A caret is about the frame that raised; only there is it theirs.
    column: frame === error.frames[error.frames.length - 1] ? frame.column : null,
    text: frameText(input, frame),
  };
}

/** The student's line at `frame`: Python sends it; the run's own code is the fallback. */
export function frameText(input: RuntimeAnalyzerInput, frame: ErrorFrame | null): string | null {
  if (frame === null) return null;
  return frame.text ?? lineOfRun(input, frame.fileName, frame.line);
}

/** Whether `place` is in the file that was run, whose source the host has. */
export function inRunFile(input: RuntimeAnalyzerInput, place: ErrorPlace): boolean {
  return place.fileName === input.fileName;
}

/**
 * A line of the code that was run - a prompt line has no file Python can
 * read back - and only of it: another file's line number means nothing here.
 */
function lineOfRun(input: RuntimeAnalyzerInput, file: string, line: number | null): string | null {
  return file === input.fileName ? sourceLine(input.source, line) : null;
}
