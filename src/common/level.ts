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
