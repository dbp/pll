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

  // At intermediate, reassignment is only flagged at module/file scope, so
  // tailor the wording to make that obvious.
  const scopeLabel =
    level === "intermediate" ? "at the top level of this file" : "in this scope";

  return {
    id: "reassignment",
    errorType: "Reassignment",
    message: raw.message,
    headline: `\`${name}\` is already assigned${firstLineHint}.`,
    whatHappened: [
      `In ${level} mode, each variable name can only be assigned once ${scopeLabel}.` +
        ` \`${name}\` was already given a value earlier, and this line tries` +
        ` to assign to it again.`,
    ],
    whyItHappens: [
      `Variables that change value over time are a major source of bugs for` +
        ` people new to programming. ${capitalize(level)} mode makes each name` +
        ` stand for exactly one value ${scopeLabel} so you can read code` +
        ` top-to-bottom without mentally tracking "what is \`${name}\` right now?".`,
    ],
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

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
