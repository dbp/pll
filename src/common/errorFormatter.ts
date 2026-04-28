import type { AnalysisFinding } from "./analyzers/types";
import { ANSI, color } from "./ansi";

/**
 * Concise, beginner-friendly rendering of an analysis finding.
 *
 * The same content is used in two places so the user sees the same message
 * everywhere:
 *   - REPL terminal (ANSI colored)
 *   - VS Code diagnostic tooltip (plain text, hover squiggle)
 *
 * Layout:
 *   ErrorType: headline.
 *     at hello.py:2
 *
 *   How to fix:
 *     - bullet 1
 *     - bullet 2
 *     - ...
 */
export interface FormatOptions {
  ansi: boolean;
}

export function formatFriendlyError(
  finding: AnalysisFinding,
  options: FormatOptions = { ansi: false },
): string[] {
  const ansi = options.ansi;
  const lines: string[] = [];

  const errType = ansi ? color(finding.errorType, ANSI.bold, ANSI.red) : finding.errorType;
  const headline = ansi ? color(finding.headline, ANSI.bold) : finding.headline;
  lines.push(`${errType}: ${headline}`);

  const location = formatLocation(finding);
  if (location) {
    const text = `  at ${location}`;
    lines.push(ansi ? color(text, ANSI.dim) : text);
  }

  if (finding.howToFix.length > 0) {
    lines.push("");
    lines.push(ansi ? color("How to fix:", ANSI.bold, ANSI.cyan) : "How to fix:");
    for (const item of finding.howToFix) {
      const bullet = ansi ? color("-", ANSI.cyan) : "-";
      lines.push(`  ${bullet} ${item}`);
    }
  }

  return lines;
}

/** Plain string (newline-joined) for diagnostic.message. */
export function formatFriendlyErrorPlain(finding: AnalysisFinding): string {
  return formatFriendlyError(finding, { ansi: false }).join("\n");
}

/** Build "fileName:line[:col]" if we know the location, else null. */
export function formatLocation(finding: AnalysisFinding): string | null {
  if (finding.lineNumber === null) {
    return null;
  }
  // <repl> isn't a real file - location lines just look weird there.
  if (finding.fileName === "<repl>" || finding.fileName === "<input>") {
    return null;
  }
  if (finding.column !== null) {
    return `${finding.fileName}:${finding.lineNumber}:${finding.column + 1}`;
  }
  return `${finding.fileName}:${finding.lineNumber}`;
}
