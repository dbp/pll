/**
 * Language levels for Python files. The level is opted into via a magic
 * comment on the first non-blank line of the file:
 *
 *   #beginner       -> beginner level (strictest static checks)
 *   #intermediate   -> intermediate level (shadowing checks, no global/nonlocal,
 *                      but reassignment is allowed inside functions so for-loop
 *                      accumulator patterns work)
 *   #advanced       -> advanced level (no static checks; full Python)
 *
 * Files with no header default to `advanced` so existing code continues to
 * run untouched.
 */

export type Level = "beginner" | "intermediate" | "advanced";

export const DEFAULT_LEVEL: Level = "advanced";

const HEADER_RE = /^#\s*([a-zA-Z]+)\s*$/;

const LEVEL_NAMES: ReadonlyArray<Level> = ["beginner", "intermediate", "advanced"];

/**
 * Parse the level header from the start of a Python source file.
 *
 * Skips leading blank lines so a single empty line at the top of the file
 * doesn't disable level detection. Anything other than a recognised header
 * silently falls back to the default.
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
    const name = match[1].toLowerCase();
    for (const level of LEVEL_NAMES) {
      if (name === level) return level;
    }
    return DEFAULT_LEVEL;
  }
  return DEFAULT_LEVEL;
}

/** Human-friendly label for the level (used in REPL banners and messages). */
export function levelLabel(level: Level): string {
  return level;
}

/** Whether this level runs any static analyzer checks at all. */
export function levelHasStaticChecks(level: Level): boolean {
  return level === "beginner" || level === "intermediate";
}
