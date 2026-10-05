import type { Level } from "../../level";
import type { StaticFindingOf } from "../../fromPython";
import { staticFindingFor, type AnalysisFinding } from "../types";

/**
 * Build an AnalysisFinding for a `global` / `nonlocal` statement at a level
 * that doesn't allow them (beginner, intermediate). These keywords let a
 * function reach out and rebind a name from an enclosing scope, which is
 * exactly the kind of "spooky action at a distance" both levels are trying
 * to keep beginners from running into.
 */
export function explainDisallowedKeyword(
  raw: StaticFindingOf<"disallowed-keyword">,
  level: Level,
  fileName: string,
): AnalysisFinding {
  const keyword = raw.keyword === "nonlocal" ? "nonlocal" : "global";
  const names = Array.isArray(raw.names) ? raw.names : [];
  const formattedNames = names.map((n) => `\`${n}\``).join(", ");
  const namesPhrase = formattedNames.length > 0 ? ` ${formattedNames}` : "";

  const headline = `\`${keyword}\` is not allowed at the ${level} level.`;

  const howToFix: string[] = [];
  if (keyword === "global") {
    howToFix.push(
      `Pass${namesPhrase || " the value"} into this function as an argument` +
        ` instead of declaring it \`global\`.`,
      `If the function needs to *change* a value, return the new value and` +
        ` let the caller decide what to do with it (e.g. \`x = update(x)\`).`,
    );
  } else {
    howToFix.push(
      `Return${namesPhrase || " the new value"} from this inner function and` +
        ` have the outer function rebind it explicitly` +
        ` (e.g. \`x = inner(x)\`).`,
      `If the inner function only needs to *read* the outer name, just use it` +
        ` directly - you don't need \`nonlocal\` for that.`,
    );
  }

  // The level that does allow it. Without this the finding says what is
  // forbidden and never what to do if the student really does want it.
  howToFix.push(
    `\`#level advanced\` allows \`${keyword}\`, if you have a reason to use it.`,
  );

  return staticFindingFor(raw, level, fileName, {
    headline,
    howToFix,
  });
}
