import type { Level } from "../../level";
import type { RawStaticFindingOf } from "../../wire";
import type { AnalysisFinding } from "../types";

/** Friendly noun for the kind of scope the outer binding lives in. */
function outerScopeNoun(kind: string | null | undefined): string {
  switch (kind) {
    case "module":
      return "the file";
    case "function":
    case "lambda":
      return "an enclosing function";
    case "class":
      return "an enclosing class";
    case "comprehension":
      return "an enclosing comprehension";
    default:
      return "an outer scope";
  }
}

/**
 * Build an AnalysisFinding for a "name shadows a binding in an enclosing
 * scope" finding from the Python static analyzer.
 */
export function explainShadowing(
  raw: RawStaticFindingOf<"shadowing">,
  level: Level,
  fileName: string,
): AnalysisFinding {
  const name = raw.name_token ?? "this name";
  const outerLine = raw.outer_line_number ?? null;
  const outerNoun = outerScopeNoun(raw.outer_scope_kind);
  const knownOuterLine = outerLine !== null && outerLine > 0;
  const outerHint = knownOuterLine
    ? ` (first defined on line ${outerLine}, in ${outerNoun})`
    : ` in ${outerNoun}`;

  return {
    id: "shadowing",
    errorType: "Shadowing",
    message: raw.message,
    headline: `\`${name}\` is already defined${outerHint}.`,
    howToFix: [
      `Rename the inner \`${name}\` to something distinct (e.g. \`${name}_inner\`,` +
        ` \`local_${name}\`, or whatever describes its role).`,
      `Or, if you want to use the outer \`${name}\`, just read it directly` +
        ` without making a new variable.`,
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

/**
 * Build an AnalysisFinding for "name shadows a built-in" (e.g. `list = ...`).
 */
export function explainShadowingBuiltin(
  raw: RawStaticFindingOf<"shadowing-builtin">,
  level: Level,
  fileName: string,
): AnalysisFinding {
  const name = raw.name_token ?? "this name";
  const headline = `\`${name}\` is the name of a Python built-in.`;

  return {
    id: "shadowing-builtin",
    errorType: "Shadowing",
    message: raw.message,
    headline,
    howToFix: [
      `Pick a different name. Common patterns: \`my_${name}\`, \`${name}_value\`,` +
        ` \`${name}s\` (plural), or a more specific noun describing what this` +
        ` value represents.`,
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

/** Friendly noun for the library a predefined name comes from. */
function libraryNoun(library: string | null | undefined): string {
  switch (library) {
    case "image":
      return "the image library";
    case "table":
      return "the table library";
    case "reactor":
      return "the reactor library";
    default:
      return "the PLL libraries";
  }
}

/**
 * Build an AnalysisFinding for "name shadows a library function" - a name
 * every session starts with, like `circle` or `rectangle` (image library),
 * `table` (table library), or `animate` (reactor library).
 */
export function explainShadowingLibrary(
  raw: RawStaticFindingOf<"shadowing-library">,
  level: Level,
  fileName: string,
): AnalysisFinding {
  const name = raw.name_token ?? "this name";
  const noun = libraryNoun(raw.library);
  const headline = `\`${name}\` is already defined by ${noun}.`;

  return {
    id: "shadowing-library",
    errorType: "Shadowing",
    message: raw.message,
    headline,
    howToFix: [
      `Pick a different name for your definition - for example \`my_${name}\`,` +
        ` \`${name}_value\`, or a word that describes what yours represents.`,
      `If you meant to use the library's \`${name}\`, call it directly instead of` +
        ` defining a new \`${name}\` of your own.`,
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
