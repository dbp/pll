import { explainSyntaxError } from "../errors/syntaxExplainer";
import { placeOf } from "./errorPlace";
import { runtimeFindingFor, type AnalysisFinding, type RuntimeAnalyzer, type RuntimeAnalyzerInput } from "./types";

/** Parsing failures. `TabError` is a subclass of `IndentationError`. */
const HANDLED = ["SyntaxError", "IndentationError", "TabError"];

export const syntaxErrorAnalyzer: RuntimeAnalyzer = {
  handles: HANDLED,
  analyze(input: RuntimeAnalyzerInput): AnalysisFinding | null {
    const { error } = input;
    // The student's own line is what makes these recognisable. Python has
    // already forgotten the construct by the time it reports: `else if`
    // arrives as "expected ':'", because it parsed `else` and then wanted
    // the colon.
    const offendingLine = placeOf(input).text;
    return runtimeFindingFor(input, {
      id: "syntax-error",
      ...explainSyntaxError(error.errorType, error.message, offendingLine),
      nameToken: null,
    });
  },
};
