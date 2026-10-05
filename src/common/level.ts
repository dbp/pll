import { editDistance } from "./editDistance";

/**
 * Language levels for Python files. The level is opted into with a magic
 * comment on the first non-blank line of the file:
 *
 *   #level raw            -> no checks at all; plain Python plus PLL's
 *                            built-in image / table libraries
 *   #level beginner       -> strictest static checks, and type annotations
 *                            checked as the program runs
 *   #level intermediate   -> same as beginner, except reassignment is
 *                            allowed inside functions so for-loop
 *                            accumulator patterns work
 *   #level advanced       -> no static checks; annotations still checked,
 *                            but by Python's own rules
 *
 * Files with no header are `raw`, so code written without PLL in mind runs
 * exactly as it would under CPython. Every behavioral difference is opted
 * into by naming a level, and the level is the *only* thing that decides
 * what is checked - there is no separate setting that can disagree with it.
 */

export const LEVEL_RAW = "raw";
export const LEVEL_BEGINNER = "beginner";
export const LEVEL_INTERMEDIATE = "intermediate";
export const LEVEL_ADVANCED = "advanced";

/** Every level, in order of strictness relaxing. Python names the same four (`typeChecking.py`). */
export const LEVEL_NAMES = [LEVEL_RAW, LEVEL_BEGINNER, LEVEL_INTERMEDIATE, LEVEL_ADVANCED] as const;

export type Level = (typeof LEVEL_NAMES)[number];

export const DEFAULT_LEVEL: Level = LEVEL_RAW;

/** Whether `name` is a level, exactly as written. */
export function isLevel(name: string): name is Level {
  return (LEVEL_NAMES as ReadonlyArray<string>).includes(name);
}

// Case-sensitive, and exactly one spelling: `#level beginner`. Anything
// else falls back to the default rather than guessing at intent.
const HEADER_RE = /^#\s*level\s+([a-z]+)\s*$/;

/**
 * Parse the level header from the start of a Python source file.
 *
 * Skips leading blank lines so an empty first line doesn't disable level
 * detection. Anything other than a recognised header silently falls back to
 * the default, so a stray comment is never an error.
 */
export function parseLevel(source: string): Level {
  const lines = source.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) {
      continue;
    }
    const match = HEADER_RE.exec(line);
    if (!match) {
      return DEFAULT_LEVEL;
    }
    const name = match[1];
    return isLevel(name) ? name : DEFAULT_LEVEL;
  }
  return DEFAULT_LEVEL;
}

/** What is wrong with a file's `#level` line, and what to say about it. */
export interface LevelHeaderProblem {
  message: string;
  /** 1-based line to blame. */
  line: number;
  howToFix: string[];
}

/**
 * A `#level` line that does not do what the student meant, if there is one.
 *
 * Absence stays silent - a file with no header is `raw`, so ordinary Python
 * runs as ordinary Python, and a stray comment is never an error. What is
 * reported is a line that *asked* for a level and did not get one: the
 * student believes `beginner` is watching and every check they expected has
 * vanished without a word. Three ways that happens:
 *
 *   #level begginer      a name that is not a level
 *   #levelbeginner       the space missed out
 *   # my lab 1           something above it - a comment, or code - so it
 *   #level beginner      is not the first line
 */
export function levelHeaderProblem(source: string): LevelHeaderProblem | null {
  const lines = source.split(/\r?\n/);
  const valid = new RegExp(`^#\\s*level\\s+(?:${LEVEL_NAMES.join("|")})\\s*$`);
  const joined = new RegExp(`^#\\s*level(${LEVEL_NAMES.join("|")})\\s*$`);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) {
      continue;
    }
    // A level name run straight onto the word, with the space missed out.
    // Matched by name rather than by loosening the `\b` below, which would
    // turn an ordinary comment like `#levels of abstraction` into an error.
    const squashed = joined.exec(line);
    if (squashed !== null) {
      return {
        line: i + 1,
        message: `\`#level\` needs a space before \`${squashed[1]}\`: \`#level ${squashed[1]}\`.`,
        howToFix: [`Write it as \`#level ${squashed[1]}\`, with a space.`],
      };
    }
    const attempt = /^#\s*level\b(.*)$/.exec(line);
    if (attempt === null) {
      // Not a header. It may still be a comment with the real header
      // underneath, which is the commonest way to lose a level entirely.
      return misplacedHeader(lines, i, valid);
    }
    if (valid.test(line)) {
      return null;
    }
    const named = attempt[1].trim();
    if (named.length === 0) {
      return {
        line: i + 1,
        message: `\`#level\` needs a level after it: ${levelList()}.`,
        howToFix: [`Name one of ${levelList()}, or leave the line out.`],
      };
    }
    const suggestion = closestLevel(named);
    return {
      line: i + 1,
      message:
        `\`${named}\` is not a level` +
        (suggestion ? `. Did you mean \`${suggestion}\`?` : `. The levels are ${levelList()}.`),
      howToFix: suggestion
        ? [`Write \`#level ${suggestion}\` on the first line, in lower case.`]
        : [`Name one of ${levelList()}, or leave the line out.`],
    };
  }
  return null;
}

/**
 * A valid header sitting below the top of the file, where it does nothing -
 * under a comment, or under code. Only a line that is a comment counts: a
 * `#level` line inside a docstring is text, and inventing an error out of a
 * string would be worse than missing a header.
 */
function misplacedHeader(
  lines: string[],
  from: number,
  valid: RegExp,
): LevelHeaderProblem | null {
  const comments = commentLines(lines);
  let underCode = false;
  for (let i = from; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) {
      continue;
    }
    if (!comments[i]) {
      underCode = true;
      continue;
    }
    if (valid.test(line)) {
      return {
        line: i + 1,
        message: `\`${line}\` only counts on the first line, so none of its checks ran.`,
        howToFix: [
          underCode
            ? "Move it to the very first line of the file, above the code."
            : "Move it to the very top of the file, above the comments.",
          "Leave the line out altogether to run the file as ordinary Python.",
        ],
      };
    }
  }
  return null;
}

/**
 * Which lines are comments: a `#` first on the line, outside any string.
 * The tokenizer that knows for certain is Python's, in the worker; this
 * only has to tell a comment from a line of a triple-quoted string, the
 * one place a line can begin with `#` and not be one.
 */
function commentLines(lines: string[]): boolean[] {
  const comments: boolean[] = [];
  // The quotes of a triple-quoted string still open: `"""` or `'''`.
  let open: string | null = null;
  for (const line of lines) {
    comments.push(open === null && line.trimStart().startsWith("#"));
    let i = 0;
    while (i < line.length) {
      if (open !== null) {
        const close = closingQuote(line, i, open);
        if (close < 0) break;
        i = close + open.length;
        open = null;
        continue;
      }
      const c = line[i];
      if (c === "#") break;
      if (c === '"' || c === "'") {
        if (line.startsWith(c.repeat(3), i)) {
          open = c.repeat(3);
          i += 3;
          continue;
        }
        const close = closingQuote(line, i + 1, c);
        i = close < 0 ? line.length : close + 1;
        continue;
      }
      i += 1;
    }
  }
  return comments;
}

/** Where `quote` next closes a string in `line`, from `from`, or -1. */
function closingQuote(line: string, from: number, quote: string): number {
  for (let i = from; i < line.length; i++) {
    if (line[i] === "\\") {
      i += 1;
    } else if (line.startsWith(quote, i)) {
      return i;
    }
  }
  return -1;
}

function levelList(): string {
  return LEVEL_NAMES.map((name) => `\`${name}\``).join(", ");
}

/** The level `named` was probably meant to be, by edit distance. */
function closestLevel(named: string): Level | null {
  const lower = named.toLowerCase();
  let best: Level | null = null;
  let bestDistance = Infinity;
  for (const level of LEVEL_NAMES) {
    const distance = editDistance(lower, level);
    if (distance < bestDistance) {
      best = level;
      bestDistance = distance;
    }
  }
  // Close enough to be a misspelling rather than a different word. A third
  // of the name is generous enough for `begginer` and `Beginner` without
  // turning `#level easy` into a guess.
  return best !== null && bestDistance <= Math.max(2, Math.floor(best.length / 3))
    ? best
    : null;
}

/**
 * Whether a `bool` is rejected where `int` / `float` is annotated.
 *
 * Python counts `True` as `1`, and both mypy and typeguard follow it. At
 * the teaching levels that is a hole: a student who annotates `int` and
 * passes `True` has almost always made a real mistake. `advanced` keeps
 * Python's own rule.
 */
export function levelRejectsBoolAsNumber(level: Level): boolean {
  return level === LEVEL_BEGINNER || level === LEVEL_INTERMEDIATE;
}

/**
 * Whether this level refuses a second assignment to a name in `scope`.
 *
 * `beginner` refuses it everywhere; `intermediate` only at module scope, so
 * a function can still keep a running total. `_pll_static_analyze` enforces
 * this; the explanations ask it so they only offer fixes the level accepts.
 */
export function levelRefusesReassignment(level: Level, scope: "module" | "function"): boolean {
  return level === LEVEL_BEGINNER || (level === LEVEL_INTERMEDIATE && scope === "module");
}

/** Whether this level runs any static analyzer checks at all. */
export function levelHasStaticChecks(level: Level): boolean {
  return level === LEVEL_BEGINNER || level === LEVEL_INTERMEDIATE;
}
