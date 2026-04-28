import type { Level } from "../../level";
import type { RawStaticFinding } from "../../pyodideRunner";
import type { AnalysisFinding } from "../types";

/**
 * Build an AnalysisFinding for "name is assigned more than once in the same
 * scope" from the Python static analyzer.
 *
 * The raw finding's `line_number` points at the *second* assignment (the one
 * that's flagged). `first_line_number` points at the original binding so we
 * can mention it in the explanation.
 */
export function explainReassignment(
  raw: RawStaticFinding,
  level: Level,
  fileName: string,
): AnalysisFinding {
  const name = raw.name_token ?? "this name";
  const firstLine = raw.first_line_number ?? null;
  const firstLineHint = firstLine !== null ? ` (first assigned on line ${firstLine})` : "";

  return {
    id: "reassignment",
    errorType: "Reassignment",
    message: raw.message,
    headline: `\`${name}\` is already assigned${firstLineHint}.`,
    whatHappened: [
      `In beginner mode each variable name can only be assigned once per scope.` +
        ` \`${name}\` was already given a value earlier in this scope, and this` +
        ` line tries to assign to it again.`,
    ],
    whyItHappens: [
      `Variables that change value over time are a major source of bugs for` +
        ` people new to programming. Beginner mode makes each name stand for` +
        ` exactly one value so you can read code top-to-bottom without` +
        ` mentally tracking "what is \`${name}\` right now?".`,
    ],
    howToFix: [
      `If you want a different value, give it a different name (e.g.` +
        ` \`${name}_doubled\`, \`new_${name}\`, \`${name}2\`).`,
      `If you're trying to update a value (\`x = x + 1\`, accumulators,` +
        ` running totals), use a built-in like \`sum(...)\`, \`max(...)\`,` +
        ` or a small helper function that returns the new value instead.`,
    ],
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
