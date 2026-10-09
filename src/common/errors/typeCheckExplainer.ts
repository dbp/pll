import { levelRejectsBoolAsNumber, type Level } from "../level";
import { FUNCTION_TAKERS } from "./libraryFacts";
import { typeWords } from "./wording";
import type { ErrorFacts, TypeCheck } from "./pythonError";
import type { BeginnerExplanation } from "./types";

/**
 * Rewrites typeguard's `TypeCheckError`s into beginner-facing explanations,
 * from the parts Python read the message into (`ErrorFacts.check`).
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

/**
 * The module prefix a student did not write: a file - and its tests - run
 * as `__main__`, so its classes arrive as `__main__.Dog`.
 */
const MAIN_PREFIX = "__main__.";

/**
 * Names PLL's own classes report as, where the course calls them something
 * else. A table row *is* a dict - `Row` subclasses it so a row still
 * compares equal to the plain dict a test is written with - and `dict` is
 * the type the course gives for a row. Telling a student to annotate `Row`
 * would be telling them to write a name they have never been shown.
 */
const COURSE_NAME_FOR: Record<string, string> = { Row: "dict" };
// PLL's own picture classes - `_Circle`, a chart - arrive already named
// `Image` (`_pll_course_type_name`).

function cleanTypeName(type: string): string {
  // Replaced anywhere, not just at the start: typeguard reports a class
  // object as `class __main__.ITunesSong`, so the prefix sits in the middle
  // of the name it prints.
  const cleaned = type.split(MAIN_PREFIX).join("");
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

/** A check whose wording Python did not recognise. */
const UNFAMILIAR: TypeCheck = { kind: "unknown", name: null, element: null, actual: null, expected: [] };

/** The check Python read, with its element in the words a student is shown. */
function described(check: TypeCheck | undefined): TypeCheck {
  if (check === undefined) return UNFAMILIAR;
  return { ...check, element: check.element === null ? null : describeElement(check.element) };
}

/**
 * What the host knows about the line a `None` return came from.
 *
 * Supplied when it is known; without it the explanation falls back to the
 * general advice, which is correct but says less.
 */
export interface ReturnContext {
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
  /**
   * What Python learned: the check, the failing element, a swapped field,
   * how a function that returned `None` is built.
   */
  facts?: ErrorFacts;
}

/**
 * The methods that change a value in place and give back `None`, so that
 * `result = result.append(w)` leaves `result` as `None` - and the error
 * then appears at the `return` two lines later with nothing to connect them.
 */
const RETURNS_NONE = [
  "append",
  "extend",
  "insert",
  "remove",
  "sort",
  "reverse",
  "clear",
  "add",
  "discard",
  "update",
];

/** The in-place method `name` was last set from, and the line. */
function setFromVoidMethod(facts: ErrorFacts | undefined, name: string): { method: string; line: number } | null {
  const assigned = facts?.assigned?.[name];
  if (assigned === undefined || !assigned.call.includes(".")) {
    return null;
  }
  const method = assigned.call.slice(assigned.call.lastIndexOf(".") + 1);
  return RETURNS_NONE.includes(method) ? { method, line: assigned.line } : null;
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
function noneReturn(owner: string, wanted: string, context: ReturnContext | undefined): BeginnerExplanation {
  const annotate = `Or annotate the return type as \`None\` if ${owner} is not meant to return anything.`;

  const returned =
    context?.line != null ? /^\s*return\s+(\S.*?)\s*$/.exec(context.line) : null;
  if (returned !== null && context !== undefined) {
    const expression = returned[1];
    const name = /^[A-Za-z_]\w*$/.test(expression) ? expression : null;
    const void_ = name !== null ? setFromVoidMethod(context.facts, name) : null;
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
  const match = context?.facts?.returnedNone?.match ?? null;
  if (match !== null) {
    const howToFix: string[] = [];
    // When what is matched is annotated with a union, the variants with no
    // `case` can be named outright.
    const missing = match.uncovered;
    if (missing.length > 0) {
      howToFix.push(
        `There is no \`case\` for ${missing.map((name) => `\`${name}\``).join(" or ")}.`,
      );
    } else {
      howToFix.push(`Every possible value of \`${match.subject}\` needs a \`case\`.`);
      if (match.hasList && !match.patterns.some((pattern) => pattern.trim() === "[]")) {
        howToFix.push("The empty list, `case []:`, is the one most often left out.");
      }
    }
    for (const pattern of match.fixedLength) {
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
  const printed = context?.facts?.returnedNone?.printed ?? null;
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
 * What every kind of explanation is built from: the check, and the phrases
 * worked out from it once.
 */
interface TypeCheckCase {
  message: string;
  parsed: TypeCheck;
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
  const parsed = described(context?.facts?.check);
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
    boolNote: boolAsNumberNote(parsed.expected, parsed.actual, parsed.level ?? level),
    annotation: parsed.expected.length === 1 ? cleanTypeName(parsed.expected[0]) : null,
  };
  return classGiven(c) ?? BY_KIND[parsed.kind](c);
}

/** One explanation per kind of message, so a new kind needs one to compile. */
const BY_KIND: {
  [Kind in TypeCheck["kind"]]: (c: TypeCheckCase) => BeginnerExplanation;
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
}: TypeCheckCase): BeginnerExplanation {
  // A `None` result has three quite different causes, and one message
  // for all of them describes the symptom rather than any of them.
  if (parsed.actual === "None" || parsed.actual === "NoneType") {
    return noneReturn(owner, wanted, context);
  }
  if (parsed.element) {
    // One item of a collection: the collection is what was asked for, so
    // the item is the thing to change - not the annotation's container.
    const value = context?.facts?.elementValue;
    const element = describeElement(parsed.element);
    const container = parsed.actual ? cleanTypeName(parsed.actual) : "value";
    const howToFix = [
      `Look at ${element} of the ${container} this line returns: every one has to match the annotation, not just the first.`,
    ];
    const elementType = context?.facts?.elementType;
    const written = parsed.annotation ?? null;
    if (written !== null && annotation !== null && elementType !== undefined) {
      // Only where the annotation names the type once, so which one to
      // change is not a guess.
      const type = new RegExp(`\\b${annotation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
      if ((written.match(type) ?? []).length === 1) {
        howToFix.push(
          `Or, if that is what it should hold, change the annotation from \`${written}\` to \`${written.replace(type, elementType)}\`.`,
        );
      }
    }
    return {
      headline:
        `${owner} says it returns ${written !== null ? `\`${written}\`` : `a ${container}`}, with ` +
        `${membersPhrase(element)} it ${wanted}, but ${element}${value !== undefined ? ` is ${value}` : " is not"}.`,
      howToFix,
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
