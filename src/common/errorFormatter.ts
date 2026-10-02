import { findingLocation } from "./analyzers/findingLocation";
import type { AnalysisFinding } from "./analyzers/types";

/**
 * Plain-text rendering of an analysis finding: the squiggle's hover text in
 * the editor, and a finding on the command line.
 *
 * The interactions view renders findings as structured HTML instead (see
 * `appendFinding` in `media/interactionsView/main.js`), from the same
 * `serializeFinding` fields.
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

  const location = findingLocation(finding);
  if (location) {
    lines.push(`  at ${location.label}`);
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
