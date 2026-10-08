import { tableRowLine } from "../errors/sourceFacts";
import { punctuated } from "../errors/wording";
import { inRunFile, placeOf } from "./errorPlace";
import { runtimeFindingFor, type AnalysisFinding, type RuntimeAnalyzerInput } from "./types";

/**
 * The last resort: turn *any* runtime error into a finding.
 *
 * It says nothing new. It locates the error in the student's own code and
 * puts Python's message where they will read it, rather than leaving it at
 * the end of a traceback through PLL's machinery (`File "<exec>", line
 * 560, in table`) or dozens of lines of pandas - the message a student
 * needs is usually already clear (`No column named 'rider' (have: month,
 * riders)`). Analyzers that know an error well run first and win.
 */
export function analyzeRuntimeError(input: RuntimeAnalyzerInput): AnalysisFinding {
  const { error } = input;
  // The innermost frame the student wrote. When a library raised, that is
  // the line that called into it, which is the line to point at.
  const place = placeOf(input);
  // A table's rows are read from the source, which the host has only for
  // the file that was run.
  const row = inRunFile(input, place) ? rowLine(input.source, place.lineNumber, error.message) : null;
  return runtimeFindingFor(input, {
    id: "runtime-error",
    headline: headlineFor(error.errorType, error.message, error.facts?.stop === true, raisedByStudent(input)),
    // Deliberately empty. A generic error has no generic remedy, and
    // inventing one would be worse than the message itself.
    howToFix: [],
    lineNumber: row ?? place.lineNumber,
    column: place.column,
  });
}

/**
 * The line of the row a `table(...)` error is about, when it can be found.
 *
 * The error is raised inside the library, so the innermost frame that is
 * the student's is the `table(` line. The message names the row by
 * position ("the 2nd row, ..."), and for rows written out in place that
 * row has a line of its own - the one worth pointing at.
 */
function rowLine(source: string, callLine: number | null, message: string): number | null {
  if (callLine === null) {
    return null;
  }
  const ordinal = /\bthe (\d+)(?:st|nd|rd|th) row\b/.exec(message);
  if (ordinal === null) {
    return null;
  }
  return tableRowLine(source, callLine, Number(ordinal[1]) - 1);
}

/**
 * Whether the error is one the student raised themselves - its innermost
 * frame is theirs, at a `raise` - so its message is theirs too.
 */
function raisedByStudent(input: RuntimeAnalyzerInput): boolean {
  const innermost = input.error.frames[input.error.frames.length - 1];
  return innermost?.user === true && /^\s*raise\b/.test(innermost.text ?? "");
}

/** The message as a sentence a student can read - or, theirs, as they wrote it. */
function headlineFor(errorType: string, message: string, stop: boolean, theirs: boolean): string {
  const text = message.trim();
  // A Stop, which the student asked for: not something their code did
  // wrong, and "KeyboardInterrupt while running your program" would read
  // as one. A `KeyboardInterrupt` the program raised itself is its error.
  if (errorType === "KeyboardInterrupt" && stop) {
    return "The program was stopped.";
  }
  if (!text) {
    return `${errorType} while running your program.`;
  }
  // A message the student wrote is given as they wrote it, without a
  // period added.
  const finish = theirs ? (sentence: string) => sentence : punctuated;
  if (errorType === "KeyError") {
    // `str(KeyError(x))` is the *repr* of x, so a message that was written
    // as a sentence arrives wrapped in quotes: unwrap that one. A plain
    // missing key arrives the same way (`'rider'`) but is not a sentence:
    // unwrapped, `KeyError: rider.` would read like prose and say less
    // than Python did, so it is left exactly as Python wrote it.
    const unquoted = text.match(/^'([\s\S]*)'$/) ?? text.match(/^"([\s\S]*)"$/);
    if (unquoted === null || !/\s/.test(unquoted[1])) {
      return text;
    }
    return finish(unquoted[1]);
  }
  return finish(text);
}
