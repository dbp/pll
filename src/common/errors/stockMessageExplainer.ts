/**
 * PLL's wording for the errors Python words badly for a beginner.
 *
 * Each rule reads Python's message and, where it needs more, the student's
 * own source: Python says `pen_cost() missing 1 required positional
 * argument: 'message'` without saying that `pen_cost` takes two, and the
 * `def` line does.
 *
 * Returns null when no rule fits, and the message is then shown as Python
 * wrote it. That is the right default - a confident wrong explanation is
 * worse than a terse right one - so rules match narrowly and give up
 * readily. Several here do nothing but delete Python's internal names
 * (`__init__`, `types.UnionType`, `Table.`), which is worth a rule on its
 * own: those names send a student looking for something they never wrote.
 */
import { levelRefusesReassignment, type Level } from "../level";
import {
  FUNCTION_TAKER_NAMES,
  FUNCTION_TAKERS,
  HANDLER_KEYWORDS,
  libraryHint,
  librarySignature,
} from "./libraryFacts";
import type { ErrorFacts, ErrorFrame } from "./pythonError";
import { plural, typeWords } from "./wording";
import {
  closestName,
  fieldsOf,
  listNames,
  parametersOf,
  unionMembersOf,
} from "./sourceFacts";
import type { BeginnerExplanation } from "./types";

/** What the host knows about where the error came from. */
export interface StockContext {
  source: string;
  /** The student's line that raised, when it is known. */
  offendingLine: string | null;
  /** Every frame, outermost first, for rules that care where the error came from. */
  frames: ErrorFrame[];
  /** What Python learned from those frames. */
  facts: ErrorFacts;
  /**
   * The level the file runs at.
   *
   * Some fixes are not available at every level: `beginner` and
   * `intermediate` reject reassigning a name at module scope, so advice
   * that says `t = t.add_column(...)` would be refused if it were taken.
   */
  level: Level;
}

export function explainStockMessage(
  errorType: string,
  message: string,
  ctx: StockContext,
): BeginnerExplanation | null {
  for (const rule of RULES) {
    if (!rule.types.includes(errorType)) continue;
    const m = rule.pattern.exec(message);
    const explanation = m === null ? null : rule.explain(m, ctx, message);
    if (explanation !== null) {
      return explanation;
    }
  }
  return null;
}

/** Every error type some rule explains: what the stock analyzer claims. */
export function stockErrorTypes(): string[] {
  return [...new Set(RULES.flatMap((rule) => rule.types))];
}

/**
 * One rewording: the error types it is for, Python's message as it
 * recognises it, and what to say instead - or null, when on a closer look
 * it cannot say anything better than Python did.
 */
interface Rule {
  types: string[];
  pattern: RegExp;
  explain(m: RegExpExecArray, ctx: StockContext, message: string): BeginnerExplanation | null;
}

// -- shared wording ---------------------------------------------------------

/** `str` -> "string". A class the student wrote keeps its own name. */
function friendly(type: string): string {
  const name = lastSegment(type);
  return typeWords(name) ?? `\`${name}\``;
}

function lastSegment(type: string): string {
  return type.split(".").pop() as string;
}

/** "takes 2 arguments (`a`, `b`)", or "takes 2 arguments" if unknown. */
function takesClause(names: string[] | null, count: number): string {
  if (names !== null && names.length > 0) {
    return `takes ${plural(names.length, "argument")} (${listNames(names)})`;
  }
  return `takes ${plural(count, "argument")}`;
}

/** The names Python quoted in `missing 2 ... : 'a' and 'b'`. */
function quotedNames(message: string): string[] {
  return Array.from(message.matchAll(/'(\w+)'/g), (m) => m[1]);
}

/**
 * The call on `line` whose result the error is probably about.
 *
 * `print(deposit(acct1, 50) + 1)` has two calls on it and the interesting
 * one is `deposit`: a wrapper like `print` or `str` is almost never what
 * produced the offending value, so it is only named when it is the only
 * call there.
 */
const WRAPPERS = new Set([
  "print",
  "str",
  "int",
  "float",
  "bool",
  "len",
  "list",
  "sorted",
  "round",
  "abs",
  "sum",
  "min",
  "max",
  "type",
  "repr",
]);

function callOn(line: string | null): string | null {
  const names = Array.from(
    (line ?? "").matchAll(/([A-Za-z_][\w.]*)\s*\(/g),
    (m) => m[1],
  );
  if (names.length === 0) {
    return null;
  }
  return names.find((name) => !WRAPPERS.has(name)) ?? names[0];
}

/** Why a value is `None`, which is almost never obvious to a beginner. */
const WHY_NONE = [
  "A function with no `return` gives back `None`.",
  "A method that changes something in place - `append`, `sort` - also gives back `None`.",
];

// -- reading a line ---------------------------------------------------------

/**
 * One line of Python, split into enough tokens to find an operand.
 *
 * Several rules want "the expression next to this `+`" or "the argument of
 * this `filter(`", written exactly as the student wrote it. A regex could
 * not see past a nested call - `"Total: " + add_shipping(pen_cost(10,
 * "bravo"))` was answered with `str(add_shipping)`, converting the function
 * rather than its result. Tokens let brackets balance and strings be
 * skipped, which is all these rules need.
 */
interface Token {
  kind: "str" | "name" | "num" | "open" | "close" | "op";
  text: string;
  start: number;
  end: number;
}

function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === "#") break;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const start = i;
    if (c === '"' || c === "'") {
      i++;
      while (i < line.length && line[i] !== c) i += line[i] === "\\" ? 2 : 1;
      i = Math.min(i + 1, line.length);
      tokens.push({ kind: "str", text: line.slice(start, i), start, end: i });
    } else if (/[A-Za-z_]/.test(c)) {
      while (i < line.length && /\w/.test(line[i])) i++;
      tokens.push({ kind: "name", text: line.slice(start, i), start, end: i });
    } else if (/\d/.test(c)) {
      while (i < line.length && /[\d.]/.test(line[i])) i++;
      tokens.push({ kind: "num", text: line.slice(start, i), start, end: i });
    } else if ("([{".includes(c)) {
      i++;
      tokens.push({ kind: "open", text: c, start, end: i });
    } else if (")]}".includes(c)) {
      i++;
      tokens.push({ kind: "close", text: c, start, end: i });
    } else {
      const two = line.slice(i, i + 2);
      const op = ["<=", ">=", "==", "!=", "**", "//"].includes(two) ? two : c;
      i += op.length;
      tokens.push({ kind: "op", text: op, start, end: i });
    }
  }
  return tokens;
}

/** The index of the bracket closing the one opened at `open`, or -1. */
function closing(tokens: Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i].kind === "open") depth++;
    if (tokens[i].kind === "close" && --depth === 0) return i;
  }
  return -1;
}

/** The expression starting at token `at`: a name, its attributes and calls. */
function operandFrom(line: string, tokens: Token[], at: number): string | null {
  if (at >= tokens.length || (tokens[at].kind !== "name" && tokens[at].kind !== "num")) {
    return null;
  }
  let last = at;
  for (let i = at + 1; i < tokens.length; ) {
    if (tokens[i].text === "." && tokens[i + 1]?.kind === "name") {
      last = i + 1;
      i += 2;
    } else if (tokens[i].kind === "open" && tokens[i].text !== "{") {
      const shut = closing(tokens, i);
      if (shut < 0) return null;
      last = shut;
      i = shut + 1;
    } else {
      break;
    }
  }
  return line.slice(tokens[at].start, tokens[last].end);
}

/** The expression ending at token `at`, read backwards to where it starts. */
function operandBefore(line: string, tokens: Token[], at: number): string | null {
  let first = at;
  let i = at;
  while (i >= 0) {
    if (tokens[i].kind === "close") {
      // Walk back to the matching open bracket.
      let depth = 0;
      let j = i;
      for (; j >= 0; j--) {
        if (tokens[j].kind === "close") depth++;
        if (tokens[j].kind === "open" && --depth === 0) break;
      }
      if (j < 0) return null;
      first = j;
      i = j - 1;
      continue;
    }
    if (tokens[i].kind === "name" || tokens[i].kind === "num") {
      first = i;
      if (tokens[i - 1]?.text === "." && tokens[i - 2]?.kind === "name") {
        i -= 2;
        continue;
      }
      break;
    }
    if (i === at) return null;
    break;
  }
  if (tokens[first].kind !== "name" && tokens[first].kind !== "num") return null;
  return line.slice(tokens[first].start, tokens[at].end);
}

/** A string literal and the operand `+` joins it to, as written. */
function concatOperands(
  line: string,
): { text: string; value: string; textFirst: boolean } | null {
  const tokens = tokenize(line);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].kind !== "str") continue;
    if (tokens[i + 1]?.text === "+") {
      const value = operandFrom(line, tokens, i + 2);
      if (value !== null) return { text: tokens[i].text, value, textFirst: true };
    }
    if (tokens[i - 1]?.text === "+" && i >= 2) {
      const value = operandBefore(line, tokens, i - 2);
      if (value !== null) return { text: tokens[i].text, value, textFirst: false };
    }
  }
  return null;
}

/**
 * A `+` operand that holds what `input()` returned, and the sum with it
 * converted: `age + 1` becomes `int(age) + 1`.
 */
function typedOperand(line: string, source: string): { name: string; fixed: string } | null {
  const tokens = tokenize(line);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].text !== "+") continue;
    for (const [at, side] of [[i - 1, "left"], [i + 1, "right"]] as const) {
      const token = tokens[at];
      if (token?.kind !== "name" || tokens[at + 1]?.text === "(" || tokens[at - 1]?.text === ".") {
        continue;
      }
      const escaped = token.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!new RegExp(`^[ \\t]*${escaped}[ \\t]*=[ \\t]*input[ \\t]*\\(`, "m").test(source)) {
        continue;
      }
      const left = side === "left" ? `int(${token.text})` : operandBefore(line, tokens, i - 1);
      const right = side === "right" ? `int(${token.text})` : operandFrom(line, tokens, i + 1);
      if (left === null || right === null) continue;
      return { name: token.text, fixed: `${left} + ${right}` };
    }
  }
  return null;
}

/**
 * Where the `None` came from, said about the student's own code.
 *
 * `receiver` is what the line did something to - the `x` of `x.total`, the
 * thing subscripted, looped over or added. If it is a call, that call gave
 * back `None`. If it is a name, the call it was set from did, and saying
 * which is the useful part: blaming the first call on the line named
 * `print` in `print(x.total)`, where `print` only wraps the value.
 *
 * `subject` opens the headline; `howToFix` explains.
 */
function whyNone(
  ctx: StockContext,
  receiver: string | null,
  unknown = "This value is `None`",
): { subject: string; howToFix: string[] } {
  const call = receiver === null ? null : /^([A-Za-z_][\w.]*)\s*\(/.exec(receiver);
  if (call !== null) {
    return { subject: `\`${call[1]}(...)\` gave back \`None\``, howToFix: WHY_NONE };
  }
  if (receiver !== null && /^[A-Za-z_][\w.]*$/.test(receiver)) {
    const subject = `\`${receiver}\` is \`None\``;
    // A parameter got its `None` from whoever called the function.
    const frames = ctx.frames.filter((frame) => frame.user);
    const inside = frames.at(-1)?.functionName ?? null;
    if (inside !== null && (parametersOf(ctx.source, inside) ?? []).includes(receiver)) {
      const caller = frames.at(-2);
      return {
        subject,
        howToFix: [
          `\`${receiver}\` is a parameter of \`${inside}\`, so the call` +
            (caller !== undefined ? ` on line ${caller.line}` : "") +
            ` gave it \`None\`.`,
          ...WHY_NONE,
        ],
      };
    }
    const setFrom = lastCallAssignedTo(ctx.source, receiver);
    return {
      subject,
      howToFix:
        setFrom === null
          ? WHY_NONE
          : [
              `\`${receiver}\` was set from \`${setFrom.call}(...)\` on line ${setFrom.line}, which gave back \`None\`.`,
              ...WHY_NONE,
            ],
    };
  }
  // Nothing on the line to point at: name a call, but never a wrapper
  // like `print`, which is not where the value came from.
  const named = Array.from((ctx.offendingLine ?? "").matchAll(/([A-Za-z_][\w.]*)\s*\(/g), (m) => m[1]).find(
    (name) => !WRAPPERS.has(name),
  );
  return {
    subject: named !== undefined ? `\`${named}(...)\` gave back \`None\`` : unknown,
    howToFix: WHY_NONE,
  };
}

/** The last `name = call(...)` in `source`: the call, and its line. */
function lastCallAssignedTo(source: string, name: string): { call: string; line: number } | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^[ \\t]*${escaped}[ \\t]*=(?!=)[ \\t]*([A-Za-z_][\\w.]*)\\s*\\(`);
  let found: { call: string; line: number } | null = null;
  source.split(/\r?\n/).forEach((text, i) => {
    const m = pattern.exec(text);
    if (m !== null) found = { call: m[1], line: i + 1 };
  });
  return found;
}

/** The expression `.attr` is read from on `line`, as written. */
function attributeReceiver(line: string | null, attr: string): string | null {
  if (line === null) return null;
  const tokens = tokenize(line);
  for (let i = 2; i < tokens.length; i++) {
    if (tokens[i].text === attr && tokens[i - 1].text === ".") {
      return operandBefore(line, tokens, i - 2);
    }
  }
  return null;
}

/** The expression subscripted on `line` - the `xs` of `xs[0]`. */
function subscriptReceiver(line: string | null): string | null {
  if (line === null) return null;
  const tokens = tokenize(line);
  for (let i = 1; i < tokens.length; i++) {
    const before = tokens[i - 1];
    if (tokens[i].text === "[" && (before.kind === "name" || before.text === ")" || before.text === "]")) {
      return operandBefore(line, tokens, i - 1);
    }
  }
  return null;
}

/** What `for ... in` loops over on `line`. */
function loopedOver(line: string | null): string | null {
  if (line === null) return null;
  const tokens = tokenize(line);
  const at = tokens.findIndex((t) => t.text === "in" && tokens[0]?.text === "for");
  return at < 0 ? null : operandFrom(line, tokens, at + 1);
}

/** The operand on one side of the first `operator` on `line`. */
function operandBeside(line: string | null, operator: string, side: "left" | "right"): string | null {
  if (line === null) return null;
  const tokens = tokenize(line);
  const at = tokens.findIndex((t) => t.kind === "op" && t.text === operator);
  if (at < 0) return null;
  return side === "left" ? operandBefore(line, tokens, at - 1) : operandFrom(line, tokens, at + 1);
}

/**
 * The literal with the space `print` will add for it taken out.
 *
 * `print("Next year you will be ", age)` prints two spaces: the one in
 * the string and the one `print` puts between its arguments.
 */
function withoutJoiningSpace(literal: string, before: boolean): string {
  const quote = literal[0];
  const inner = literal.slice(1, -1);
  const trimmed = before ? inner.replace(/ $/, "") : inner.replace(/^ /, "");
  return `${quote}${trimmed}${quote}`;
}

// -- rules ------------------------------------------------------------------

/**
 * `filter(below_1k())` - the function called instead of passed.
 *
 * The call happens before `filter` is entered, so what Python reports is
 * `below_1k() missing 1 required positional argument: 'r'`, pointing at
 * the `def` and mentioning neither `filter` nor the parentheses. Only the
 * student's line says which it was.
 */
/** Everything a function can be handed to: a library function, or a handler keyword. */
const CALLS_YOUR_FUNCTION = [...FUNCTION_TAKER_NAMES, ...HANDLER_KEYWORDS];

const functionCalledNotPassed: Rule = {
  types: ["TypeError"],
  pattern: /^(\w+)\(\) missing \d+ required positional argument/,
  explain: (m, ctx) => {
    if (ctx.offendingLine === null) {
      return null;
    }
    const name = m[1];
    const line = ctx.offendingLine;
    // The empty call has to be *given to* the taker, not merely share a line
    // with it: `filter(below_1k())` or `to_draw=draw()`. Matching anywhere on
    // the line would blame `filter` for an unrelated call beside it.
    const taker = CALLS_YOUR_FUNCTION.find((candidate) =>
      new RegExp(
        `\\b${candidate}\\b\\s*(?:\\(|=)\\s*(?:[^()]*,\\s*)?${name}\\s*\\(\\s*\\)`,
      ).test(line),
    );
    if (taker === undefined) {
      return null;
    }
    const keyword = HANDLER_KEYWORDS.includes(taker);
    return {
      headline: `\`${taker}\` calls \`${name}\` for you, so it needs the function itself.`,
      howToFix: [
        `Leave the brackets off: \`${keyword ? `${taker}=${name}` : `${taker}(${name})`}\`.`,
        `\`${name}()\` calls it right here, with nothing to work on.`,
      ],
    };
  },
};

/** `f() missing 2 required positional arguments: 'a' and 'b'` */
const tooFewArguments: Rule = {
  types: ["TypeError"],
  pattern: /^(\w+)\(\) missing (\d+) required positional argument/,
  explain: (m, ctx, message) => {
    const [, name, missingText] = m;
    const missing = Number(missingText);

    // A test function takes no parameters, so pytest has nothing to pass and
    // the test never runs.
    if (name.startsWith("test_")) {
      return {
        headline: `\`${name}\` is a test, so it cannot take any parameters.`,
        howToFix: [
          `Write \`def ${name}():\` with nothing in the brackets, and make the values it needs inside it.`,
        ],
      };
    }

    // The student's own `def` first, then PLL's own libraries - `circle` has
    // no `def` in the file but its contract is known all the same.
    const names = parametersOf(ctx.source, name) ?? librarySignature(name)?.required ?? null;
    if (names === null) {
      // An imported function from somewhere else: say only what is missing,
      // which Python did name, rather than inventing a total.
      return {
        headline: needsMore(name, missing, message),
        howToFix: ["Check the call on this line - one value is needed for each parameter."],
      };
    }
    return {
      headline:
        `\`${name}\` ${takesClause(names, names.length)}, but got ` +
        `${Math.max(names.length - missing, 0)}.`,
      howToFix: [
        "Check the call on this line - one value is needed for each parameter.",
        ...libraryHint(name),
      ],
    };
  },
};

function needsMore(name: string, missing: number, message: string): string {
  const absent = quotedNames(message);
  return (
    `\`${name}\` needs ${plural(missing, "more argument")}` +
    (absent.length > 0 ? `: ${listNames(absent)}` : "") +
    "."
  );
}

/** `f() takes 1 positional argument but 2 were given` */
const tooManyArguments: Rule = {
  types: ["TypeError"],
  pattern: /^(\w+)\(\) takes (\d+) positional arguments? but (\d+) (?:was|were) given/,
  explain: (m, ctx) => {
    const [, name, takesText, givenText] = m;
    // Too many, so the limit is every parameter there is, optional included.
    const names = parametersOf(ctx.source, name) ?? librarySignature(name)?.all ?? null;
    const extra = Number(givenText) - (names?.length ?? Number(takesText));
    return {
      headline: `\`${name}\` ${takesClause(names, Number(takesText))}, but got ${givenText}.`,
      howToFix: [
        extra > 1
          ? `Check the call on this line - there are ${extra} values too many.`
          : "Check the call on this line - there is one value too many.",
        ...libraryHint(name),
      ],
    };
  },
};

/**
 * `ITunesSong() takes no arguments`
 *
 * A class with annotated fields and no `@dataclass`. Python's message is
 * exactly true and completely unhelpful: the student wrote three fields
 * and is told the class takes nothing.
 */
const missingDataclass: Rule = {
  types: ["TypeError"],
  pattern: /^(\w+)\(\) takes no arguments/,
  explain: (m, ctx) => {
    const className = m[1];
    const fields = fieldsOf(ctx.source, className);
    if (fields === null) {
      return null;
    }
    return {
      headline:
        `\`${className}\` lists fields (${listNames(fields)}) but has no ` +
        "`@dataclass`, so it takes no arguments.",
      howToFix: [
        `Write \`@dataclass\` on the line above \`class ${className}\`.`,
        "Add `from dataclasses import dataclass` at the top of the file if it is not there.",
      ],
    };
  },
};

/**
 * A dataclass constructed with the wrong number of values.
 *
 * `__init__` is the thing to get rid of here: the student wrote
 * `ITunesSong(...)` and never wrote an `__init__`, so being told about one
 * sends them hunting for code that does not exist.
 */
const dataclassArity: Rule = {
  types: ["TypeError"],
  pattern: /^(\w+)\.__init__\(\) (?:missing (\d+) required positional argument|takes \d+ positional arguments? but \d+ (?:was|were) given)/,
  explain: (m, ctx, message) => {
    const className = m[1];
    const fields = fieldsOf(ctx.source, className);
    if (fields === null) {
      return {
        headline: `\`${className}\` was given the wrong number of values.`,
        howToFix: [`Give one value for each field of \`class ${className}\`, in order.`],
      };
    }
    // Python counts `self`, so a "takes 3 but 4 were given" message is about
    // 2 fields and 3 values. Both counts are recomputed from the fields.
    const given = /takes \d+ positional arguments? but (\d+)/.exec(message);
    const got =
      given !== null
        ? Number(given[1]) - 1
        : Math.max(fields.length - Number(m[2]), 0);
    return {
      headline:
        `\`${className}\` needs ${plural(fields.length, "value")} ` +
        `(${listNames(fields)}), but got ${got}.`,
      howToFix: [
        `Give one value for each field, in the order they are written in \`class ${className}\`.`,
      ],
    };
  },
};

/**
 * A method of PLL's own libraries called with too few arguments.
 *
 * Python names the class (`Table.scatter_plot()`), which the student never
 * typed - they wrote `movies.scatter_plot(...)`.
 */
const methodArity: Rule = {
  types: ["TypeError"],
  pattern: /^(\w+)\.(\w+)\(\) missing (\d+) required positional argument/,
  explain: (m, _ctx, message) => {
    if (m[2] === "__init__") {
      return null;
    }
    const [, , method, missingText] = m;
    const missing = Number(missingText);
    const signature = librarySignature(method);
    if (signature === null) {
      return { headline: needsMore(method, missing, message), howToFix: [] };
    }
    return {
      headline:
        `\`${method}\` ${takesClause(signature.required, signature.required.length)}, ` +
        `but got ${Math.max(signature.required.length - missing, 0)}.`,
      howToFix: [],
    };
  },
};

/** `'ITunesSong' object has no attribute 'yaer'` */
const noSuchAttribute: Rule = {
  types: ["AttributeError"],
  pattern: /^'([\w.]+)' object has no attribute '(\w+)'/,
  explain: (m, ctx) => {
    const type = m[1];
    const asked = m[2];
    if (lastSegment(type) === "NoneType") {
      const none = whyNone(ctx, attributeReceiver(ctx.offendingLine, asked));
      return { headline: `${none.subject}, so it has no \`${asked}\`.`, howToFix: none.howToFix };
    }
    const fields = fieldsOf(ctx.source, lastSegment(type));
    if (fields === null) {
      // A class of theirs with no fields - the empty end of a recursive
      // type, like `NoInfo` - has nothing to get, so the value needs
      // checking for before its fields are used.
      const name = lastSegment(type);
      if (new RegExp(`^[ \\t]*class[ \\t]+${name}\\b`, "m").test(ctx.source)) {
        return {
          headline: `\`${name}\` has no fields at all, so it has no \`${asked}\`.`,
          howToFix: [
            `A value that might be a \`${name}\` needs a \`case ${name}():\` before \`.${asked}\` is used.`,
          ],
        };
      }
      return {
        headline: `A ${friendly(type)} has no \`${asked}\`.`,
        howToFix: [],
      };
    }
    const suggestion = closestName(asked, fields);
    return {
      headline:
        `\`${lastSegment(type)}\` has no field \`${asked}\` ` +
        `(its fields are ${listNames(fields)}).`,
      howToFix: suggestion !== null ? [`Did you mean \`${suggestion}\`?`] : [],
    };
  },
};

/**
 * `type object 'ITunesSong' has no attribute 'name'`
 *
 * The class was used where one of its values was meant - `title(ITunesSong)`
 * rather than `title(song)`. "type object" is the giveaway, and means
 * nothing to a student.
 */
const attributeOnClass: Rule = {
  types: ["AttributeError"],
  pattern: /^type object '(\w+)' has no attribute '(\w+)'/,
  explain: (m, ctx) => {
    const [, className, asked] = m;
    const fields = fieldsOf(ctx.source, className);
    if (fields === null) {
      return null;
    }
    return {
      headline:
        `\`${className}\` on its own is the class, not one made from it, ` +
        `so it has no \`${asked}\`.`,
      howToFix: [
        `\`${className}(...)\` makes one, with a value for each field ` +
          `(${listNames(fields)}).`,
        "A field belongs to the value, not to the class it was made from.",
      ],
    };
  },
};

/** `'ITunesSong' object is not subscriptable` */
const notSubscriptable: Rule = {
  types: ["TypeError"],
  pattern: /^'([\w.]+)' object is not subscriptable/,
  explain: (m, ctx) => {
    const type = m[1];
    if (lastSegment(type) === "NoneType") {
      const none = whyNone(ctx, subscriptReceiver(ctx.offendingLine));
      return {
        headline: `${none.subject}, so square brackets cannot get anything out of it.`,
        howToFix: none.howToFix,
      };
    }
    const fields = fieldsOf(ctx.source, lastSegment(type));
    if (fields === null) {
      return {
        headline: `Square brackets do not work on a ${friendly(type)}.`,
        howToFix: ["Square brackets are for lists, dictionaries and table rows."],
      };
    }
    // Their own subscript, turned round: `s["year"]` becomes `s.year`.
    const subscript = /([A-Za-z_][\w.]*)\s*\[\s*["'](\w+)["']\s*\]/.exec(ctx.offendingLine ?? "");
    const holder = subscript !== null ? subscript[1] : "value";
    const field = subscript !== null ? subscript[2] : fields[0];
    return {
      headline: `Square brackets do not get a field out of \`${lastSegment(type)}\`.`,
      howToFix: [
        `Use a dot instead: \`${holder}.${field}\` rather than \`${holder}["${field}"]\`.`,
        "Square brackets are for lists, dictionaries and table rows.",
      ],
    };
  },
};

/** `'int' object is not iterable`, almost always `for x in len(xs)`. */
const notIterable: Rule = {
  types: ["TypeError"],
  pattern: /^'([\w.]+)' object is not iterable/,
  explain: (m, ctx) => {
    const over = /\bfor\s+\w+\s+in\s+len\s*\(\s*([A-Za-z_][\w.]*)\s*\)/.exec(
      ctx.offendingLine ?? "",
    );
    if (over !== null) {
      return {
        headline: `\`len(${over[1]})\` is a number, and a number is not something to loop over.`,
        howToFix: [
          `To visit each item, write \`for item in ${over[1]}:\`.`,
          `To count, write \`for i in range(len(${over[1]})):\` - but the first form is usually what you want.`,
        ],
      };
    }
    if (lastSegment(m[1]) === "NoneType") {
      const none = whyNone(ctx, loopedOver(ctx.offendingLine));
      return { headline: `${none.subject}, so there is nothing to loop over.`, howToFix: none.howToFix };
    }
    return {
      headline: `A ${friendly(m[1])} is not something to loop over.`,
      howToFix: ["`for` needs a list, a string, a range or something else with items in it."],
    };
  },
};

/**
 * `can only concatenate str (not "int") to str`, and the same for lists
 * and tuples: `can only concatenate list (not "str") to list`.
 *
 * The advice depends entirely on which: for a string the question is which
 * side to convert, and for a list it is almost always one item that
 * belongs in brackets.
 */
const concatMismatch: Rule = {
  types: ["TypeError"],
  pattern: /can only concatenate (str|list|tuple) \(not "([\w.]+)"\) to \1/,
  explain: (m, ctx) => {
    const [, container, other] = m;
    const headline =
      `A ${friendly(container)} and a ${friendly(other)} cannot be added together.`;
    if (container === "str") {
      // Built from the line when its two operands can be read: a string
      // literal on one side of the `+` and an expression on the other.
      const line = ctx.offendingLine ?? "";
      const pair = concatOperands(line);
      const howToFix: string[] = [];
      if (pair !== null) {
        const { text, value, textFirst } = pair;
        howToFix.push(
          `To join them as text, convert \`${value}\` with \`str\`: ` +
            `\`${textFirst ? `${text} + str(${value})` : `str(${value}) + ${text}`}\`.`,
        );
        if (/^\s*print\s*\(/.test(line)) {
          const spaced = withoutJoiningSpace(text, textFirst);
          howToFix.push(
            "In `print`, a comma needs no conversion at all, and puts a space in for you: " +
              `\`print(${textFirst ? `${spaced}, ${value}` : `${value}, ${spaced}`})\`.`,
          );
        }
      } else {
        // `age + 1` where `age = input(...)`: the text is a number someone
        // typed, and adding to it is the point - so converting it comes
        // first, and joining as text is not the advice at all.
        const typed = typedOperand(line, ctx.source);
        if (typed !== null) {
          return {
            headline,
            howToFix: [
              `\`${typed.name}\` came from \`input\`, which always gives back text - even when a number is typed.`,
              `Convert it first: \`${typed.fixed}\`.`,
            ],
          };
        }
        howToFix.push(
          "To join them as text, convert the other value with `str(...)`.",
          "In `print`, separate them with commas instead, which needs no conversion.",
        );
      }
      howToFix.push("To add them as numbers instead, convert the text with `int(...)` or `float(...)`.");
      return { headline, howToFix };
    }
    // A list (or tuple) and one value: `xs + "!"`. What was meant is nearly
    // always that one value as a new item.
    const operand = /([A-Za-z_][\w.]*)\s*\+/.exec(ctx.offendingLine ?? "");
    const named = operand !== null ? operand[1] : "xs";
    const open = container === "list" ? "[" : "(";
    const close = container === "list" ? "]" : ",)";
    return {
      headline,
      howToFix: [
        `\`+\` joins a ${container} to another ${container}. To add one item, put it inside ${container === "list" ? "brackets" : "a tuple"}: \`${named} + ${open}item${close}\`.`,
        ...(container === "list"
          ? [`Or add it in place with \`${named}.append(item)\`, which changes \`${named}\` and returns nothing.`]
          : []),
      ],
    };
  },
};

/** `unsupported operand type(s) for +: 'NoneType' and 'int'` */
const operandMismatch: Rule = {
  types: ["TypeError"],
  pattern: /^unsupported operand type\(s\) for (\S+?): '([\w.]+)' and '([\w.]+)'/,
  explain: (m, ctx) => {
    const [, operator, left, right] = m;
    if (left !== "NoneType" && right !== "NoneType") {
      return {
        headline: `\`${operator}\` does not work between a ${friendly(left)} and a ${friendly(right)}.`,
        howToFix:
          (left === "str") !== (right === "str")
            ? ["Convert one of them first - `int(...)` for a number, `str(...)` for text."]
            : [],
      };
    }
    // The usual cause: a function that changes something rather than
    // returning it, used as though it returned.
    const side = left === "NoneType" ? "left" : "right";
    const none = whyNone(ctx, operandBeside(ctx.offendingLine, operator, side), "One of these values is `None`");
    return { headline: `${none.subject}, so \`${operator}\` cannot be used on it.`, howToFix: none.howToFix };
  },
};

/**
 * `filter("riders" < 1000)` - a condition where a function belongs.
 *
 * The comparison is worked out before `filter` is reached, so what Python
 * reports is the comparison - accurately, and beside the point. The real
 * mistake is that `filter` was given a condition: it calls a function on
 * each row, and the condition has to be that function's body.
 */
const COMPARISONS = new Set(["<", ">", "<=", ">=", "==", "!="]);

const conditionNotFunction: Rule = {
  types: ["TypeError"],
  pattern: /not supported between instances of|unsupported operand type/,
  explain: (_m, ctx) => {
    if (ctx.offendingLine === null) {
      return null;
    }
    const line = ctx.offendingLine;
    const tokens = tokenize(line);
    for (let i = 0; i < tokens.length; i++) {
      const taker = FUNCTION_TAKERS[tokens[i].text];
      if (taker?.each === undefined || tokens[i].kind !== "name" || tokens[i + 1]?.text !== "(") {
        continue;
      }
      const shut = closing(tokens, i + 1);
      if (shut < 0) continue;
      const inside = tokens.slice(i + 2, shut);
      // A comparison at the argument's own level, and no `lambda` - which
      // would make it a function after all.
      let depth = 0;
      let compares = false;
      let isFunction = false;
      for (const token of inside) {
        if (token.kind === "open") depth++;
        if (token.kind === "close") depth--;
        if (depth === 0 && COMPARISONS.has(token.text)) compares = true;
        // Anywhere in the argument, not just before the comparison: the
        // comparison inside `lambda r: r["riders"] < 1000` is its body.
        if (token.text === "lambda") isFunction = true;
      }
      if (!compares || isFunction) continue;

      const name = tokens[i].text;
      const receiver = tokens[i - 1]?.text === "." ? (tokens[i - 2]?.text ?? null) : null;
      // A column name compared directly - `"riders" < 1000` - is the text,
      // not the column; inside the function it is `r["riders"]`.
      let condition = "";
      let named: string | null = null;
      let cursor = tokens[i + 2]?.start ?? 0;
      for (let k = 0; k < inside.length; k++) {
        const token = inside[k];
        const nextOp = inside[k + 1]?.text;
        const prevOp = inside[k - 1]?.text;
        condition += line.slice(cursor, token.start);
        if (
          token.kind === "str" &&
          name !== "transform_column" &&
          (COMPARISONS.has(nextOp ?? "") || COMPARISONS.has(prevOp ?? ""))
        ) {
          condition += `r[${token.text}]`;
          named = named ?? token.text;
        } else {
          condition += token.text;
        }
        cursor = token.end;
      }
      condition = condition.trim();
      const call = receiver !== null ? `${receiver}.${name}(keep)` : `${name}(keep)`;
      return {
        headline: `\`${name}\` needs a function, but this gives it a condition.`,
        howToFix: [
          `\`${name}\` calls a function on ${taker.each} and ${taker.keeps}, so the condition belongs inside a function. ` +
            "Here it was worked out first - which is what the error is about.",
          `Write \`def keep(${taker.param}) -> bool:\` with \`return ${condition}\` as its body, then \`${call}\`.`,
          ...(named !== null
            ? [
                `On its own, \`${named}\` is just text. The value in that column of a row is \`r[${named}]\`.`,
              ]
            : []),
        ],
      };
    }
    return null;
  },
};

/**
 * `'<' not supported between instances of 'str' and 'int'`
 *
 * The advice has to come from the types in hand. A fixed example
 * (`int("999")`, `str(1000)`) was shown whatever the program compared, and
 * the line about CSV columns appeared in files with no table in them.
 */
const comparisonMismatch: Rule = {
  types: ["TypeError"],
  pattern: /^'(\S+)' not supported between instances of '([\w.]+)' and '([\w.]+)'/,
  explain: (m, ctx) => {
    const [, operator, left, right] = m;
    const howToFix: string[] = [];
    const text = left === "str" ? left : right === "str" ? right : null;
    const number = numericType(left) ?? numericType(right);
    if (text !== null && number !== null) {
      // The one case with an actual choice to offer: which side to convert.
      howToFix.push(
        `Convert the text to a number with \`${number}(...)\`, or the number to text with \`str(...)\` - whichever this comparison is meant to be about.`,
      );
      if (readsData(ctx.source)) {
        // Only where the file reads data. Every column of a CSV is text, and
        // that is overwhelmingly why these two types meet - but saying so in
        // a file with no table sends the student looking for one.
        howToFix.push(
          `Every column read from a CSV is text, so a column of numbers needs \`transform_column(name, ${number})\` before it can be compared.`,
        );
      }
    } else {
      howToFix.push(
        `\`${operator}\` only orders values of the same kind; there is no answer to this comparison.`,
      );
    }
    return {
      headline: `\`${operator}\` cannot compare a ${friendly(left)} with a ${friendly(right)}.`,
      howToFix,
    };
  },
};

/** Whether this level refuses to let a name be set twice at module scope. */
/** `int` or `float`, when `type` is one of them. */
function numericType(type: string): string | null {
  const name = lastSegment(type);
  return name === "int" || name === "float" ? name : null;
}

/** Whether the error happened at module scope or inside a function. */
function scopeOf(frames: ErrorFrame[]): "module" | "function" {
  const innermost = frames.filter((frame) => frame.user).at(-1);
  return innermost?.functionName ? "function" : "module";
}

/** Whether this file reads data, so advice about CSV columns can apply. */
function readsData(source: string): boolean {
  return /\bload_table\s*\(|\bread_csv\s*\(/.test(source);
}

/**
 * `invalid literal for int() with base 10: 'nineteen'`
 *
 * Where the text came from decides what to say about it. A CSV's blank
 * cell, `input()` with nothing typed, and a word typed for a number are
 * different mistakes, and the bullet about CSV cells used to appear in
 * programs that only read `input()`.
 */
const badIntLiteral: Rule = {
  types: ["ValueError"],
  pattern: /^invalid literal for int\(\) with base 10: (.+)$/,
  explain: (m, ctx) => {
    const raw = m[1].trim();
    const empty = raw === "''" || raw === '""';
    // Python prints the repr, `'nineteen'`; the course writes `"nineteen"`.
    const shown = /^'[^'"]*'$/.test(raw) ? `"${raw.slice(1, -1)}"` : raw;
    const howToFix = ['`int` only reads whole numbers written in digits, like `"19"`.'];
    if (/\binput\s*\(/.test(ctx.offendingLine ?? "")) {
      howToFix.push(
        empty
          ? "Nothing was typed: pressing Enter on its own makes `input` give back an empty string."
          : "`input` gives back exactly what was typed, as text, so a word cannot become a number.",
      );
    } else if (readsData(ctx.source)) {
      howToFix.push(
        empty
          ? "This one is empty - a blank cell in a CSV arrives as an empty string, so check for it before converting."
          : "A blank cell from a CSV is not a number either; check for it before converting.",
      );
    }
    return {
      headline: empty
        ? "`int` cannot turn an empty string into a whole number."
        : `\`int\` cannot turn ${shown} into a whole number.`,
      howToFix,
    };
  },
};

/** `list index out of range` */
const indexRange: Rule = {
  types: ["IndexError"],
  pattern: /index out of range/,
  explain: (_m, ctx) => {
    const subscript = /([A-Za-z_][\w.]*)\s*\[\s*([^\]]+?)\s*\]/.exec(ctx.offendingLine ?? "");
    const named = subscript !== null ? `\`${subscript[1]}\`` : "This list";
    // Python read the real length from the frame; a made-up "list of 3"
    // read as a claim about theirs.
    const { sequence, length } = ctx.facts;
    if (sequence !== undefined && length !== undefined) {
      return {
        headline: `\`${sequence}\` has no item at that position.`,
        howToFix: [
          length === 0
            ? `\`${sequence}\` is empty, so it has no items at all.`
            : `\`${sequence}\` has ${length} item${length === 1 ? "" : "s"}, numbered 0 to ${length - 1} - positions start at 0.`,
        ],
      };
    }
    return {
      headline: `${named} has no item at that position.`,
      howToFix: [
        "Positions start at 0, so the last item of a list is at position `len(...) - 1`.",
        subscript !== null
          ? `\`len(${subscript[1]})\` gives the number of items.`
          : "`len(...)` gives the number of items.",
      ],
    };
  },
};

/** `'int' object is not callable`, usually a missing `*`. */
const notCallable: Rule = {
  types: ["TypeError"],
  pattern: /^'([\w.]+)' object is not callable/,
  explain: (m, ctx) => {
    if (m[1] === "types.UnionType") {
      // `types.UnionType` is an implementation name for `Boa | Armadillo`.
      const called = callOn(ctx.offendingLine);
      const members = called !== null ? unionMembersOf(ctx.source, called) : null;
      return {
        headline:
          called !== null
            ? `\`${called}\` is a union of several types, not something to make one of.`
            : "This is a union of several types, not something to make one of.",
        howToFix:
          members !== null
            ? [`Make one of ${listNames(members)} instead, like \`${members[0]}(...)\`.`]
            : ["Make one of the types the union is built from."],
      };
    }
    // `3(width)` - a number followed by brackets is nearly always a missing
    // `*`. Python's own "perhaps you missed a comma?" points elsewhere.
    const juxtaposed = /(\d+(?:\.\d+)?)\s*\(([^()]*)\)/.exec(ctx.offendingLine ?? "");
    const numeric = lastSegment(m[1]) === "int" || lastSegment(m[1]) === "float";
    if (juxtaposed !== null && numeric) {
      const [written, number, inside] = juxtaposed;
      return {
        headline: `Brackets after \`${number}\` look like a function call, not multiplication.`,
        howToFix: [
          `To multiply, write the \`*\`: \`${number} * ${inside.trim() || "..."}\`, not \`${written}\`.`,
        ],
      };
    }
    return {
      headline: `A ${friendly(m[1])} cannot be called like a function.`,
      howToFix: ["Brackets after a value mean a call; check whether a `*` or a comma is missing."],
    };
  },
};

/**
 * `reactor's \`to_draw\` has to be a function` - a handler called rather
 * than named.
 *
 * Python cannot say which function it was: `to_draw=draw_dog(0)` has
 * already run `draw_dog` and handed over its picture. The student's line
 * still says, so the fix is written with their own name and call.
 */
const handlerCalled: Rule = {
  types: ["ValueError"],
  pattern: /^reactor's `(\w+)` has to be a function/,
  explain: (m, ctx) => {
    if (ctx.offendingLine === null) {
      return null;
    }
    const handler = m[1];
    const line = ctx.offendingLine;
    const tokens = tokenize(line);
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].text !== handler || tokens[i + 1]?.text !== "=") continue;
      const called = operandFrom(line, tokens, i + 2);
      const fn = tokens[i + 2]?.kind === "name" ? tokens[i + 2].text : null;
      if (called === null || fn === null || called === fn) continue;
      return {
        headline: `\`${handler}\` has to be given the function itself, not what calling it gives back.`,
        howToFix: [
          `Write \`${handler}=${fn}\`, not \`${handler}=${called}\`.`,
          `The reactor calls \`${fn}\` itself, with its state, every time it needs a picture.`,
        ],
      };
    }
    return null;
  },
};

/** `Boa() accepts 2 positional sub-patterns (3 given)` */
const patternArity: Rule = {
  types: ["TypeError"],
  pattern: /^(\w+)\(\) accepts (\d+) positional sub-patterns \((\d+) given\)/,
  explain: (m, ctx) => {
    const [, className, accepts, given] = m;
    const fields = fieldsOf(ctx.source, className);
    return {
      headline:
        `\`${className}\` has ${plural(Number(accepts), "field")}` +
        (fields !== null ? ` (${listNames(fields)})` : "") +
        `, but this pattern names ${given}.`,
      howToFix:
        fields !== null
          ? [`Write one name for each field: \`case ${className}(${fields.join(", ")}):\`.`]
          : ["Write one name for each field, in order."],
    };
  },
};

/**
 * `list indices must be integers or slices, not tuple`
 *
 * Two lists written next to each other with no comma between them -
 * `[["Jan", 1] ["Feb", 2]]` - which Python reads as looking something up
 * in the first one. It also warns about it at compile time, four times
 * over, with "perhaps you missed a comma?" pointing at the wrong place.
 */
const missingComma: Rule = {
  types: ["TypeError"],
  pattern: /list indices must be integers or slices, not tuple/,
  explain: () => {
    return {
      headline: "A comma is missing between two values in a list.",
      howToFix: [
        "`[a, b] [c, d]` with no comma reads as looking `c, d` up inside the first list.",
        "Write `[[a, b], [c, d]]`, with a comma after every row.",
      ],
    };
  },
};

/** `maximum recursion depth exceeded` */
const recursionDepth: Rule = {
  types: ["RecursionError"],
  pattern: /maximum recursion depth/,
  explain: (_m, ctx) => {
    // The repeated frame is the function that never got smaller, and it is
    // repeated hundreds of times.
    const repeated = repeatedFunction(ctx.frames);
    const named = repeated !== null ? `\`${repeated}\`` : "A function";
    return {
      headline: `${named} kept calling itself and never stopped.`,
      howToFix: [
        "Each call has to work on something smaller - the rest of the list, a smaller number.",
        "Check that there is a case that returns without calling again, and that it is reached.",
      ],
    };
  },
};

/** The function that fills a recursion's frames, if one does. */
function repeatedFunction(frames: ErrorFrame[]): string | null {
  const counts = new Map<string, number>();
  for (const { functionName } of frames) {
    if (functionName !== null) counts.set(functionName, (counts.get(functionName) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return bestCount >= 3 ? best : null;
}

/**
 * A column that a discarded `add_column` would have made.
 *
 * `add_column` returns a new table and leaves the original alone, so
 * `employees.add_column(...)` on a line of its own changes nothing. The
 * error then arrives several lines later, about a column that is missing
 * for a reason nothing on that line explains.
 *
 * Only `add_column`, and only from some *other* line. `order_by("rider")`
 * is a method whose result is often discarded too, but discarding it can
 * never be why a column is missing - and matching the failing line against
 * itself turned a plain misspelling into a lecture about mutation.
 */
const discardedTableResult: Rule = {
  types: ["KeyError"],
  pattern: /has no column "([^"]+)"/,
  explain: (m, ctx) => {
    const name = m[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const line = new RegExp(
      `^[ \\t]*([A-Za-z_][\\w.]*)\\.add_column[ \\t]*\\([ \\t]*["']${name}["']`,
    );
    const offending = (ctx.offendingLine ?? "").trim();
    for (const candidate of ctx.source.split(/\r?\n/)) {
      const match = line.exec(candidate);
      // The failing line itself is not an explanation of its own failure.
      if (match === null || candidate.trim() === offending) {
        continue;
      }
      const receiver = match[1];
      return {
        headline: `\`add_column\` makes a new table; it does not change \`${receiver}\`.`,
        howToFix: [
          // `t = t.add_column(...)` is the idiomatic fix and is refused where
          // the level lets a name be set only once, so it is only offered
          // where it would actually work.
          levelRefusesReassignment(ctx.level, scopeOf(ctx.frames))
            ? `Keep the result under a new name: \`new_${receiver} = ${receiver}.add_column(...)\`.`
            : `Keep the result: \`${receiver} = ${receiver}.add_column(...)\`.`,
          `Every table method leaves the table it was called on exactly as it was, so \`${m[1]}\` was never added to \`${receiver}\`.`,
        ],
      };
    }
    return null;
  },
};

/** pandas' `All arrays must be of the same length`, for a DataFrame's dict. */
const unevenColumns: Rule = {
  types: ["ValueError"],
  pattern: /All arrays must be of the same length/,
  explain: (_m, ctx) => {
    return {
      headline: "The columns of this DataFrame have different numbers of values.",
      howToFix: [
        "Each list in the dictionary is one column, and every column needs one value for each row - so the lists have to be the same length.",
        ...(/DataFrame\s*\(/.test(ctx.offendingLine ?? "")
          ? ["Count the values in each list on this line; one has more or fewer than the rest."]
          : []),
      ],
    };
  },
};

/** pandas `KeyError: 'ratings'`, raised deep inside pandas' indexing. */
const pandasKeyError: Rule = {
  types: ["KeyError"],
  pattern: /^\s*'[\s\S]*'\s*$/,
  explain: (_m, ctx, message) => {
    // A frame inside the installed library, not merely the word "pandas":
    // `samples/pandas.py` is a real file in this repo, and a plain dict
    // `KeyError` in it was being reported as a missing DataFrame column.
    const insidePandas = ctx.frames.some((frame) =>
      /[/\\]pandas[/\\]core[/\\]|site-packages[/\\]pandas/.test(frame.fileName),
    );
    if (!insidePandas) {
      return null;
    }
    const key = /^'([\s\S]*)'$/.exec(message.trim());
    if (key === null) {
      return null;
    }
    const frame = /([A-Za-z_][\w.]*)\s*\[/.exec(ctx.offendingLine ?? "");
    return {
      headline: `There is no column named \`${key[1]}\`.`,
      howToFix: [
        frame !== null
          ? `\`print(${frame[1]}.columns)\` lists the columns this DataFrame has.`
          : "`.columns` lists the columns a DataFrame has.",
        "Column names are case-sensitive, and spaces count.",
      ],
    };
  },
};

const RULES: Rule[] = [
  conditionNotFunction,
  handlerCalled,
  functionCalledNotPassed,
  missingDataclass,
  dataclassArity,
  tooFewArguments,
  tooManyArguments,
  methodArity,
  attributeOnClass,
  noSuchAttribute,
  notSubscriptable,
  notIterable,
  concatMismatch,
  operandMismatch,
  comparisonMismatch,
  badIntLiteral,
  indexRange,
  notCallable,
  patternArity,
  missingComma,
  recursionDepth,
  discardedTableResult,
  unevenColumns,
  pandasKeyError,
];
