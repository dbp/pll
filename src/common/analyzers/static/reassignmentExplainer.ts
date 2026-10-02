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
  // Line 0 is a preexisting session binding (REPL after Run File), not a
  // line in the snippet / file.
  const firstLineHint =
    firstLine !== null && firstLine > 0 ? ` (first assigned on line ${firstLine})` : "";

  return {
    id: "reassignment",
    errorType: "Reassignment",
    message: raw.message,
    headline: `\`${name}\` is already assigned${firstLineHint}.`,
    howToFix:
      level === "intermediate"
        ? [
            `If you want a different value, give it a different name (e.g.` +
              ` \`${name}_doubled\`, \`new_${name}\`, \`${name}2\`).`,
            `If you're trying to update a value (\`x = x + 1\`, accumulators,` +
              ` running totals), wrap the work in a function and rebind` +
              ` \`${name}\` from the function's return value:` +
              ` \`${name} = compute_${name}(...)\`.`,
          ]
        : [
            `If you want a different value, give it a different name (e.g.` +
              ` \`${name}_doubled\`, \`new_${name}\`, \`${name}2\`).`,
            `If you're trying to update a value (\`x = x + 1\`, accumulators,` +
              ` running totals), use a built-in like \`sum(...)\`, \`max(...)\`,` +
              ` or a small helper function that returns the new value instead.`,
            // Inside a function this is exactly what `intermediate` exists
            // for, and a student has no way to know that from here.
            ...(raw.scope_kind === "function"
              ? [
                  "`#level intermediate` allows changing a variable inside a" +
                    " function, which is what a running total needs.",
                ]
              : []),
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

