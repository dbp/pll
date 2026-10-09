import { FUNCTION_TAKER_NAMES, TABLE_METHODS } from "./libraryFacts";
import type { PythonError } from "./pythonError";
import type { BeginnerExplanation } from "./types";

/**
 * What a student has to write to get a name an import provides.
 *
 * `pd` is the one that matters most: Python's own suggestion for it is
 * `id`, which is a real built-in and completely unrelated.
 */
const IMPORT_FOR: Record<string, string> = {
  dataclass: "from dataclasses import dataclass",
  field: "from dataclasses import field",
  pd: "import pandas as pd",
  pandas: "import pandas",
  np: "import numpy as np",
  numpy: "import numpy",
  math: "import math",
  pytest: "import pytest",
  statistics: "import statistics",
  random: "import random",
  Callable: "from typing import Callable",
  Optional: "from typing import Optional",
  Any: "from typing import Any",
  datetime: "import datetime",
  json: "import json",
  csv: "import csv",
  re: "import re",
};

/**
 * Where `name` is defined, when it is defined after the line that used it.
 *
 * Python runs a file from the top, so a name defined further down does not
 * exist yet - and the advice for a misspelling ("check the spelling") sends
 * the student looking for a mistake that is not there.
 */
function definedLaterAt(
  source: string | undefined,
  name: string,
  usedOn: number | null,
): number | null {
  if (source === undefined || usedOn === null) {
    return null;
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const defined = new RegExp(
    `^[ \\t]*(?:def[ \\t]+${escaped}[ \\t]*\\(|class[ \\t]+${escaped}\\b|${escaped}[ \\t]*(?::[^=]+)?=[^=])`,
  );
  const lines = source.split(/\r?\n/);
  for (let i = usedOn; i < lines.length; i++) {
    if (defined.test(lines[i])) {
      return i + 1;
    }
  }
  return null;
}

/**
 * Whether `name` is used as a type annotation on this line.
 *
 * `rest: NumList` inside the very class the union is built from cannot be
 * fixed by moving anything: `NumList = Empty | Link` needs `Link`, and
 * `Link` needs `NumList`. Python's answer for that is the string form,
 * which it resolves later - so a forward reference in an annotation needs
 * quotes, not reordering. This is the shape of every recursive data
 * definition in the course.
 */
function annotationTarget(line: string | null, name: string): string | null {
  if (line === null) {
    return null;
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A field or variable (`rest: NumList`), or a parameter
  // (`def f(x: NumList)`): both give a name to show the fix with.
  const named =
    new RegExp(`^\\s*([A-Za-z_]\\w*)\\s*:\\s*${escaped}\\b`).exec(line) ??
    new RegExp(`[(,]\\s*([A-Za-z_]\\w*)\\s*:\\s*${escaped}\\b`).exec(line);
  if (named !== null) {
    return named[1];
  }
  // A return type (`-> NumList`) has nothing to name it by.
  return new RegExp(`->\\s*${escaped}\\b`).test(line) ? "" : null;
}

/**
 * The library function on the line that calls the student's function with
 * each row or value, when the undefined name is that function's parameter.
 *
 * `filter(below_1k(r))` calls `below_1k` right there, so `r` has no value;
 * the name that is missing is a symptom of passing the result rather than
 * the function.
 */
function passedResultNotFunction(line: string | null, name: string): string | null {
  if (line === null) {
    return null;
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const taker of FUNCTION_TAKER_NAMES) {
    const pattern = new RegExp(
      `\\b${taker}\\s*\\(\\s*([A-Za-z_]\\w*)\\s*\\(\\s*${escaped}\\s*\\)`,
    );
    const match = pattern.exec(line);
    if (match !== null) {
      return `${taker}:${match[1]}`;
    }
  }
  return null;
}

/**
 * A name with a `-` in it that `name` is half of: Python reads
 * `load-table(...)` as `load` minus `table(...)`. Only a function's name,
 * called: `total-tax` on its own is as likely a subtraction.
 */
function hyphenated(line: string | null, name: string): string | null {
  if (line === null) {
    return null;
  }
  for (const found of line.matchAll(/(?<![.\w])([A-Za-z_]\w*(?:-[A-Za-z_]\w*)+)(?=\s*\()/g)) {
    if (found[1].split("-").includes(name)) {
      return found[1];
    }
  }
  return null;
}

/** `order_by(people, "age")`: a table method called as a function, and on what. */
function methodCalledAsFunction(line: string | null, name: string): { table: string; rest: string } | null {
  if (line === null || !TABLE_METHODS.includes(name)) {
    return null;
  }
  const found = new RegExp(`\\b${name}\\s*\\(\\s*([A-Za-z_][\\w.]*)\\s*(?:,\\s*([^)]*))?\\)`).exec(line);
  return found ? { table: found[1], rest: (found[2] ?? "").trim() } : null;
}

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

/** The file and the line that failed, when the host knows them. */
export interface NameContext {
  source?: string;
  line?: string | null;
}

/**
 * A friendly explanation for a `NameError` or `UnboundLocalError`.
 *
 * The message is the one Python shows - `name 'Totl' is not defined. Did
 * you mean: 'total'?` - so its suggestion is in it, and becomes a "Did you
 * mean" line of its own rather than part of the headline.
 */
export function explainNameError(
  parsed: PythonError,
  context: NameContext = {},
): BeginnerExplanation {
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

  // The name is a function's parameter, used where the function itself
  // belonged: the missing name is a symptom, not the mistake.
  const passed = named ? passedResultNotFunction(context.line ?? null, name) : null;
  if (passed !== null) {
    const [taker, fn] = passed.split(":");
    return {
      headline: `\`${taker}\` calls \`${fn}\` for you, so \`${name}\` is not something you write here.`,
      howToFix: [
        `Pass the function itself: \`${taker}(${fn})\`.`,
        `\`${taker}\` supplies the argument for each row, so \`${fn}\` is never called by hand.`,
      ],
    };
  }

  // A `-` where a name has `_`: `load-table`, `image-width`.
  const hyphen = named ? hyphenated(context.line ?? null, name) : null;
  if (hyphen !== null) {
    return {
      headline: `Python reads \`${hyphen}\` as \`${hyphen.split("-").join("` minus `")}\`: a name cannot have a \`-\` in it.`,
      howToFix: [`Write \`${hyphen.replace(/-/g, "_")}\`, with an underscore.`],
    };
  }

  // A table's method, called as if it were a function of its own.
  const method = named ? methodCalledAsFunction(context.line ?? null, name) : null;
  if (method !== null) {
    return {
      headline: `\`${name}\` is a method of a table, so it is called on one.`,
      howToFix: [`Write \`${method.table}.${name}(${method.rest})\`.`],
    };
  }

  // A name an import provides. Python's own suggestion for `pd` is `id`,
  // which is a real built-in and nothing to do with pandas.
  const importLine = named ? IMPORT_FOR[name] : undefined;
  if (importLine !== undefined) {
    return {
      headline: `\`${name}\` comes from an import, and this file has not imported it.`,
      howToFix: [`Add \`${importLine}\` at the top of the file.`],
    };
  }

  // Defined, but further down. Python runs the file from the top.
  const laterOn = named
    ? definedLaterAt(context.source, name, parsed.lineNumber)
    : null;
  if (laterOn !== null) {
    // In an annotation, moving the definition up is not the fix and is
    // often impossible: a recursive type names itself.
    const annotated = annotationTarget(context.line ?? null, name);
    if (annotated !== null) {
      const example = annotated ? `${annotated}: "${name}"` : `-> "${name}"`;
      return {
        headline:
          `\`${name}\` is defined on line ${laterOn}, after this line, ` +
          "and an annotation is read as the file runs.",
        howToFix: [
          `Write the type as a string - \`${example}\` - and Python looks it up later, once it exists.`,
          "A type that names itself can only be written that way: the union needs the class, and the class needs the union.",
        ],
      };
    }
    return {
      headline: `\`${name}\` is defined on line ${laterOn}, after this line.`,
      howToFix: [
        "Python runs a file from the top, so nothing further down exists yet.",
        `Move the definition of \`${name}\` above this line.`,
      ],
    };
  }

  const headline = `Python doesn't know what \`${name}\` means.`;

  // One suggestion is a question, not "one of those". Differing only in
  // case is the whole story, and a confident match makes the spelling
  // and the quotes bullets beside the point.
  if (didYouMean.length === 1) {
    const [meant] = didYouMean;
    return {
      headline,
      howToFix: [
        meant.toLowerCase() === name.toLowerCase()
          ? `Did you mean \`${meant}\`? Python names are case-sensitive, so \`${name}\` and \`${meant}\` are different names.`
          : `Did you mean \`${meant}\`?`,
      ],
    };
  }

  const howToFix: string[] = [
    `Check the spelling of \`${name}\` (Python is case-sensitive).`,
    `Make sure \`${name}\` is defined before this line runs.`,
  ];
  // Only worth saying when there is a real name to quote; `put "this name"
  // in quotes` is advice about the placeholder rather than about the code.
  if (named) {
    howToFix.push(`If \`${name}\` should be text, put it in quotes: \`\"${name}\"\`.`);
  }

  if (didYouMean.length > 1) {
    howToFix.unshift(
      `Did you mean one of ${didYouMean.map((s) => "`" + s + "`").join(", ")}?`,
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
