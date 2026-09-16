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
export function explainNameError(parsed: ParsedPythonError): BeginnerExplanation {
  const name = parsed.nameToken ?? "this name";
  const didYouMean = extractDidYouMean(parsed.message);

  const headline = `Python doesn't know what \`${name}\` means.`;

  const howToFix: string[] = [
    `Check the spelling of \`${name}\` (Python is case-sensitive).`,
    `Make sure \`${name}\` is defined before this line runs.`,
    `If \`${name}\` should be text, put it in quotes: \`\"${name}\"\`.`,
  ];

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
