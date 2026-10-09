/**
 * PLL's wording for the errors Python words badly for a beginner.
 *
 * Each rule reads Python's message and, where it needs more, the student's
 * line and what Python found out about their code: Python says `pen_cost()
 * missing 1 required positional argument: 'message'` without saying that
 * `pen_cost` takes two, and the definition it sends does.
 *
 * Returns null when no rule fits, and the message is then shown as Python
 * wrote it. That is the right default - a confident wrong explanation is
 * worse than a terse right one - so rules match narrowly and give up
 * readily. Several here do nothing but delete Python's internal names
 * (`__init__`, `types.UnionType`, `Table.`), which is worth a rule on its
 * own: those names send a student looking for something they never wrote.
 */
import {
  FUNCTION_TAKER_NAMES,
  FUNCTION_TAKERS,
  HANDLER_KEYWORDS,
  libraryCaller,
  libraryHint,
} from "./libraryFacts";
import type { Definition, ErrorFacts, ErrorFrame } from "./pythonError";
import { plural, typeWords } from "./wording";
import {
  attributeReceiver,
  callOn,
  closestName,
  closing,
  concatOperands,
  listNames,
  loopedOver,
  operandBefore,
  operandBeside,
  operandFrom,
  subscriptReceiver,
  tokenize,
  WRAPPERS,
} from "./sourceFacts";
import type { BeginnerExplanation } from "./types";

/** What the host knows about where the error came from. */
export interface StockContext {
  /** The student's line that raised, when it is known. */
  offendingLine: string | null;
  /** Every frame, outermost first, for rules that care where the error came from. */
  frames: ErrorFrame[];
  /** What Python learned from those frames. */
  facts: ErrorFacts;
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

// -- what Python found the names to be --------------------------------------

function definition(ctx: StockContext, name: string): Definition | undefined {
  return ctx.facts.definitions?.[name];
}

/** A function's parameters - those it requires, or every positional one. */
function parametersOf(ctx: StockContext, name: string, which: "required" | "parameters"): string[] | null {
  const found = definition(ctx, name);
  return found?.kind === "function" ? found[which] : null;
}

function isStudentsClass(ctx: StockContext, name: string): boolean {
  const found = definition(ctx, name);
  return found?.kind === "class" && found.students;
}

/** The fields of one of the student's classes, or null when it has none. */
function fieldsOf(ctx: StockContext, name: string): string[] | null {
  const found = definition(ctx, name);
  return found?.kind === "class" && found.fields.length > 0 ? found.fields : null;
}

function unionMembersOf(ctx: StockContext, name: string): string[] | null {
  const found = definition(ctx, name);
  return found?.kind === "union" && found.members.length > 1 ? found.members : null;
}

/** Why a value is `None`, which is almost never obvious to a beginner. */
const WHY_NONE = [
  "A function with no `return` gives back `None`.",
  "A method that changes something in place - `append`, `sort` - also gives back `None`.",
];

/**
 * A `+` operand that holds what `input()` returned, and the sum with it
 * converted: `age + 1` becomes `int(age) + 1`.
 */
function typedOperand(line: string, facts: ErrorFacts): { name: string; fixed: string } | null {
  const tokens = tokenize(line);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].text !== "+") continue;
    for (const [at, side] of [[i - 1, "left"], [i + 1, "right"]] as const) {
      const token = tokens[at];
      if (token?.kind !== "name" || tokens[at + 1]?.text === "(" || tokens[at - 1]?.text === ".") {
        continue;
      }
      if (facts.assigned?.[token.text]?.call !== "input") {
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
    if (inside !== null && (frames.at(-1)?.parameters ?? []).includes(receiver)) {
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
    const setFrom = ctx.facts.assigned?.[receiver] ?? null;
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

    // Wherever it was defined: the student's file, another of theirs, or
    // PLL's own library.
    const names = parametersOf(ctx, name, "required");
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
    const names = parametersOf(ctx, name, "parameters");
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
    const fields = fieldsOf(ctx, className);
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
    const fields = fieldsOf(ctx, className);
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
 * A method called with too few arguments.
 *
 * Python names the class (`Table.scatter_plot()`), which the student may
 * never have typed - they wrote `movies.scatter_plot(...)`.
 */
const methodArity: Rule = {
  types: ["TypeError"],
  pattern: /^(\w+)\.(\w+)\(\) missing (\d+) required positional argument/,
  explain: (m, ctx, message) => {
    if (m[2] === "__init__") {
      return null;
    }
    const [, owner, method, missingText] = m;
    const missing = Number(missingText);
    const required = parametersOf(ctx, `${owner}.${method}`, "required");
    if (required === null) {
      return { headline: needsMore(method, missing, message), howToFix: [] };
    }
    return {
      headline:
        `\`${method}\` ${takesClause(required, required.length)}, ` +
        `but got ${Math.max(required.length - missing, 0)}.`,
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
    const fields = fieldsOf(ctx, lastSegment(type));
    if (fields === null) {
      // A class of theirs with no fields - the empty end of a recursive
      // type, like `NoInfo` - has nothing to get, so the value needs
      // checking for before its fields are used.
      const name = lastSegment(type);
      if (isStudentsClass(ctx, name)) {
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
    const fields = fieldsOf(ctx, className);
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
    const method = /([A-Za-z_][\w.]*)\.(\w+)\s*\[\s*([^\]]*)\]/.exec(ctx.offendingLine ?? "");
    if (lastSegment(type) === "method" && method !== null) {
      // `people.rows[0]`, `people.row[0]`: a method used as if it were a list.
      const [, holder, name, inside] = method;
      return {
        headline: `\`${holder}.${name}\` is a method, so it is called with round brackets, not indexed with square ones.`,
        howToFix: [
          name === "row"
            ? `Write \`${holder}.row(${inside})\`: the row number goes in the round brackets.`
            : `Call it first: \`${holder}.${name}()[${inside}]\`.`,
        ],
      };
    }
    const fields = fieldsOf(ctx, lastSegment(type));
    if (fields === null) {
      // `r["age"]` in a function `transform_column` calls: it is given one
      // value of the column, not the row.
      const caller = libraryCaller(ctx.frames);
      const taker = caller !== null ? FUNCTION_TAKERS[caller] : undefined;
      return {
        headline: `Square brackets do not work on a ${friendly(type)}.`,
        howToFix: [
          ...(caller === "transform_column" && taker !== undefined
            ? [`${taker.calls}, so what your function is given is already the value - there is nothing to take out of it.`]
            : []),
          "Square brackets are for lists, dictionaries and table rows.",
        ],
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
    const looped = loopedOver(ctx.offendingLine);
    if (lastSegment(m[1]) === "method" && looped !== null && /\.\w+$/.test(looped)) {
      // `for p in people.rows:` - the method itself, not the rows it gives.
      return {
        headline: `\`${looped}\` is the method itself, not what it gives back - it has not been called.`,
        howToFix: [`Call it, with brackets: \`for ... in ${looped}():\`.`],
      };
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
        const typed = typedOperand(line, ctx.facts);
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
 * The advice has to come from the types in hand: a fixed example such as
 * `int("999")` would fit only some of the comparisons it is shown for.
 */
const comparisonMismatch: Rule = {
  types: ["TypeError"],
  pattern: /^'(\S+)' not supported between instances of '([\w.]+)' and '([\w.]+)'/,
  explain: (m) => {
    const [, operator, left, right] = m;
    const howToFix: string[] = [];
    const text = left === "str" ? left : right === "str" ? right : null;
    const number = numericType(left) ?? numericType(right);
    if (text !== null && number !== null) {
      // The one case with an actual choice to offer: which side to convert.
      howToFix.push(
        `Convert the text to a number with \`${number}(...)\`, or the number to text with \`str(...)\` - whichever this comparison is meant to be about.`,
      );
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

/** `int` or `float`, when `type` is one of them. */
function numericType(type: string): string | null {
  const name = lastSegment(type);
  return name === "int" || name === "float" ? name : null;
}

/**
 * `invalid literal for int() with base 10: 'nineteen'`
 *
 * `input()` with nothing typed and a word typed for a number are different
 * mistakes, and when the text came from `input` on this line, the line says
 * so.
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
      const members = called !== null ? unionMembersOf(ctx, called) : null;
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
    const fields = fieldsOf(ctx, className);
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
    // `KeyError` in it is not a missing DataFrame column.
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

/**
 * `No module named 'flask'`, said as why: PLL's Python is Pyodide's, whose
 * packages are downloaded before a program runs, from the imports PLL can
 * read in it.
 */
const missingModule: Rule = {
  types: ["ModuleNotFoundError"],
  pattern: /^No module named/,
  explain: (_m, ctx) => {
    const module = ctx.facts.module;
    if (module === undefined) {
      return null;
    }
    const name = module.name;
    switch (module.kind) {
      case "leftOut":
        return {
          headline: `\`${name}.py\` is next to your program, but it was not loaded: ${module.why}.`,
          howToFix: ["A file that was not loaded cannot be imported."],
        };
      case "notLoaded":
        return {
          headline: `\`${name}\` could not be loaded before your program ran.`,
          howToFix: [
            `PLL downloads \`${module.package}\` the first time a program imports it, so this needs the internet once; after that it is kept.`,
            "Check the connection, and run the program again.",
          ],
        };
      case "notSeen":
        return {
          headline: `\`${name}\` was not loaded, because PLL did not see it imported.`,
          howToFix: [
            `PLL loads a package before the program runs, from its \`import\` lines - and this import is made another way, with a name worked out as it runs.`,
            `Add \`import ${name}\` near the top of the file.`,
          ],
        };
      case "missing":
        if (module.close !== null) {
          return {
            headline: `There is no module called \`${name}\` - and no file \`${name}.py\` next to your program.`,
            howToFix: [`Did you mean \`${module.close}\`, for \`${module.close}.py\`?`],
          };
        }
        return {
          headline: `There is no module called \`${name}\` here.`,
          howToFix: [
            `PLL runs Python with Pyodide, which has many packages - numpy, pandas, matplotlib, requests and more - but not \`${name}\`.`,
            `If \`${name}\` is a file of your own, put \`${name}.py\` next to your program.`,
          ],
        };
    }
  },
};

/**
 * `sum(people, "age")`: Python's own `sum`, `min` or `max` given a table
 * and a column. A table does that itself.
 */
const builtinOnTable: Rule = {
  types: ["TypeError"],
  pattern: /Table|^a table /,
  explain: (_m, ctx) => {
    const call = /\b(sum|min|max|len|sorted)\s*\(\s*([A-Za-z_][\w.]*)\s*,\s*("[^"]*"|'[^']*')\s*\)/.exec(
      ctx.offendingLine ?? "",
    );
    if (call === null) {
      return null;
    }
    const [, fn, table, column] = call;
    const method = fn === "len" ? "length" : fn === "sorted" ? "order_by" : fn;
    return {
      headline: `\`${fn}(${table}, ${column})\` is Python's own \`${fn}\`, which knows nothing of tables.`,
      howToFix: [`A table does this itself: \`${table}.${method}(${method === "length" ? "" : column})\`.`],
    };
  },
};

const RULES: Rule[] = [
  missingModule,
  builtinOnTable,
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
  unevenColumns,
  pandasKeyError,
];
