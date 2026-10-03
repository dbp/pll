import { levelRejectsBoolAsNumber, type Level } from "../level";
import { FUNCTION_TAKERS } from "./libraryFacts";
import { typeWords } from "./wording";
import type { ErrorFacts } from "./pythonError";
import {
  annotationOf,
  assignedFromVoidMethod,
  functionBody,
  trailingMatch,
  unionMembersOf,
} from "./sourceFacts";
import type { BeginnerExplanation } from "./types";

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
  kind: "argument" | "return" | "variable" | "field" | "unknown";
  /** Parameter or variable name, when the message names one. */
  name: string | null;
  /** Set when the failure is about something *inside* a collection. */
  element: string | null;
  /** Type the offending value actually had, as typeguard reported it. */
  actual: string | null;
  /** Type(s) the annotation asked for. */
  expected: string[];
  /** For "field": the class whose field it is, and the value it got. */
  owner?: string;
  value?: string;
}

/**
 * Module prefixes that are PLL's own bookkeeping, not something a student
 * wrote. A file runs as `__main__`, so its classes arrive as `__main__.Dog`;
 * `__pll_test__` is the module the test phase runs a file in, and without
 * this a class the student named `Account` was reported as
 * `__pll_test__.Account`.
 */
const INTERNAL_MODULES = ["__main__.", "__pll_test__."];

/**
 * Names PLL's own classes report as, where the course calls them something
 * else. A table row *is* a dict - `Row` subclasses it so a row still
 * compares equal to the plain dict a test is written with - and `dict` is
 * the type the course gives for a row. Telling a student to annotate `Row`
 * would be telling them to write a name they have never been shown.
 */
const COURSE_NAME_FOR: Record<string, string> = { Row: "dict" };

function cleanTypeName(type: string): string {
  // Replaced anywhere, not just at the start: typeguard reports a class
  // object as `class __pll_test__.ITunesSong`, so the prefix sits in the
  // middle of the name it prints.
  let cleaned = type;
  for (const prefix of INTERNAL_MODULES) {
    cleaned = cleaned.split(prefix).join("");
  }
  return COURSE_NAME_FOR[cleaned] ?? cleaned;
}

/** e.g. `int` -> "a whole number (`int`)", `Dog` -> "`Dog`". */
function describeType(type: string): string {
  const name = cleanTypeName(type);
  // (c) `None`'s gloss is already the type name; "`None` (`None`)" is silly.
  if (name === "None" || name === "NoneType") return "`None`";
  const friendly = typeWords(name, { article: true });
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
    "At `#level beginner` and `#level intermediate`, `True` and `False` are not " +
    "accepted as numbers, even though Python counts them as `1` and `0`."
  );
}

/**
 * The field `line` reads from `name`, when the line replaces `name` itself.
 *
 * `ac = ac.balance + amt` reads `ac.balance` and assigns `ac`: the field it
 * reads is the one that was meant to change.
 */
function fieldBeingReplaced(line: string | null, name: string | null): string | null {
  if (line === null || name === null) {
    return null;
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const assigns = new RegExp(`^\\s*${escaped}\\s*=(?!=)(.*)$`).exec(line);
  if (assigns === null) {
    return null;
  }
  const reads = new RegExp(`\\b${escaped}\\.([A-Za-z_]\\w*)\\b(?!\\s*\\()`).exec(assigns[1]);
  return reads === null ? null : reads[1];
}

/** "a whole number (`int`)" stays as it is; "`Account`" becomes "an `Account`". */
function withArticle(described: string): string {
  if (!described.startsWith("`") || described === "`None`") {
    return described;
  }
  return `${/^`[AEIOUaeiou]/.test(described) ? "an" : "a"} ${described}`;
}

/** The class, when a class object was passed where an instance was wanted. */
function classItself(actual: string | null): string | null {
  const m = actual === null ? null : /^class (.+)$/.exec(actual);
  return m === null ? null : cleanTypeName(m[1]);
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
    return `the value for key ${plainKey(element.slice("value of key ".length))}`;
  }
  if (element.startsWith("key ")) return `key ${plainKey(element.slice("key ".length))}`;
  if (element.startsWith("[")) return "one of the values";
  return element;
}

/**
 * A key as typeguard quotes it - Python's `repr`, so `'a'` - in the double
 * quotes PLL writes a string in, so that the key and the value described
 * beside it read alike. A key that is not a plain string, or whose quotes
 * Python chose because of what is in it, is left as Python wrote it.
 */
function plainKey(key: string): string {
  const simple = /^'([^'"\\]*)'$/.exec(key);
  return simple ? `"${simple[1]}"` : key;
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

  // A dataclass field, which PLL words itself: typeguard is asked to check
  // one, so its own message calls it an assignment, and nobody assigned
  // anything. The value is in the message because only Python had it.
  const field = /^field '(\w+)' of '([\w.]+)' got (.+) \(([\w.]+)\), not (.+)$/.exec(first);
  if (field !== null) {
    return {
      kind: "field",
      name: field[1],
      element: null,
      actual: field[4],
      expected: [field[5]],
      owner: field[2],
      value: field[3],
    };
  }

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
 * What the host knows about the line a `None` return came from.
 *
 * Supplied when it is known; without it the explanation falls back to the
 * general advice, which is correct but says less.
 */
export interface ReturnContext {
  /** The whole file. */
  source: string;
  /** The student's line that the check fired on, or null. */
  line: string | null;
  /**
   * The library function that called the student's function, when one did.
   *
   * `transform_column` calls the function it was given once per *value*,
   * not once per row. Without this the advice is "check the value you
   * passed for `r` on this line" - and on that line nothing was passed.
   */
  calledBy?: string | null;
  /** What Python learned from the frames: the failing element, a swapped field. */
  facts?: ErrorFacts;
}

/**
 * The members of the union being matched that have no `case`.
 *
 * Empty unless everything lines up: the subject is a plain parameter, that
 * parameter is annotated, and the annotation is a union written in this
 * file. Naming the wrong variant would be worse than naming none.
 */
function uncoveredVariants(
  source: string,
  functionName: string | null,
  match: { subject: string; patterns: string[] },
): string[] {
  if (functionName === null || !/^[A-Za-z_]\w*$/.test(match.subject)) {
    return [];
  }
  const annotation = annotationOf(source, functionName, match.subject);
  if (annotation === null) {
    return [];
  }
  const members = unionMembersOf(source, annotation);
  if (members === null) {
    return [];
  }
  const covered = new Set(
    match.patterns
      .map((pattern) => /^([A-Za-z_]\w*)/.exec(pattern))
      .filter((named): named is RegExpExecArray => named !== null)
      .map((named) => named[1]),
  );
  // A wildcard `case _:` or a bare name catches everything, so nothing is
  // uncovered and the real cause is elsewhere.
  if (match.patterns.some((pattern) => /^_?$/.test(pattern.trim()))) {
    return [];
  }
  return members.filter((member) => !covered.has(member));
}

/**
 * A function annotated to return something that produced `None`.
 *
 * Three causes, which need different things said about them:
 *
 *   - it ran off its end, with no `return` on the path taken;
 *   - a `return` ran, and the thing it returned was already `None` -
 *     usually a name assigned from `.append(...)`, which returns nothing;
 *   - a `match` fitted no case, so nothing happened and the function
 *     then ran off its end.
 */
function noneReturn(
  owner: string,
  wanted: string,
  functionName: string | null,
  context: ReturnContext | undefined,
): BeginnerExplanation {
  const annotate = `Or annotate the return type as \`None\` if ${owner} is not meant to return anything.`;

  const returned =
    context?.line != null ? /^\s*return\s+(\S.*?)\s*$/.exec(context.line) : null;
  if (returned !== null && context !== undefined) {
    const expression = returned[1];
    const name = /^[A-Za-z_]\w*$/.test(expression) ? expression : null;
    const void_ = name !== null ? assignedFromVoidMethod(context.source, name) : null;
    if (void_ !== null) {
      return {
        headline:
          `${owner} returned \`None\`, because \`${name}\` was set to the result of ` +
          `\`.${void_.method}(...)\` on line ${void_.line}.`,
        howToFix: [
          `\`.${void_.method}(...)\` changes the list in place and gives back nothing.`,
          `Call it on its own line - \`${name}.${void_.method}(...)\` - rather than ` +
            `assigning its result back to \`${name}\`.`,
        ],
      };
    }
    if (expression === "None") {
      // Written out: `return None`, where something was meant to come back.
      return {
        headline: `${owner} returns \`None\` on this line, but it should return ${wanted}.`,
        howToFix: [`Return ${wanted} here, or annotate ${owner} as returning \`None\`.`],
      };
    }
    return {
      headline: `${owner} should return ${wanted}, but \`${expression}\` is \`None\` here.`,
      howToFix: [
        "This line did return - what it returned was nothing.",
        `Check where \`${expression}\` was last set.`,
        annotate,
      ],
    };
  }

  // No `return` ran at all. If the function ends in a `match`, no case
  // fitting is overwhelmingly the reason.
  const match = functionName !== null && context !== undefined
    ? trailingMatch(context.source, functionName)
    : null;
  if (match !== null && match.atEndOfFunction && context !== undefined) {
    const howToFix: string[] = [];
    // When the thing being matched is a union written in this file, the
    // variants with no `case` can be named outright.
    const missing = uncoveredVariants(context.source, functionName, match);
    if (missing.length > 0) {
      howToFix.push(
        `There is no \`case\` for ${missing.map((name) => `\`${name}\``).join(" or ")}.`,
      );
    } else {
      howToFix.push(`Every possible value of \`${match.subject}\` needs a \`case\`.`);
      if (match.hasListPattern && !match.patterns.some((pattern) => pattern.trim() === "[]")) {
        howToFix.push("The empty list, `case []:`, is the one most often left out.");
      }
    }
    for (const pattern of match.fixedLengthPatterns) {
      const parts = pattern.slice(1, -1).split(",").map((part) => part.trim());
      howToFix.push(
        `\`case ${pattern}:\` matches a list of exactly ${parts.length} items; ` +
          `for a first and a rest, write \`[${parts.slice(0, -1).join(", ")}, *${parts[parts.length - 1]}]\`.`,
      );
    }
    // Deliberately no "annotate it as `None`" here. A `match` that fitted
    // nothing is a missing case; annotating the return type as `None`
    // would silence the symptom and keep the bug.
    return {
      headline: `No \`case\` in ${owner} fitted \`${match.subject}\`, so nothing was returned.`,
      howToFix,
    };
  }

  // A branch that ends in `print` is the single commonest version of this,
  // and it shows the right answer on screen - so the function looks fine.
  // Once found it is the cause, so the general advice is left out.
  const printed = printEndingABranch(context?.source, functionName);
  if (printed !== null) {
    return {
      headline: `${owner} should return ${wanted}, but it finished without returning a value.`,
      howToFix: [
        `Line ${printed.line} ends its branch with \`print\`: did you mean ` +
          (printed.expression !== null
            ? `\`return ${printed.expression}\`?`
            : "`return` instead of `print`?"),
        "`print` shows a value on screen; `return` hands it back to whatever called the function.",
      ],
    };
  }
  const howToFix = [
    "Make sure every path through the function reaches a `return`.",
    "An `if` with no `else` falls off the end, and Python then returns `None`.",
  ];
  howToFix.push(annotate);
  return {
    headline: `${owner} should return ${wanted}, but it finished without returning a value.`,
    howToFix,
  };
}

/**
 * A `print` that is the last statement of its branch, when there is one.
 *
 * Not "prints and never returns": `add_shipping` returns in two branches
 * and prints in the third, and it is the third that ran. A `print`
 * followed by a `return` in the same block is just output, and is left
 * alone.
 */
function printEndingABranch(
  source: string | undefined,
  functionName: string | null,
): { line: number; expression: string | null } | null {
  if (source === undefined || functionName === null) {
    return null;
  }
  const body = functionBody(source, functionName);
  if (body === null) {
    return null;
  }
  for (let i = 0; i < body.length; i++) {
    const call = /^\s*print\s*\((.*)\)\s*(?:#.*)?$/.exec(body[i].text);
    if (call === null) {
      continue;
    }
    // The next line at this depth or shallower: a dedent, or nothing at
    // all, means the print is where this branch ends.
    const next = body.slice(i + 1).find((entry) => entry.indent <= body[i].indent);
    if (next !== undefined && next.indent === body[i].indent) {
      continue;
    }
    // One plain argument can be returned as it is; `print("x", y)` or a
    // `sep=` cannot, so those get the question without a guess.
    const argument = call[1].trim();
    const single = argument.length > 0 && !/,(?![^()[\]{}]*[)\]}])/.test(argument);
    return { line: body[i].line, expression: single ? argument : null };
  }
  return null;
}

/**
 * What every kind of explanation is built from: the parsed message, and the
 * phrases worked out from it once.
 */
interface TypeCheckCase {
  message: string;
  parsed: ParsedTypeCheckError;
  functionName: string | null;
  level: Level | undefined;
  context: ReturnContext | undefined;
  /** What the annotation asks for, in words. */
  wanted: string;
  /** The function the annotation belongs to, or "this function". */
  owner: string;
  /** The value's name, or "a value". */
  named: string;
  /** A conversion that would fix it, when there is an obvious one. */
  convert: string | null;
  /** Why a bool is not a number here, at the levels that say so. */
  boolNote: string | null;
  /** The annotation as written, when it names one type. */
  annotation: string | null;
}

/**
 * Build the student-facing explanation. `functionName` is the function the
 * annotation belongs to, when the traceback identifies one.
 */
export function explainTypeCheckError(
  message: string,
  functionName: string | null,
  level?: Level,
  context?: ReturnContext,
): BeginnerExplanation {
  const parsed = parseTypeCheckMessage(message);
  const c: TypeCheckCase = {
    message,
    parsed,
    functionName,
    level,
    context,
    wanted: describeTypes(parsed.expected),
    owner: functionName ? `\`${functionName}\`` : "this function",
    named: parsed.name ? `\`${parsed.name}\`` : "a value",
    convert: conversionFor(parsed.expected, parsed.actual),
    boolNote: boolAsNumberNote(parsed.expected, parsed.actual, level),
    annotation: parsed.expected.length === 1 ? cleanTypeName(parsed.expected[0]) : null,
  };
  return classGiven(c) ?? BY_KIND[parsed.kind](c);
}

/** One explanation per kind of message, so a new kind needs one to compile. */
const BY_KIND: {
  [Kind in ParsedTypeCheckError["kind"]]: (c: TypeCheckCase) => BeginnerExplanation;
} = {
  argument: explainArgument,
  field: explainField,
  return: explainReturn,
  variable: explainVariable,
  unknown: explainUnfamiliar,
};

/** The class itself where one made from it was meant, whatever was annotated. */
function classGiven({ parsed, owner, named }: TypeCheckCase): BeginnerExplanation | null {
  const classPassed = classItself(parsed.actual);
  if (classPassed === null || parsed.element !== null) {
    return null;
  }
  // `ITunesSong` rather than `ITunesSong(...)`. The two annotations read
  // almost identically - "expects s to be ITunesSong, but got class
  // ITunesSong" - so the difference has to be spelled out.
  const where =
    parsed.kind === "return"
      ? `${owner} returned`
      : parsed.kind === "variable"
        ? `${named} was given`
        : `${owner} was given`;
  return {
    headline: `${where} the class \`${classPassed}\` itself, not one made from it.`,
    howToFix: [
      `\`${classPassed}\` on its own is the blueprint; \`${classPassed}(...)\` makes one.`,
      `Add the brackets and the values for its fields: \`${classPassed}(...)\`.`,
    ],
  };
}

/** An argument that does not match its parameter's annotation. */
function explainArgument({
  parsed,
  owner,
  named,
  wanted,
  convert,
  boolNote,
  annotation,
  context,
}: TypeCheckCase): BeginnerExplanation {
  if (parsed.element) {
    // What the element *is*, when Python could read it - "item 0 is not"
    // left the student to go and find out.
    const value = context?.facts?.elementValue;
    const is = value !== undefined ? ` is ${value}` : " is not";
    return {
      headline:
        `${owner} expects ${membersPhrase(parsed.element)} ${named} to be ${wanted}, ` +
        `but ${parsed.element}${is}.`,
      howToFix: [
        `Look at ${parsed.element} of the ${parsed.actual ?? "value"} you passed for ${named}.`,
        "Every one has to match the annotation, not just the first.",
      ],
    };
  }
  const got = parsed.actual ? `, but got ${describeType(parsed.actual)}` : "";
  const supplied = context?.calledBy ?? null;
  if (supplied !== null) {
    // Nothing on this line passed anything, so the advice is about the
    // `def` - and the generic "convert it" / "change the annotation"
    // bullets below would only repeat that in two more ways.
    const howToFix =
      supplied === "reactor"
        ? [
            `The reactor calls ${owner} with its state: the \`init\` value to start ` +
              `with, then whatever the handlers return. So ${named} is the reactor's ` +
              "state, not a value from this line.",
          ]
        : [
            `${FUNCTION_TAKERS[supplied]?.calls ?? `\`${supplied}\` calls ${owner} for you`}, ` +
              `so ${named} is whatever it hands over - not a value from this line.`,
          ];
    if (annotation !== null && parsed.actual !== null) {
      howToFix.push(
        `Annotate ${named} as \`${cleanTypeName(parsed.actual)}\` in ${owner}, ` +
          `or change what ${supplied === "reactor" ? "the reactor" : `\`${supplied}\``} is given so it hands over ${wanted}.`,
      );
    }
    if (boolNote) howToFix.push(boolNote);
    return { headline: `${owner} expects ${named} to be ${wanted}${got}.`, howToFix };
  }
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

/** A dataclass field given a value of the wrong type. */
function explainField({
  parsed,
  wanted,
  convert,
  annotation,
  context,
}: TypeCheckCase): BeginnerExplanation {
  const owner = parsed.owner ?? "this class";
  // Python found another field this value fits, whose value fits here:
  // the two were given in each other's places, and converting one would
  // hide that.
  const swappedWith = context?.facts?.swappedWith;
  if (swappedWith !== undefined) {
    return {
      headline:
        `The values for \`${parsed.name}\` and \`${swappedWith}\` of \`${owner}\` ` +
        "look swapped.",
      howToFix: [
        `\`${parsed.name}\` got \`${parsed.value ?? "?"}\`, which fits \`${swappedWith}\` - and the other way round.`,
        `Give the values in the order the fields are written in \`class ${owner}\`.`,
      ],
    };
  }
  const got =
    parsed.value !== undefined
      ? `\`${parsed.value}\``
      : parsed.actual
        ? describeType(parsed.actual)
        : "something else";
  return {
    headline:
      `The \`${parsed.name}\` field of \`${owner}\` should be ${wanted}, ` +
      `but got ${got}.`,
    howToFix: [
      `Check the values given to \`${owner}(...)\`, in the order its fields are written.`,
      ...(convert !== null
        ? [`If it should be ${wanted}, convert it with \`${convert}(...)\`.`]
        : []),
      ...(annotation !== null && parsed.actual !== null
        ? [
            `Or change the field's annotation from \`${annotation}\` to ` +
              `\`${cleanTypeName(parsed.actual)}\`.`,
          ]
        : []),
    ],
  };
}

/** A return value that does not match the function's annotation. */
function explainReturn({
  parsed,
  owner,
  wanted,
  convert,
  boolNote,
  annotation,
  context,
  functionName,
}: TypeCheckCase): BeginnerExplanation {
  // A `None` result has three quite different causes, and one message
  // for all of them describes the symptom rather than any of them.
  if (parsed.actual === "None" || parsed.actual === "NoneType") {
    return noneReturn(owner, wanted, functionName, context);
  }
  const got = parsed.actual ? describeType(parsed.actual) : "something else";
  const howToFix: string[] = [];
  const wantsNone = parsed.expected.length === 1 && /^(None|NoneType)$/.test(parsed.expected[0]);
  if (wantsNone) {
    howToFix.push("Use a bare `return`, or drop the `return` entirely.");
  } else if (convert) {
    howToFix.push(`Convert the returned value with \`${convert}(...)\`.`);
  } else {
    howToFix.push(`Return ${withArticle(wanted)} from this line.`);
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

/** An annotated variable assigned a value of the wrong type. */
function explainVariable({
  parsed,
  named,
  wanted,
  convert,
  boolNote,
  annotation,
  context,
}: TypeCheckCase): BeginnerExplanation {
  if (parsed.element) {
    return {
      headline:
        `${named} is annotated so ${membersPhrase(parsed.element)} it is ${wanted}, ` +
        `but ${parsed.element} is not.`,
      howToFix: [`Look at ${parsed.element} of the value assigned to ${named}.`],
    };
  }
  const got = parsed.actual ? describeType(parsed.actual) : "a different type";
  // `ac = ac.balance + amt`, where `ac.balance = ...` was meant: the line
  // reads one of the variable's own fields, so that field is the target.
  const field = fieldBeingReplaced(context?.line ?? null, parsed.name);
  if (field !== null && parsed.name !== null) {
    const rhs = (/=\s*(.+)$/.exec(context?.line ?? "") ?? [, "..."])[1].trim();
    return {
      headline: `${named} is annotated as ${wanted}, but ${got} was assigned here.`,
      howToFix: [
        `To change the \`${field}\` field of ${named}, assign to the field: ` +
          `\`${parsed.name}.${field} = ${rhs}\`.`,
        `\`${parsed.name} = ...\` replaces the whole ${annotation !== null ? `\`${annotation}\`` : "value"}, field and all.`,
      ],
    };
  }
  // "Assign `Account` to `ac`" read as assigning the class itself, so a
  // class gets an article, the way a gloss like "a whole number" has one.
  const howToFix = [`Assign ${withArticle(wanted)} to ${named}.`];
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

/**
 * Unfamiliar wording: still say what kind of problem this is, and pass
 * typeguard's own sentence through rather than inventing detail.
 */
function explainUnfamiliar({ message }: TypeCheckCase): BeginnerExplanation {
  return {
    headline: "A value does not match the type annotation written for it.",
    howToFix: [
      message.split(/\r?\n/)[0].trim(),
      "Either pass a value of the annotated type, or change the annotation.",
    ],
  };
}
