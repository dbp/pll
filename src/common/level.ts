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

export type Level = "raw" | "beginner" | "intermediate" | "advanced";

export const DEFAULT_LEVEL: Level = "raw";

// Case-sensitive, and exactly one spelling: `#level beginner`. Anything
// else falls back to the default rather than guessing at intent.
const HEADER_RE = /^#\s*level\s+([a-z]+)\s*$/;

const LEVEL_NAMES: ReadonlyArray<Level> = [
  "raw",
  "beginner",
  "intermediate",
  "advanced",
];

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
    for (const level of LEVEL_NAMES) {
      if (name === level) return level;
    }
    return DEFAULT_LEVEL;
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
 *   # my lab 1           something above it, so it is not the first line
 *   #level beginner
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
 * A valid header sitting below the top of the file, where it does nothing.
 *
 * Only the opening run of comments is searched. A `#level` line further
 * down could be inside a docstring, and inventing an error out of a string
 * literal would be worse than missing a misplaced header.
 */
function misplacedHeader(
  lines: string[],
  from: number,
  valid: RegExp,
): LevelHeaderProblem | null {
  for (let i = from; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) {
      continue;
    }
    if (!line.startsWith("#")) {
      return null;
    }
    if (valid.test(line)) {
      return {
        line: i + 1,
        message: `\`${line}\` only counts on the first line, so none of its checks ran.`,
        howToFix: [
          "Move it to the very top of the file, above the comments.",
          "Leave the line out altogether to run the file as ordinary Python.",
        ],
      };
    }
  }
  return null;
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

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * Whether annotations are checked while the program runs.
 *
 * On at every level except `raw`, which exists precisely so that a file can
 * opt out. There is deliberately no setting for this: one mechanism, named
 * in the file, rather than two that can contradict each other.
 */
export function levelHasTypeChecking(level: Level): boolean {
  return level !== "raw";
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
  return level === "beginner" || level === "intermediate";
}

/** Whether this level runs any static analyzer checks at all. */
export function levelHasStaticChecks(level: Level): boolean {
  return level === "beginner" || level === "intermediate";
}
