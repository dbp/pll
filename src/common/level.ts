/**
 * Language levels for Python files. The level is opted into via a magic
 * comment on the first non-blank line of the file:
 *
 *   #beginner       -> beginner level (strict static checks)
 *   #expert         -> expert level (no static checks)
 *
 * Files with no header default to `expert` so existing code continues to run
 * untouched.
 */

export type Level = "beginner" | "expert";

export const DEFAULT_LEVEL: Level = "expert";

const HEADER_RE = /^#\s*([a-zA-Z]+)\s*$/;

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
    if (name === "beginner") return "beginner";
    if (name === "expert") return "expert";
    return DEFAULT_LEVEL;
  }
  return DEFAULT_LEVEL;
}

/** Human-friendly label for the level (used in REPL banners and messages). */
export function levelLabel(level: Level): string {
  return level;
}
