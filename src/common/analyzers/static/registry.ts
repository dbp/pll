import type { Level } from "../../level";
import type { RawStaticFinding } from "../../pyodideRunner";
import type { AnalysisFinding } from "../types";
import {
  explainShadowing,
  explainShadowingBuiltin,
  explainShadowingLibrary,
} from "./shadowingExplainer";
import { explainReassignment } from "./reassignmentExplainer";
import { explainDisallowedKeyword } from "./disallowedKeywordExplainer";
import {
  explainAnnotationNotAType,
  explainAssertTuple,
  explainClassNeedsDataclass,
  explainComparedWithClass,
  explainFieldAssignedType,
  explainFieldNoType,
  explainMethodNotCalled,
  explainTestNotNamed,
  explainUnusedComparison,
  explainUnusedValue,
} from "./silenceExplainer";
import { explainDuplicateDefinition } from "./duplicateDefinitionExplainer";

export type StaticExplainer = (
  raw: RawStaticFinding,
  level: Level,
  fileName: string,
) => AnalysisFinding;

/** Add an entry here to give another static-analyzer id a friendly finding. */
const explainers: Record<string, StaticExplainer> = {
  shadowing: explainShadowing,
  "shadowing-builtin": explainShadowingBuiltin,
  "shadowing-library": explainShadowingLibrary,
  reassignment: explainReassignment,
  "disallowed-keyword": explainDisallowedKeyword,
  "unused-comparison": explainUnusedComparison,
  "unused-value": explainUnusedValue,
  "assert-tuple": explainAssertTuple,
  "method-not-called": explainMethodNotCalled,
  "annotation-not-a-type": explainAnnotationNotAType,
  "test-not-named": explainTestNotNamed,
  "field-no-type": explainFieldNoType,
  "field-assigned-type": explainFieldAssignedType,
  "class-needs-dataclass": explainClassNeedsDataclass,
  "compared-with-class": explainComparedWithClass,
  "duplicate-definition": explainDuplicateDefinition,
};

function fallbackExplainer(
  raw: RawStaticFinding,
  level: Level,
  fileName: string,
): AnalysisFinding {
  return {
    id: raw.id,
    errorType: raw.error_type || "StaticError",
    message: raw.message,
    headline: raw.message,
    howToFix: [],
    fileName,
    lineNumber: raw.line_number,
    column: raw.column,
    nameToken: raw.name_token,
    severity: "error",
    raw: JSON.stringify(raw),
    origin: "static",
    level,
  };
}

/**
 * Convert raw Python-side static findings into beginner-friendly
 * AnalysisFinding objects, ready for the diagnostics + REPL renderer.
 */
export function enrichStaticFindings(
  rawFindings: ReadonlyArray<RawStaticFinding>,
  level: Level,
  fileName: string,
): AnalysisFinding[] {
  return rawFindings.map((raw) => {
    const explainer = explainers[raw.id] ?? fallbackExplainer;
    return explainer(raw, level, fileName);
  });
}
