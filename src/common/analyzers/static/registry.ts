import type { Level } from "../../level";
import type { RawStaticFinding } from "../../pyodideRunner";
import type { AnalysisFinding } from "../types";
import { explainShadowing, explainShadowingBuiltin } from "./shadowingExplainer";
import { explainReassignment } from "./reassignmentExplainer";

export type StaticExplainer = (
  raw: RawStaticFinding,
  level: Level,
  fileName: string,
) => AnalysisFinding;

const explainers: Record<string, StaticExplainer> = {
  shadowing: explainShadowing,
  "shadowing-builtin": explainShadowingBuiltin,
  reassignment: explainReassignment,
};

/**
 * Register a custom explainer for a static-analyzer finding id. Useful for
 * adding more checks (e.g. "comparison-vs-assignment") without touching this
 * file.
 */
export function registerStaticExplainer(id: string, explainer: StaticExplainer): void {
  explainers[id] = explainer;
}

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
    whatHappened: [raw.message],
    whyItHappens: [],
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
