import type { Level } from "../../level";
import type { StaticFindingOf } from "../../fromPython";
import { staticFindingFor, type AnalysisFinding } from "../types";

/**
 * Two `def`s (or two `class`es) with the same name.
 *
 * Python keeps the second and throws the first away silently, which is how
 * a test copied without renaming it disappears. Its own finding, not a
 * reassignment: that advice is about variables - accumulators, running
 * totals - and the fix here is to rename one of them.
 */
export function explainDuplicateDefinition(
  raw: StaticFindingOf<"duplicate-definition">,
  level: Level,
  fileName: string,
): AnalysisFinding {
  const name = raw.nameToken ?? "this name";
  const kind = raw.definitionKind === "class" ? "classes" : "functions";
  const first = raw.firstLineNumber;
  const where =
    typeof first === "number" && first > 0 ? ` (lines ${first} and ${raw.lineNumber})` : "";
  return staticFindingFor(raw, level, fileName, {
    headline: `There are two ${kind} named \`${name}\`${where}.`,
    howToFix: [
      "Rename one of them. Python keeps only the second, so the first never runs.",
      kind === "functions" && name.startsWith("test_")
        ? "A test copied and not renamed vanishes this way: only the last one is run."
        : "Both definitions are kept in the file, but only the last name points at anything.",
    ],
  });
}
