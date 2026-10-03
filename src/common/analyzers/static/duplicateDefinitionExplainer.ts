import type { Level } from "../../level";
import type { RawStaticFindingOf } from "../../wire";
import { staticFindingFor, type AnalysisFinding } from "../types";

/**
 * Two `def`s (or two `class`es) with the same name.
 *
 * Python keeps the second and throws the first away silently, which is how
 * a test copied without renaming it disappears. Before this it arrived as
 * the Reassignment finding, whose advice is about variables - accumulators,
 * running totals, "use a built-in like `sum`" - and so pointed nowhere
 * near the actual fix, which is to rename one of them.
 */
export function explainDuplicateDefinition(
  raw: RawStaticFindingOf<"duplicate-definition">,
  level: Level,
  fileName: string,
): AnalysisFinding {
  const name = raw.name_token ?? "this name";
  const kind = raw.definition_kind === "class" ? "classes" : "functions";
  const first = raw.first_line_number;
  const where =
    typeof first === "number" && first > 0 ? ` (lines ${first} and ${raw.line_number})` : "";
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
