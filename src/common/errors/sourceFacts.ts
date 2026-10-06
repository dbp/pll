/**
 * What the student's text says, read as text: a line of the file, the
 * expression beside an operator on it, the line a table's row is on.
 *
 * Only what is written, and only where it is written. What a name *is* -
 * a function's parameters, a class's fields - comes from Python, which has
 * the definitions themselves wherever they were written
 * (`ErrorFacts.definitions`). Anything these cannot read returns null and
 * the caller falls back to Python's wording.
 */

import { editDistance } from "../editDistance";

/** Line `line` (1-based) of `source`, or null when it has no such line. */
export function sourceLine(source: string, line: number | null): string | null {
  if (line === null) {
    return null;
  }
  const lines = source.split(/\r?\n/);
  return line >= 1 && line <= lines.length ? lines[line - 1] : null;
}

/**
 * The call on `line` whose result the error is probably about.
 *
 * `print(deposit(acct1, 50) + 1)` has two calls on it and the interesting
 * one is `deposit`: a wrapper like `print` or `str` is almost never what
 * produced the offending value, so it is only named when it is the only
 * call there.
 */
export const WRAPPERS = new Set([
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

export function callOn(line: string | null): string | null {
  const names = Array.from(
    (line ?? "").matchAll(/([A-Za-z_][\w.]*)\s*\(/g),
    (m) => m[1],
  );
  if (names.length === 0) {
    return null;
  }
  return names.find((name) => !WRAPPERS.has(name)) ?? names[0];
}

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
export interface Token {
  kind: "str" | "name" | "num" | "open" | "close" | "op";
  text: string;
  start: number;
  end: number;
}

export function tokenize(line: string): Token[] {
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
export function closing(tokens: Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i].kind === "open") depth++;
    if (tokens[i].kind === "close" && --depth === 0) return i;
  }
  return -1;
}

/** The expression starting at token `at`: a name, its attributes and calls. */
export function operandFrom(line: string, tokens: Token[], at: number): string | null {
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
export function operandBefore(line: string, tokens: Token[], at: number): string | null {
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
export function concatOperands(
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

/** The expression `.attr` is read from on `line`, as written. */
export function attributeReceiver(line: string | null, attr: string): string | null {
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
export function subscriptReceiver(line: string | null): string | null {
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
export function loopedOver(line: string | null): string | null {
  if (line === null) return null;
  const tokens = tokenize(line);
  const at = tokens.findIndex((t) => t.text === "in" && tokens[0]?.text === "for");
  return at < 0 ? null : operandFrom(line, tokens, at + 1);
}

/** The operand on one side of the first `operator` on `line`. */
export function operandBeside(line: string | null, operator: string, side: "left" | "right"): string | null {
  if (line === null) return null;
  const tokens = tokenize(line);
  const at = tokens.findIndex((t) => t.kind === "op" && t.text === operator);
  if (at < 0) return null;
  return side === "left" ? operandBefore(line, tokens, at - 1) : operandFrom(line, tokens, at + 1);
}

/** `a`, `b` and `c` - for listing names in prose. */
export function listNames(names: string[]): string {
  const quoted = names.map((name) => `\`${name}\``);
  if (quoted.length <= 1) {
    return quoted.join("");
  }
  return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

/** The closest of `candidates` to `name`, when one is close enough. */
export function closestName(name: string, candidates: string[]): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = editDistance(name.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  if (best === null) {
    return null;
  }
  // Close enough to be a typo rather than a different word.
  return bestDistance <= Math.max(1, Math.floor(best.length / 3)) ? best : null;
}

/**
 * The line a given row of a `table(columns, [row, row, ...])` call starts on.
 *
 * A table-construction error is raised inside the library, so the
 * student's innermost frame is the `table(` line - and for a table of
 * twenty rows, written one per line, that is not where the bad row is.
 * The error names the row by position, so this walks the call's brackets
 * from `table(` to find that element of the rows list, skipping strings
 * and comments so a `,` or `]` inside one does not count.
 *
 * Only for rows written out in place. Rows passed as a variable have no
 * line of their own here, and this returns null so the `table(` line is
 * kept.
 */
export function tableRowLine(
  source: string,
  callLine: number,
  index: number,
): number | null {
  const lines = source.split(/\r?\n/);
  if (callLine < 1 || callLine > lines.length) {
    return null;
  }
  const call = /\b(?:table|Table)\s*\(/.exec(lines[callLine - 1]);
  if (call === null) {
    return null;
  }
  // Absolute offset of the character just after `table(`.
  let offset = 0;
  for (let i = 0; i < callLine - 1; i++) {
    offset += lines[i].length + 1;
  }
  const text = lines.join("\n");
  let i = offset + call.index + call[0].length;

  let depth = 1; // inside `table(`
  let argument = 0; // 0 = the column names, 1 = the rows
  let row = -1; // which element of the rows list we are in
  let rowsOpen = false;
  let awaitingRow = false;
  const lineAt = (at: number) => text.slice(0, at).split("\n").length;

  while (i < text.length && depth > 0) {
    const c = text[i];
    // Skip a string literal whole, so its contents are not structure.
    if (c === '"' || c === "'") {
      const quote = text.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      i += quote.length;
      while (i < text.length && !text.startsWith(quote, i)) {
        i += text[i] === "\\" ? 2 : 1;
      }
      i += quote.length;
      continue;
    }
    if (c === "#") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    // The first character of a row: record where it starts.
    if (awaitingRow && c !== "]") {
      row++;
      if (row === index) {
        return lineAt(i);
      }
      awaitingRow = false;
    }
    if (c === "(" || c === "[" || c === "{") {
      depth++;
      if (depth === 2 && argument === 1 && c === "[" && !rowsOpen) {
        rowsOpen = true;
        awaitingRow = true;
      }
    } else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (rowsOpen && depth === 1) {
        // The rows list closed without reaching the row.
        return null;
      }
    } else if (c === ",") {
      if (depth === 1) {
        argument++;
        if (argument > 1) return null;
      } else if (depth === 2 && rowsOpen) {
        awaitingRow = true;
      }
    } else if (depth === 1 && argument === 1 && !rowsOpen) {
      // The rows argument is not a list written out here (a variable, a
      // call), so there is no line to point at.
      return null;
    }
    i++;
  }
  return null;
}
