import type { Level } from "../../level";
import type { RawStaticFinding, RawStaticFindingOf } from "../../wire";
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

/**
 * One explainer for every kind of finding, each given only its own kind -
 * so a new kind in `RawStaticFinding` does not compile until it has one.
 */
const explainers: {
  [Id in RawStaticFinding["id"]]: (raw: RawStaticFindingOf<Id>, level: Level, fileName: string) => AnalysisFinding;
} = {
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
    // An id this version does not know - a newer bootstrap, say - still
    // gets Python's own wording rather than nothing.
    const explainer =
      (explainers as Record<string, (raw: RawStaticFinding, level: Level, fileName: string) => AnalysisFinding>)[
        raw.id
      ] ?? fallbackExplainer;
    return explainer(withPositions(raw), level, fileName);
  });
}

/**
 * The finding with its positions as numbers or null. A Python `None`
 * arrives as `undefined`, which passes a `!== null` test and used to reach
 * a label as `file.py:3:NaN`.
 */
function withPositions(raw: RawStaticFinding): RawStaticFinding {
  const position = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  return {
    ...raw,
    line_number: position(raw.line_number),
    column: position(raw.column),
    name_token: raw.name_token ?? null,
  };
}
