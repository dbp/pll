import { FUNCTION_TAKER_NAMES } from "../errors/libraryFacts";
import { PLL_LIBRARY_FILES } from "../pythonFiles";
import { userFrames, type PythonError } from "../errors/pythonError";
import { frameText } from "./errorPlace";
import { explainTypeCheckError } from "../errors/typeCheckExplainer";
import { runtimeFindingFor, type AnalysisFinding, type RuntimeAnalyzer, type RuntimeAnalyzerInput } from "./types";

/**
 * The library function that called the student's function, if one did -
 * "reactor" for any frame in the reactor library, whichever of its methods
 * was driving. Its frames are PLL's, not the student's, but they are there
 * to be read, and knowing which one it was changes the advice completely.
 */
function libraryCaller(error: PythonError): string | null {
  for (const { fileName, functionName } of error.frames) {
    if (fileName === PLL_LIBRARY_FILES.reactor) {
      return "reactor";
    }
    const inLibrary = fileName === PLL_LIBRARY_FILES.table || fileName === PLL_LIBRARY_FILES.image;
    if (inLibrary && functionName !== null && FUNCTION_TAKER_NAMES.includes(functionName)) {
      return functionName;
    }
  }
  return null;
}

export const typeCheckAnalyzer: RuntimeAnalyzer = {
  handles: ["TypeCheckError"],
  analyze(input: RuntimeAnalyzerInput): AnalysisFinding | null {
    const { error, fileName, level } = input;
    const check = error.facts.check;
    const frames = userFrames(error);
    const innermost = frames.length > 0 ? frames[frames.length - 1] : null;

    // An argument is checked on entry to the callee, so the innermost frame
    // is the `def` line. The mistake is at the call, one frame out.
    const blamed =
      check?.kind === "argument" && frames.length >= 2
        ? frames[frames.length - 2]
        : innermost;

    const explanation = explainTypeCheckError(
      error.message,
      innermost ? innermost.functionName : null,
      level,
      // The line the check fired on, which for a return is the `return`
      // itself - or, when the function ran off its end, is not one.
      {
        line: frameText(input, innermost),
        calledBy: libraryCaller(error),
        facts: error.facts,
      },
    );

    return runtimeFindingFor(input, {
      id: "type-check",
      // Not a real Python exception name; "TypeCheckError" means nothing to
      // a student, and "TypeError" would name a different Python error.
      errorType: "TypeMismatch",
      ...explanation,
      fileName: blamed ? blamed.fileName : fileName,
      lineNumber: blamed ? blamed.line : error.lineNumber,
      column: null,
      nameToken: check?.name ?? null,
    });
  },
};
