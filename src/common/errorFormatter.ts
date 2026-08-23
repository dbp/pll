import type { AnalysisFinding } from "./analyzers/types";

/**
 * Plain-text rendering of an analysis finding for VS Code diagnostic tooltips.
 *
 * The interactions view renders findings as structured HTML (see
 * `InteractionsView` + `media/interactionsView/main.js`) so it doesn't
 * use this formatter. Only the squiggle hover text does.
 *
 * Layout:
 *   ErrorType: headline.
 *     at hello.py:2:5
 *
 *   How to fix:
 *     - bullet 1
 *     - bullet 2
 */
export function formatFriendlyError(finding: AnalysisFinding): string[] {
  const lines: string[] = [];
  lines.push(`${finding.errorType}: ${finding.headline}`);

  const location = formatLocation(finding);
  if (location) {
    lines.push(`  at ${location}`);
  }

  if (finding.howToFix.length > 0) {
    lines.push("");
    lines.push("How to fix:");
    for (const item of finding.howToFix) {
      lines.push(`  - ${item}`);
    }
  }
  return lines;
}

/** Newline-joined plain string for `vscode.Diagnostic.message`. */
export function formatFriendlyErrorPlain(finding: AnalysisFinding): string {
  return formatFriendlyError(finding).join("\n");
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
