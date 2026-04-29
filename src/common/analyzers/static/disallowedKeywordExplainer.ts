import type { Level } from "../../level";
import type { RawStaticFinding } from "../../pyodideRunner";
import type { AnalysisFinding } from "../types";

/**
 * Build an AnalysisFinding for a `global` / `nonlocal` statement at a level
 * that doesn't allow them (beginner, intermediate). These keywords let a
 * function reach out and rebind a name from an enclosing scope, which is
 * exactly the kind of "spooky action at a distance" both levels are trying
 * to keep beginners from running into.
 */
export function explainDisallowedKeyword(
  raw: RawStaticFinding,
  level: Level,
  fileName: string,
): AnalysisFinding {
  const keyword = raw.keyword === "nonlocal" ? "nonlocal" : "global";
  const names = Array.isArray(raw.names) ? raw.names : [];
  const formattedNames = names.map((n) => `\`${n}\``).join(", ");
  const namesPhrase = formattedNames.length > 0 ? ` ${formattedNames}` : "";

  const headline = `\`${keyword}\` is not allowed at the ${level} level.`;

  const whatHappened: string[] = [
    `The \`${keyword}\` statement tells Python that an assignment inside this` +
      ` function should rebind a variable in ${
        keyword === "global" ? "the surrounding file" : "an enclosing function"
      } instead of creating a new local variable. ${level} mode disallows it` +
      ` because that "spooky" action makes code hard to follow.`,
  ];

  const whyItHappens: string[] =
    level === "intermediate"
      ? [
          `In ${level} mode, each function works only with its own local` +
            ` variables (and the arguments you pass in). Reading from outer` +
            ` scopes is fine, but writing to them with \`${keyword}\` is not.`,
        ]
      : [
          `In ${level} mode, each function should communicate with the rest of` +
            ` your program through its arguments and its return value, not by` +
            ` reaching out to modify variables defined elsewhere.`,
        ];

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

  return {
    id: "disallowed-keyword",
    errorType: "DisallowedKeyword",
    message: raw.message,
    headline,
    whatHappened,
    whyItHappens,
    howToFix,
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
