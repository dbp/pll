import { libraryCaller } from "../errors/libraryFacts";
import { userFrames } from "../errors/pythonError";
import { frameText } from "./errorPlace";
import { explainTypeCheckError } from "../errors/typeCheckExplainer";
import { runtimeFindingFor, type AnalysisFinding, type RuntimeAnalyzer, type RuntimeAnalyzerInput } from "./types";

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
        calledBy: libraryCaller(error.frames),
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
