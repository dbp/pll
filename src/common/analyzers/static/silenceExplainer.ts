import type { Level } from "../../level";
import type { RawStaticFinding } from "../../pyodideRunner";
import type { AnalysisFinding } from "../types";

/**
 * Findings for code that would otherwise run without a word being said.
 *
 * Every one of these is valid Python that does nothing, or something other
 * than what was meant. A test written without `assert` always passes; an
 * `assert` on a tuple is always true; a method named but not called yields
 * the method itself; an annotation naming a function turns every check on
 * that value off. None of them produces an error, so without a finding the
 * student's only evidence is a program that seems to work.
 */

/** The replacement for an annotation that names something that is not a type. */
const TYPE_FOR: Record<string, string> = {
  table: "Table",
  reactor: "Reactor",
  row: "Row",
  string: "str",
  integer: "int",
  boolean: "bool",
  number: "float",
  Float: "float",
  Int: "int",
  Str: "str",
  Bool: "bool",
  image: "Image",
  Number: "float",
  String: "str",
  Boolean: "bool",
  Integer: "int",
};

/**
 * Names that really are functions PLL provides, for the wording that says
 * so. `image` is not one of them - nothing is called `image` - and `row`
 * is a method of a table rather than a function that makes one, so both
 * get the plain "that is not a type" wording instead.
 */
const FUNCTION_NOT_TYPE = new Set(["table", "reactor"]);

function finding(
  raw: RawStaticFinding,
  level: Level,
  fileName: string,
  headline: string,
  howToFix: string[],
  severity: AnalysisFinding["severity"],
): AnalysisFinding {
  return {
    id: raw.id,
    errorType: raw.error_type || "StaticError",
    message: raw.message,
    headline,
    howToFix,
    fileName,
    lineNumber: raw.line_number,
    column: raw.column,
    nameToken: raw.name_token,
    severity,
    raw: JSON.stringify(raw),
    origin: "static",
    level,
  };
}

/** `pen_cost(0, "huskies") == 1` - a test written without `assert`. */
export function explainUnusedComparison(
  raw: RawStaticFinding,
  level: Level,
  fileName: string,
): AnalysisFinding {
  // Their own comparison, not `assert ...`.
  const shown = raw.expression ? `\`assert ${raw.expression}\`` : "`assert ...`";
  return finding(
    raw,
    level,
    fileName,
    "This comparison's answer is not used, so nothing checks it.",
    [
      `Did you mean ${shown}? Without \`assert\` the comparison is worked out and thrown away, so the test always passes.`,
      "At the top level a line like this is displayed; inside a function nothing shows it.",
    ],
    "error",
  );
}

/** `ac.balance + amt` on a line of its own. */
export function explainUnusedValue(
  raw: RawStaticFinding,
  level: Level,
  fileName: string,
): AnalysisFinding {
  const expression = raw.expression ?? null;
  // `ac.balance + amt` reads a field and adds to it: assigning the result
  // back to that field is nearly always what was meant.
  const field = expression !== null ? /^([A-Za-z_]\w*\.[A-Za-z_]\w*)\s*[-+*/]/.exec(expression) : null;
  const howToFix =
    expression === null
      ? ["Use it: `return` it, assign it to a name, or pass it to `print`."]
      : field !== null
        ? [
            `To change \`${field[1]}\`, assign the result to it: \`${field[1]} = ${expression}\`.`,
            `Or, if this is the function's answer, return it: \`return ${expression}\`.`,
          ]
        : [
            `Did you mean \`return ${expression}\`? On its own, the value is worked out and thrown away.`,
          ];
  return finding(
    raw,
    level,
    fileName,
    "This line works out a value and then throws it away.",
    [...howToFix, "Nothing in Python changes as a result of this line."],
    "error",
  );
}

/** `assert(x, 1)` - a tuple, which is always true. */
export function explainAssertTuple(
  raw: RawStaticFinding,
  level: Level,
  fileName: string,
): AnalysisFinding {
  return finding(
    raw,
    level,
    fileName,
    "This `assert` has brackets around two things, so it is always true.",
    [
      "`assert(a, b)` checks a pair, and a pair is never false - the test passes whatever happens.",
      "Write `assert a == b`, with no brackets after `assert`.",
    ],
    "error",
  );
}

/** `movies["rating"].mean` - the method, not its result. */
export function explainMethodNotCalled(
  raw: RawStaticFinding,
  level: Level,
  fileName: string,
): AnalysisFinding {
  const method = raw.name_token ?? "the method";
  return finding(
    raw,
    level,
    fileName,
    `\`${method}\` is named here but never called.`,
    [
      `Add the brackets: \`.${method}()\`.`,
      `Without them this is the method itself, which displays as \`<bound method ...>\`.`,
    ],
    "warning",
  );
}

/** `t: table` - the function that makes tables, not the type. */
export function explainAnnotationNotAType(
  raw: RawStaticFinding,
  level: Level,
  fileName: string,
): AnalysisFinding {
  const written = raw.name_token ?? "";
  const type = TYPE_FOR[written] ?? null;
  const headline = FUNCTION_NOT_TYPE.has(written)
    ? `\`${written}\` is the function that makes a ${written}; the type is \`${type}\`.`
    : `\`${written}\` is not a type Python knows.`;
  // What goes wrong depends on whether the name exists. `table` is a real
  // function, so the annotation is accepted and silently checks nothing;
  // `string` and `Float` are not names at all, so the line fails with a
  // NameError the moment it runs - and saying "accepted" there is false.
  const exists = FUNCTION_NOT_TYPE.has(written);
  return finding(
    raw,
    level,
    fileName,
    headline,
    type !== null
      ? [
          `Write \`${type}\` instead.`,
          exists
            ? "As it stands the annotation is accepted and nothing about this value is checked."
            : `There is nothing called \`${written}\`, so this line fails as soon as it runs.`,
        ]
      : ["Nothing about this value is being checked as a result."],
    "error",
  );
}

/** A function with an `assert` that nothing ever runs. */
export function explainTestNotNamed(
  raw: RawStaticFinding,
  level: Level,
  fileName: string,
): AnalysisFinding {
  const name = raw.name_token ?? "this function";
  return finding(
    raw,
    level,
    fileName,
    `\`${name}\` has an \`assert\` in it, but nothing ever runs it.`,
    [
      `Rename it \`test_${name}\` and it will run with the other tests.`,
      "Only functions whose names start with `test_` are run automatically.",
    ],
    "warning",
  );
}

/** `year` on a line of its own in a dataclass body. */
export function explainFieldNoType(
  raw: RawStaticFinding,
  level: Level,
  fileName: string,
): AnalysisFinding {
  const name = raw.name_token ?? "this field";
  return finding(
    raw,
    level,
    fileName,
    `The field \`${name}\` has no type, so it is not a field at all.`,
    [
      `Every field of a dataclass needs a type: \`${name}: int\`, \`${name}: str\`, and so on.`,
      // The NameError this used to lead to is no longer reached - this is
      // reported before the program runs - so it is not mentioned.
      `On a line of its own, \`${name}\` only uses the name; it does not declare anything.`,
    ],
    "error",
  );
}

/** `year = int` where `year: int` was meant. */
export function explainFieldAssignedType(
  raw: RawStaticFinding,
  level: Level,
  fileName: string,
): AnalysisFinding {
  const name = raw.name_token ?? "this field";
  const type = raw.written_type ?? "int";
  return finding(
    raw,
    level,
    fileName,
    `\`${name} = ${type}\` sets \`${name}\` to the type itself; did you mean \`${name}: ${type}\`?`,
    [
      "A field is declared with a colon, not an `=`.",
      `With an \`=\` there is no \`${name}\` field, and the constructor ends up with the wrong number of arguments.`,
    ],
    "error",
  );
}

/** A class with annotated fields and no `@dataclass`. */
export function explainClassNeedsDataclass(
  raw: RawStaticFinding,
  level: Level,
  fileName: string,
): AnalysisFinding {
  const name = raw.name_token ?? "this class";
  return finding(
    raw,
    level,
    fileName,
    `\`${name}\` lists fields but has no \`@dataclass\`, so \`${name}(...)\` takes no arguments.`,
    [
      `Write \`@dataclass\` on the line above \`class ${name}\`.`,
      "Add `from dataclasses import dataclass` at the top of the file if it is not there.",
    ],
    "error",
  );
}

/** `if a == Boa:` - a value is never equal to the class it was made from. */
export function explainComparedWithClass(
  raw: RawStaticFinding,
  level: Level,
  fileName: string,
): AnalysisFinding {
  const name = raw.name_token ?? "a class";
  return finding(
    raw,
    level,
    fileName,
    `\`${name}\` is a class, so comparing a value with it is always False.`,
    [
      `Use \`match\` to tell the kinds apart: \`case ${name}(...):\`.`,
      `\`${name}\` is the blueprint; a value made from it is never equal to it.`,
    ],
    "error",
  );
}
