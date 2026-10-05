import { explainNameError } from "../errors/nameErrorExplainer";
import { sourceLine } from "../errors/sourceFacts";
import { runtimeFindingFor, type AnalysisFinding, type RuntimeAnalyzer, type RuntimeAnalyzerInput } from "./types";

/**
 * `UnboundLocalError` is a subclass of `NameError` and the same mistake to
 * a student - a name used before it has a value - but it arrives under its
 * own type, so it is named here.
 */
const HANDLED = ["NameError", "UnboundLocalError"];

export const nameErrorAnalyzer: RuntimeAnalyzer = {
  handles: HANDLED,
  analyze(input: RuntimeAnalyzerInput): AnalysisFinding | null {
    const { error, source } = input;
    // The file and the failing line let this tell "never heard of it" from
    // "defined further down" and from "that is a parameter, not a value".
    const line = sourceLine(source, error.lineNumber);
    return runtimeFindingFor(input, { id: "name-error", ...explainNameError(error, { source, line }) });
  },
};
