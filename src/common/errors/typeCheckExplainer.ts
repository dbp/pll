import { levelRejectsBoolAsNumber, type Level } from "../level";
import type { BeginnerExplanation } from "./nameErrorExplainer";

/**
 * Rewrites typeguard's `TypeCheckError` messages into beginner-facing
 * explanations.
 *
 * typeguard's own wording is accurate but assumes vocabulary a first-term
 * student does not have ("is not an instance of", "did not match any
 * element in the union"). The messages it produces look like:
 *
 *   argument "y" (str) is not an instance of int
 *   the return value (int) is not an instance of str
 *   value assigned to total (str) is not an instance of int
 *   item 2 of argument "nums" (list) is not an instance of int
 *   key 1 of argument "x" (dict) is not an instance of str
 *   value of key 'a' of argument "x" (dict) is not an instance of int
 *   argument "x" (str) is neither float or int
 *   argument "x" (str) is not a list
 *   the return value (int) is not None
 *   argument "x" (str) did not match any element in the union:
 *     int: is not an instance of int
 *     NoneType: is not an instance of NoneType
 */

export interface ParsedTypeCheckError {
  /** What the annotation was attached to. */
  kind: "argument" | "return" | "variable" | "unknown";
  /** Parameter or variable name, when the message names one. */
  name: string | null;
  /** Set when the failure is about something *inside* a collection. */
  element: string | null;
  /** Type the offending value actually had, as typeguard reported it. */
  actual: string | null;
  /** Type(s) the annotation asked for. */
  expected: string[];
}

/** Plain-language gloss for the types a beginner course actually uses. */
const FRIENDLY_TYPES: Record<string, string> = {
  int: "a whole number",
  float: "a number",
  complex: "a complex number",
  str: "a string",
  bool: "`True` or `False`",
  bytes: "bytes",
  list: "a list",
  dict: "a dictionary",
  set: "a set",
  tuple: "a tuple",
  None: "`None`",
  NoneType: "`None`",
};

/** User code runs as `__main__`, so its classes arrive as `__main__.Dog`. */
function cleanTypeName(type: string): string {
  return type.startsWith("__main__.") ? type.slice("__main__.".length) : type;
}

/** e.g. `int` -> "a whole number (`int`)", `Dog` -> "`Dog`". */
function describeType(type: string): string {
  const name = cleanTypeName(type);
  // (c) `None`'s gloss is already the type name; "`None` (`None`)" is silly.
  if (name === "None" || name === "NoneType") return "`None`";
  const friendly = FRIENDLY_TYPES[name];
  return friendly ? `${friendly} (\`${name}\`)` : `\`${name}\``;
}

/** e.g. ["int", "NoneType"] -> "a whole number (`int`) or `None`". */
function describeTypes(types: string[]): string {
  const described = types.map(describeType);
  if (described.length === 0) return "a different type";
  if (described.length === 1) return described[0];
  return `${described.slice(0, -1).join(", ")} or ${described[described.length - 1]}`;
}

/**
 * A `bool` rejected for `int`/`float` is PLL's rule, not Python's, so say
 * so rather than leaving the student to wonder why `True` is not a number.
 */
function boolAsNumberNote(
  expected: string[],
  actual: string | null,
  level: Level | undefined,
): string | null {
  if (actual !== "bool" || expected.length === 0) return null;
  if (!expected.some((type) => type === "int" || type === "float")) return null;
  if (level !== undefined && !levelRejectsBoolAsNumber(level)) return null;
  return (
    "At `#beginner` and `#intermediate`, `True` and `False` are not " +
    "accepted as numbers, even though Python counts them as `1` and `0`."
  );
}

/** The conversion that would most likely fix this, if there is an obvious one. */
function conversionFor(expected: string[], actual: string | null): string | null {
  if (expected.length !== 1 || actual === null) return null;
  const to = expected[0];
  const numeric = actual === "int" || actual === "float" || actual === "bool";
  if (to === "int" && (actual === "str" || actual === "float")) return "int";
  if (to === "float" && actual === "str") return "float";
  if (to === "str" && numeric) return "str";
  return null;
}

const ELEMENT_RE = /^(item \d+|key .+|value of key .+|\[.+\]) of (.+)$/;

/** How to describe "all the things inside" for the failing element kind. */
function membersPhrase(element: string): string {
  if (element.startsWith("the value for key")) return "every value in";
  if (element.startsWith("key ")) return "every key in";
  return "every item in";
}

/** Turn typeguard's element wording into something to point at. */
function describeElement(element: string): string {
  if (element.startsWith("value of key ")) {
    return `the value for key ${element.slice("value of key ".length)}`;
  }
  if (element.startsWith("[")) return "one of the values";
  return element;
}

/** Parse a typeguard message. `kind` is "unknown" if the shape is unfamiliar. */
export function parseTypeCheckMessage(message: string): ParsedTypeCheckError {
  const unknown: ParsedTypeCheckError = {
    kind: "unknown",
    name: null,
    element: null,
    actual: null,
    expected: [],
  };
  const lines = message.split(/\r?\n/);
  const first = lines[0].trim();

  // Split "<subject> (<actual>) <predicate>" at the predicate.
  let expected: string[] = [];
  let subject: string | null = null;
  const unionAt = first.indexOf(" did not match any element in the union:");
  if (unionAt >= 0) {
    subject = first.slice(0, unionAt);
    for (const raw of lines.slice(1)) {
      const m = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_.\[\], ]*):/);
      if (m) expected.push(m[1].trim());
    }
  } else {
    const predicates: Array<[RegExp, (m: RegExpMatchArray) => string[]]> = [
      [/^(.*) is not an instance of (.+)$/, (m) => [m[2]]],
      [/^(.*) is neither float or int$/, () => ["float"]],
      [/^(.*) is not None$/, () => ["None"]],
      [/^(.*) is not a ([A-Za-z_][A-Za-z0-9_]*)$/, (m) => [m[2]]],
    ];
    for (const [re, pick] of predicates) {
      const m = first.match(re);
      if (m) {
        subject = m[1];
        expected = pick(m);
        break;
      }
    }
  }
  if (subject === null) return unknown;

  // Peel the trailing "(actualtype)" off the subject.
  let actual: string | null = null;
  const withActual = subject.match(/^(.*) \(([^()]*)\)$/);
  if (withActual) {
    subject = withActual[1];
    actual = withActual[2];
  }

  // An element prefix ("item 2 of ...") sits in front of the real subject.
  let element: string | null = null;
  const elementMatch = subject.match(ELEMENT_RE);
  if (elementMatch) {
    element = describeElement(elementMatch[1]);
    subject = elementMatch[2];
  }

  if (subject === "the return value") {
    return { kind: "return", name: null, element, actual, expected };
  }
  const argument = subject.match(/^argument "(.+)"$/);
  if (argument) {
    return { kind: "argument", name: argument[1], element, actual, expected };
  }
  const assigned = subject.match(/^value assigned to (.+)$/);
  if (assigned) {
    return { kind: "variable", name: assigned[1], element, actual, expected };
  }
  return { ...unknown, element, actual, expected };
}

/**
 * Build the student-facing explanation. `functionName` is the function the
 * annotation belongs to, when the traceback identifies one.
 */
export function explainTypeCheckError(
  message: string,
  functionName: string | null,
  level?: Level,
): BeginnerExplanation {
  const parsed = parseTypeCheckMessage(message);
  const wanted = describeTypes(parsed.expected);
  const owner = functionName ? `\`${functionName}\`` : "this function";
  const named = parsed.name ? `\`${parsed.name}\`` : "a value";
  const convert = conversionFor(parsed.expected, parsed.actual);
  const boolNote = boolAsNumberNote(parsed.expected, parsed.actual, level);
  const annotation =
    parsed.expected.length === 1 ? cleanTypeName(parsed.expected[0]) : null;

  if (parsed.kind === "argument") {
    if (parsed.element) {
      return {
        headline:
          `${owner} expects ${membersPhrase(parsed.element)} ${named} to be ${wanted}, ` +
          `but ${parsed.element} is not.`,
        howToFix: [
          `Look at ${parsed.element} of the ${parsed.actual ?? "value"} you passed for ${named}.`,
          "Every one has to match the annotation, not just the first.",
        ],
      };
    }
    const got = parsed.actual ? `, but got ${describeType(parsed.actual)}` : "";
    const howToFix = [`Check the value you passed for ${named} on this line.`];
    if (boolNote) howToFix.push(boolNote);
    if (convert) {
      howToFix.push(`If it should be ${wanted}, convert it with \`${convert}(...)\`.`);
    }
    if (annotation && parsed.actual) {
      howToFix.push(
        `Or, if ${named} really should be ${describeType(parsed.actual)}, ` +
          `change its annotation in ${owner} from \`${annotation}\` to \`${cleanTypeName(parsed.actual)}\`.`,
      );
    }
    return {
      headline: `${owner} expects ${named} to be ${wanted}${got}.`,
      howToFix,
    };
  }

  if (parsed.kind === "return") {
    // Falling off the end of a function returns None. That is almost always
    // a missing `return` in one branch rather than a wrong annotation.
    if (parsed.actual === "None" || parsed.actual === "NoneType") {
      return {
        headline: `${owner} should return ${wanted}, but it finished without returning a value.`,
        howToFix: [
          "Make sure every path through the function reaches a `return`.",
          "An `if` with no `else` falls off the end, and Python then returns `None`.",
          `Or annotate the return type as \`None\` if ${owner} is not meant to return anything.`,
        ],
      };
    }
    const got = parsed.actual ? describeType(parsed.actual) : "something else";
    const howToFix: string[] = [];
    const wantsNone = parsed.expected.length === 1 && /^(None|NoneType)$/.test(parsed.expected[0]);
    if (wantsNone) {
      howToFix.push("Use a bare `return`, or drop the `return` entirely.");
    } else if (convert) {
      howToFix.push(`Convert the returned value with \`${convert}(...)\`.`);
    } else {
      howToFix.push(`Return ${wanted} from this line.`);
    }
    if (boolNote) howToFix.push(boolNote);
    if (annotation && parsed.actual) {
      howToFix.push(
        `Or change ${owner}'s return annotation from \`${annotation}\` to \`${cleanTypeName(parsed.actual)}\`.`,
      );
    }
    return {
      headline: `${owner} says it returns ${wanted}, but this line returns ${got}.`,
      howToFix,
    };
  }

  if (parsed.kind === "variable") {
    if (parsed.element) {
      return {
        headline:
          `${named} is annotated so ${membersPhrase(parsed.element)} it is ${wanted}, ` +
          `but ${parsed.element} is not.`,
        howToFix: [`Look at ${parsed.element} of the value assigned to ${named}.`],
      };
    }
    const got = parsed.actual ? describeType(parsed.actual) : "a different type";
    const howToFix = [`Assign ${wanted} to ${named}.`];
    if (boolNote) howToFix.push(boolNote);
    if (convert) {
      howToFix.push(`You can convert the value with \`${convert}(...)\`.`);
    }
    if (annotation && parsed.actual) {
      howToFix.push(
        `Or change ${named}'s annotation from \`${annotation}\` to \`${cleanTypeName(parsed.actual)}\`.`,
      );
    }
    return {
      headline: `${named} is annotated as ${wanted}, but ${got} was assigned here.`,
      howToFix,
    };
  }

  // Unfamiliar wording: still say what kind of problem this is, and pass
  // typeguard's own sentence through rather than inventing detail.
  return {
    headline: "A value does not match the type annotation written for it.",
    howToFix: [
      message.split(/\r?\n/)[0].trim(),
      "Either pass a value of the annotated type, or change the annotation.",
    ],
  };
}
