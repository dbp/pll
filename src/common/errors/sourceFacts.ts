/**
 * Small facts read back out of the student's own source.
 *
 * Python's stock messages name a function or a class but not its shape:
 * `pen_cost() missing 1 required positional argument: 'message'` does not
 * say that `pen_cost` takes two, or what the other one is called. The file
 * does, and the host has it, so these read it rather than asking the
 * interpreter - which by the time the error surfaces has moved on.
 *
 * Deliberately textual, not a parse. These answer "what did the student
 * write on the `def` line", and a regex is honest about that; anything it
 * cannot read returns null and the caller falls back to Python's wording.
 */

/** Parameter names of `def name(...)`, with `self` and annotations dropped. */
export function parametersOf(source: string, name: string): string[] | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^[ \\t]*def[ \\t]+${escaped}[ \\t]*\\(([^)]*)\\)`, "m").exec(source);
  if (match === null) {
    return null;
  }
  return splitParameters(match[1]);
}

/**
 * The annotation written for one parameter of `def name(...)`.
 *
 * `parametersOf` throws annotations away on purpose - it answers "how many
 * arguments" - but a `match` that fits no case needs the type to work out
 * which variant has no `case`.
 */
export function annotationOf(
  source: string,
  name: string,
  parameter: string,
): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^[ \\t]*def[ \\t]+${escaped}[ \\t]*\\(([^)]*)\\)`, "m").exec(source);
  if (match === null) {
    return null;
  }
  for (const part of match[1].split(",")) {
    const annotated = /^\s*([A-Za-z_]\w*)\s*:\s*([^=]+?)\s*$/.exec(part);
    if (annotated !== null && annotated[1] === parameter) {
      return annotated[2];
    }
  }
  return null;
}

/** Field names of a dataclass body, in order. */
export function fieldsOf(source: string, className: string): string[] | null {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = new RegExp(`^([ \\t]*)class[ \\t]+${escaped}\\b.*$`, "m").exec(source);
  if (header === null) {
    return null;
  }
  const lines = source.slice(header.index).split(/\r?\n/).slice(1);
  const fields: string[] = [];
  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    const indent = line.length - line.trimStart().length;
    // Back at or left of the `class` line: the body is over.
    if (indent <= header[1].length) {
      break;
    }
    const field = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*:/.exec(line);
    if (field !== null) {
      fields.push(field[1]);
    }
  }
  return fields.length > 0 ? fields : null;
}

/** One line of a function body, with the line number it came from. */
export interface BodyLine {
  /** 1-based line number in the whole file. */
  line: number;
  /** The line's text, indentation included. */
  text: string;
  /** Columns of leading whitespace, relative to the `def`. */
  indent: number;
}

/**
 * The body of `def name(...)`, by indentation.
 *
 * Blank lines are dropped, so `indent` is always meaningful, and comments
 * are kept - a comment where a `return` should be is itself a fact about
 * what the student wrote.
 */
export function functionBody(source: string, name: string): BodyLine[] | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = new RegExp(`^([ \\t]*)def[ \\t]+${escaped}[ \\t]*\\(`, "m").exec(source);
  if (header === null) {
    return null;
  }
  const lines = source.split(/\r?\n/);
  const start = source.slice(0, header.index).split(/\r?\n/).length;
  const outer = header[1].length;
  const body: BodyLine[] = [];
  for (let i = start; i < lines.length; i++) {
    const text = lines[i];
    if (text.trim().length === 0) {
      continue;
    }
    const indent = text.length - text.trimStart().length;
    if (indent <= outer) {
      break;
    }
    body.push({ line: i + 1, text, indent: indent - outer });
  }
  return body.length > 0 ? body : null;
}

/** What a `match` inside a function looks like, for a `None` that fell out of it. */
export interface MatchFacts {
  /** The expression being matched, as written. */
  subject: string;
  /** Whether reaching the end of the `match` reaches the end of the function. */
  atEndOfFunction: boolean;
  /** `case` patterns that are fixed-length lists of 2 or more, like `[f, r]`. */
  fixedLengthPatterns: string[];
  /** Every `case` pattern, as written. */
  patterns: string[];
  /** Whether any `case` matches a list, so the empty list is worth a mention. */
  hasListPattern: boolean;
}

/**
 * The `match` a function ends with, if it ends with one.
 *
 * A `match` where no `case` fits does not raise: it simply does nothing,
 * and the function then runs off its end and returns `None`. That is the
 * commonest way a recursive function over a union goes wrong, and the
 * message for it - "finished without returning a value" - describes the
 * symptom rather than the cause.
 */
export function trailingMatch(source: string, name: string): MatchFacts | null {
  const body = functionBody(source, name);
  if (body === null) {
    return null;
  }
  // The last `match` at the body's own indentation level.
  const base = Math.min(...body.map((entry) => entry.indent));
  let found = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i].indent === base && /^match\b/.test(body[i].text.trim())) {
      found = i;
    }
  }
  if (found < 0) {
    return null;
  }
  const subject = /^match\s+(.+?)\s*:\s*(?:#.*)?$/.exec(body[found].text.trim());
  if (subject === null) {
    return null;
  }
  // Anything after the match block, at the body's level, would run instead
  // of falling off the end.
  let atEndOfFunction = true;
  const fixedLengthPatterns: string[] = [];
  const patterns: string[] = [];
  let hasListPattern = false;
  for (let i = found + 1; i < body.length; i++) {
    if (body[i].indent <= base) {
      atEndOfFunction = false;
      break;
    }
    const pattern = /^case\s+(.+?)\s*(?:if\s.+?)?:\s*(?:#.*)?$/.exec(body[i].text.trim());
    if (pattern === null) {
      continue;
    }
    patterns.push(pattern[1]);
    const list = /^\[([^\]]*)\]$/.exec(pattern[1]);
    if (list === null) {
      continue;
    }
    hasListPattern = true;
    // A pattern of two or more names with no `*` is the one that silently
    // matches only that exact length. `[]` is the base case and correct.
    const parts = list[1].split(",").map((part) => part.trim()).filter(Boolean);
    if (parts.length >= 2 && !pattern[1].includes("*")) {
      fixedLengthPatterns.push(pattern[1]);
    }
  }
  return {
    subject: subject[1],
    atEndOfFunction,
    fixedLengthPatterns,
    patterns,
    hasListPattern,
  };
}

/**
 * The method a name was last assigned from, when that method returns `None`.
 *
 * `result = result.append(w)` leaves `result` as `None`, and the error then
 * appears at the `return` two lines later with nothing to connect them.
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

export function assignedFromVoidMethod(
  source: string,
  name: string,
): { method: string; line: number } | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `^[ \\t]*${escaped}[ \\t]*=[ \\t]*[A-Za-z_][\\w.]*\\.(\\w+)[ \\t]*\\(`,
    "gm",
  );
  let found: { method: string; line: number } | null = null;
  for (const match of source.matchAll(pattern)) {
    if (!RETURNS_NONE.includes(match[1])) {
      continue;
    }
    found = {
      method: match[1],
      line: source.slice(0, match.index).split(/\r?\n/).length,
    };
  }
  return found;
}

/** The classes a union alias is made of: `Animal = Boa | Armadillo`. */
export function unionMembersOf(source: string, name: string): string[] | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^[ \\t]*${escaped}[ \\t]*(?::[^=]+)?=([^\\n#]+)`, "m").exec(source);
  if (match === null || !match[1].includes("|")) {
    return null;
  }
  const members = match[1]
    .split("|")
    .map((part) => part.trim().replace(/^["']|["']$/g, ""))
    .filter((part) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(part));
  return members.length > 1 ? members : null;
}

function splitParameters(text: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if ("([{".includes(ch)) depth += 1;
    if (")]}".includes(ch)) depth -= 1;
    if (ch === "," && depth === 0) {
      names.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  names.push(current);
  return names
    .map((part) => part.split(/[:=]/)[0].trim().replace(/^\*+/, ""))
    .filter((part) => part.length > 0 && part !== "self");
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
 * Edit distance counting a swap of two neighbours as one mistake.
 *
 * Plain Levenshtein charges two for `yaer` -> `year`, which is enough to
 * push the commonest typo of all past any threshold tight enough to be
 * useful. This is the usual optimal-string-alignment variant.
 */
function editDistance(a: string, b: string): number {
  let twoBack: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        current[j] = Math.min(current[j], twoBack[j - 2] + 1);
      }
    }
    twoBack = previous;
    previous = current;
  }
  return previous[b.length];
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
