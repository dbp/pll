import type { ParsedPythonError } from "./pythonErrorParser";

export interface BeginnerExplanation {
  /** Short headline, e.g. "Python doesn't know what `foo` means." */
  headline: string;
  /** A few short paragraphs/lines of plain-language explanation. */
  whatHappened: string[];
  /** Common reasons this error appears. */
  whyItHappens: string[];
  /** Concrete next steps the learner can take. */
  howToFix: string[];
}

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

  const whatHappened: string[] = [
    `When Python ran your code, it reached the name \`${name}\` and looked` +
      " for a value with that name (a variable, function, class, or import) -" +
      " but no such name exists in the current scope.",
  ];

  const whyItHappens: string[] = [
    `Typo: \`${name}\` may be misspelled. Python is case-sensitive, so` +
      " `Total` and `total` are different names.",
    `Order of execution: \`${name}\` may be defined later in the file, but` +
      " Python only knows about names that have already been assigned by the" +
      " time it reaches this line.",
    `Scope: \`${name}\` may be defined inside another function or block and` +
      " isn't visible here.",
    `Forgotten quotes: if you meant the text \"${name}\", wrap it in quotes:` +
      ` \`\"${name}\"\`.`,
    `Missing import: if \`${name}\` comes from a module, you may need` +
      ` \`import ${name}\` (or \`from somemodule import ${name}\`) at the top` +
      " of the file.",
  ];

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

  return { headline, whatHappened, whyItHappens, howToFix };
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
