import type { ParsedPythonError } from "./pythonErrorParser";
import type { BeginnerExplanation } from "./types";

/**
 * Build a friendly explanation for a NameError.
 *
 * The exact message Python emits is:
 *   NameError: name 'foo' is not defined
 *
 * Older/newer CPython versions occasionally include suggestions
 * ("Did you mean: ...?"). We strip those out of the headline and
 * surface them separately if present.
 */
/**
 * Which kind of name problem this is.
 *
 * "Never heard of it" and "not assigned yet" need opposite advice: the
 * second is a name the student spelled correctly, so telling them to check
 * the spelling sends them looking for a mistake that is not there. What is
 * wrong is the *order*.
 */
function unboundKind(message: string): "free" | "local" | null {
  const m = message.match(/cannot access (free|local) variable '/);
  return m ? (m[1] as "free" | "local") : null;
}

export function explainNameError(parsed: ParsedPythonError): BeginnerExplanation {
  const named = parsed.nameToken !== null;
  const name = parsed.nameToken ?? "this name";
  const didYouMean = extractDidYouMean(parsed.message);

  const unbound = unboundKind(parsed.message);
  if (unbound !== null) {
    return {
      headline: `\`${name}\` has not been given a value yet on this line.`,
      howToFix: [
        `Move the line that sets \`${name}\` above this one.`,
        unbound === "local"
          ? `If you meant a \`${name}\` from outside this function: assigning to ` +
            `it anywhere inside makes it local to the whole function, so the ` +
            `outer one is not visible here. Pass it in as a parameter instead.`
          : `The \`${name}\` here belongs to the function around this one, ` +
            `which sets it after this line runs.`,
      ],
    };
  }

  const headline = `Python doesn't know what \`${name}\` means.`;

  const howToFix: string[] = [
    `Check the spelling of \`${name}\` (Python is case-sensitive).`,
    `Make sure \`${name}\` is defined before this line runs.`,
  ];
  // Only worth saying when there is a real name to quote; `put "this name"
  // in quotes` is advice about the placeholder rather than about the code.
  if (named) {
    howToFix.push(`If \`${name}\` should be text, put it in quotes: \`\"${name}\"\`.`);
  }

  if (didYouMean.length > 0) {
    howToFix.unshift(
      `Python suggested: ${didYouMean
        .map((s) => "`" + s + "`")
        .join(", ")} - try one of those.`,
    );
  }

  return { headline, howToFix };
}

function extractDidYouMean(message: string): string[] {
  const m = message.match(/Did you mean:\s*([^?]+)\??/i);
  if (!m) {
    return [];
  }
  return m[1]
    .split(/,|\bor\b/)
    .map((s) => s.trim().replace(/^['"`]|['"`]$/g, ""))
    .filter((s) => s.length > 0);
}
