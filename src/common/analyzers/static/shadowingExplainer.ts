import type { Level } from "../../level";
import type { StaticFindingOf } from "../../fromPython";
import { staticFindingFor, type AnalysisFinding } from "../types";

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

/** What a binding is, by how it was made: "parameter", "loop variable", ... */
function bindingNoun(binding: string | null | undefined): string {
  switch (binding) {
    case "argument":
      return "parameter";
    case "for":
      return "loop variable";
    case "functiondef":
      return "function";
    case "classdef":
      return "class";
    case "import":
    case "importfrom":
      return "import";
    case "capture":
      return "name in a `case`";
    case "assign":
    case "annassign":
    case "augassign":
    case "walrus":
    case "with":
      return "variable";
    default:
      return "name";
  }
}

/**
 * Build an AnalysisFinding for a "name shadows a binding in an enclosing
 * scope" finding from the Python static analyzer.
 */
export function explainShadowing(
  raw: StaticFindingOf<"shadowing">,
  level: Level,
  fileName: string,
): AnalysisFinding {
  const name = raw.nameToken ?? "this name";
  const outerLine = raw.outerLineNumber ?? null;
  const outerNoun = outerScopeNoun(raw.outerScopeKind);
  const knownOuterLine = outerLine !== null && outerLine > 0;
  const inner = bindingNoun(raw.binding);
  const outer = bindingNoun(raw.outerBinding);
  // The other one comes later in the file, so it was not "already" there:
  // the two simply share a name, and either can change.
  if (knownOuterLine && raw.lineNumber !== null && raw.lineNumber !== undefined && outerLine > raw.lineNumber) {
    return staticFindingFor(raw, level, fileName, {
      headline:
        `\`${name}\` names two things: this ${inner}, and a ${outer} in ${outerNoun}, on line ${outerLine}.`,
      howToFix: [
        `Give one of them another name - this ${inner}, or the ${outer} on line ${outerLine} - so each name means one thing.`,
      ],
    });
  }
  const outerHint = knownOuterLine
    ? ` (first defined on line ${outerLine}, in ${outerNoun})`
    : ` in ${outerNoun}`;

  return staticFindingFor(raw, level, fileName, {
    headline: `\`${name}\` is already defined${outerHint}.`,
    howToFix: [
      `Rename this ${inner} to something distinct (e.g. \`${name}_inner\`,` +
        ` \`local_${name}\`, or whatever describes its role).`,
      `Or, if you want to use the outer \`${name}\`, just read it directly` +
        ` without making a new ${inner === "parameter" ? "parameter" : "variable"}.`,
    ],
  });
}

/**
 * Build an AnalysisFinding for "name shadows a built-in" (e.g. `list = ...`).
 */
export function explainShadowingBuiltin(
  raw: StaticFindingOf<"shadowing-builtin">,
  level: Level,
  fileName: string,
): AnalysisFinding {
  const name = raw.nameToken ?? "this name";
  const headline = `\`${name}\` is the name of a Python built-in.`;

  return staticFindingFor(raw, level, fileName, {
    headline,
    howToFix: [
      `Pick a different name. Common patterns: \`my_${name}\`, \`${name}_value\`,` +
        ` \`${name}s\` (plural), or a more specific noun describing what this` +
        ` value represents.`,
    ],
  });
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
  raw: StaticFindingOf<"shadowing-library">,
  level: Level,
  fileName: string,
): AnalysisFinding {
  const name = raw.nameToken ?? "this name";
  const noun = libraryNoun(raw.library);
  if (raw.binding === "import" || raw.binding === "importfrom") {
    // The fix is the import's own `as`, not a rename of anything of theirs.
    const root = (raw.module ?? "module").split(".")[0];
    const alias = `${root}${name.charAt(0).toUpperCase()}${name.slice(1)}`;
    const written =
      raw.binding === "importfrom" ? `from ${raw.module} import ${name} as ${alias}` : `import ${name} as ${alias}`;
    return staticFindingFor(raw, level, fileName, {
      headline: `\`${name}\` is already defined by ${noun}, and this import replaces it.`,
      howToFix: [
        `Import it under another name: \`${written}\`, and use \`${alias}\` where you mean that one.`,
      ],
    });
  }
  if (raw.binding === "argument" || raw.binding === "for") {
    const what = bindingNoun(raw.binding);
    return staticFindingFor(raw, level, fileName, {
      headline: `\`${name}\` is already a name in PLL - one of ${noun}'s - and this ${what} hides it.`,
      howToFix: [
        `Give the ${what} another name - for example \`${name}_value\`, or a word for what it holds.`,
      ],
    });
  }
  return staticFindingFor(raw, level, fileName, {
    headline: `\`${name}\` is already defined by ${noun}.`,
    howToFix: [
      `Pick a different name for your definition - for example \`my_${name}\`,` +
        ` \`${name}_value\`, or a word that describes what yours represents.`,
      `If you meant to use the library's \`${name}\`, call it directly instead of` +
        ` defining a new \`${name}\` of your own.`,
    ],
  });
}
