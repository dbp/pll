import type { BeginnerExplanation } from "./types";

/**
 * Better wording for the syntax errors students actually hit.
 *
 * Python's own message is kept whenever it is already clear (`expected ':'`,
 * `'(' was never closed`, `unterminated string literal`). These are the
 * ones where it is not: it names the token that finally failed to parse
 * rather than the mistake, so `else if` becomes "expected ':'" and
 * `class = 30` becomes "invalid syntax" pointing at the `=`.
 *
 * `offendingLine` is the student's source line, which is what makes these
 * recognisable: Python has already forgotten what the construct was.
 */
export function explainSyntaxError(
  errorType: string,
  message: string,
  offendingLine: string | null,
): BeginnerExplanation {
  const line = (offendingLine ?? "").trim();

  if (errorType === "TabError") {
    return {
      headline: "This line mixes tabs and spaces for its indentation.",
      howToFix: [
        "Use spaces throughout. In VS Code, the command **Convert Indentation to Spaces** fixes the whole file.",
        "A tab and four spaces look identical on screen, which is why this is hard to see.",
      ],
    };
  }

  const badCharacter = /invalid character '(.)' \(U\+[0-9A-F]+\)/.exec(message);
  if (badCharacter) {
    const curly = "“”‘’".includes(badCharacter[1]);
    return {
      headline: `\`${badCharacter[1]}\` is not a character Python can read here.`,
      howToFix: curly
        ? [
            'Use straight quotes (`"` and `\'`) rather than curly ones.',
            "Curly quotes come from copying out of a document or a web page; retyping the quotes fixes it.",
          ]
        : ["Retype the line; the character may have come from copying out of a document."],
    };
  }

  // `else if` parses as `else` followed by an expression, so Python asks for
  // the colon it wanted after `else`.
  if (/^else\s+if\b/.test(line)) {
    return {
      headline: "Python spells this `elif`, not `else if`.",
      howToFix: ["Write `elif` as one word, then the condition and a colon."],
    };
  }

  if (/'return' outside function/.test(message)) {
    return {
      headline: "`return` only works inside a function.",
      howToFix: [
        "To show a value at the top level of a file, use `print(...)` or write the value on a line of its own.",
        "If this was meant to be inside a function, check that it is indented under the `def`.",
      ],
    };
  }

  // Python suggests `==` *or* `:=`. The walrus is not something a student in
  // this course has met, and offering it invites a second mistake.
  if (/Maybe you meant '=='/.test(message)) {
    const inAssert = /^assert\b/.test(line);
    return {
      headline: inAssert
        ? "A test compares with `==`, not `=`."
        : "This compares two values, so it needs `==`.",
      howToFix: [
        "`==` asks whether two values are equal; `=` gives a name a value.",
      ],
    };
  }

  // `assert f(x) = 0` does not reach the suggestion above - the left side is
  // a call, which cannot be assigned to at all, so Python just gives up.
  if (/^assert\b/.test(line) && /(^|[^=!<>])=([^=]|$)/.test(line)) {
    return {
      headline: "A test compares with `==`, not `=`.",
      howToFix: ["`==` asks whether two values are equal; `=` gives a name a value."],
    };
  }

  // `case Boa:` parses, and only fails when compiled. Python's message is
  // about the consequence - the cases below can never run - rather than
  // the cause, which is the missing brackets.
  const capture = /name capture '(\w+)' makes remaining patterns unreachable/.exec(message);
  if (capture !== null) {
    return {
      headline: `\`case ${capture[1]}:\` needs brackets: \`case ${capture[1]}():\`.`,
      howToFix: [
        `Without them, \`${capture[1]}\` is a new name that matches anything, so no \`case\` after it can ever run.`,
        `With them, \`case ${capture[1]}():\` matches only a \`${capture[1]}\`; put one name inside for each field.`,
      ],
    };
  }

  const keyword = keywordAssignedTo(line);
  if (keyword !== null) {
    return {
      headline: `\`${keyword}\` is a word Python reserves, so it cannot be a name.`,
      howToFix: [`Pick another name, such as \`${keyword}_value\` or something describing what it holds.`],
    };
  }

  return {
    headline: punctuated(message),
    howToFix: [],
  };
}

/** Python keywords, which a student may reach for as a variable name. */
const KEYWORDS = [
  "False", "None", "True", "and", "as", "assert", "async", "await", "break",
  "class", "continue", "def", "del", "elif", "else", "except", "finally",
  "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
  "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
];

/** The keyword this line tries to assign to, if it does. */
function keywordAssignedTo(line: string): string | null {
  const assignment = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=[^=]/.exec(line);
  if (assignment === null) {
    return null;
  }
  return KEYWORDS.includes(assignment[1]) ? assignment[1] : null;
}

function punctuated(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "Python could not read this line.";
  }
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
