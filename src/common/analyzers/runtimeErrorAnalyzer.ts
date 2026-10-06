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
    headline: headlineFor(error.errorType, error.message),
    // Deliberately empty. A generic error has no generic remedy, and
    // inventing one would be worse than the message itself.
    howToFix: [],
    lineNumber: row ?? place.lineNumber,
    column: error.frames.length === 0 ? place.column : null,
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

/** The message as a sentence a student can read. */
function headlineFor(errorType: string, message: string): string {
  const text = message.trim();
  // A Stop, which the student asked for: not something their code did
  // wrong, and "KeyboardInterrupt while running your program" read as one.
  if (errorType === "KeyboardInterrupt") {
    return "The program was stopped.";
  }
  if (!text) {
    return `${errorType} while running your program.`;
  }
  if (errorType === "KeyError") {
    // `str(KeyError(x))` is the *repr* of x, so a message that was written
    // as a sentence arrives wrapped in quotes: unwrap that one. A plain
    // missing key arrives the same way (`'rider'`) but is not a sentence,
    // and unwrapping it produced `KeyError: rider.` - which reads like
    // prose and says less than Python did. Leave that exactly as Python
    // wrote it; giving it real wording needs to know it came from a table
    // row, which belongs with the row-specific work, not here.
    const unquoted = text.match(/^'([\s\S]*)'$/) ?? text.match(/^"([\s\S]*)"$/);
    if (unquoted === null || !/\s/.test(unquoted[1])) {
      return text;
    }
    return punctuated(unquoted[1]);
  }
  return punctuated(text);
}
