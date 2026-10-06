import { explainNameError } from "../errors/nameErrorExplainer";
import { inRunFile, placeOf } from "./errorPlace";
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
    // "defined further down" and from "that is a parameter, not a value" -
    // and only the run's own file is read for that, not one it imported.
    const place = placeOf(input);
    const context = { source: inRunFile(input, place) ? source : "", line: place.text };
    return runtimeFindingFor(input, { id: "name-error", ...explainNameError(error, context) });
  },
};
