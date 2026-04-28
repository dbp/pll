import type { AnalysisFinding } from "./analyzers/types";
import { ANSI, color } from "./ansi";

const SEPARATOR = color("─".repeat(60), ANSI.dim);

/**
 * Render a beginner-friendly analysis finding as an array of lines suitable
 * for a pseudoterminal. Lines do NOT include trailing line endings - the
 * caller is responsible for joining with CRLF.
 *
 * The plain-text variant strips ANSI codes for use in the OutputChannel /
 * Diagnostic message text, where ANSI escapes don't render.
 */
export function formatFriendlyErrorAnsi(finding: AnalysisFinding): string[] {
  const lines: string[] = [];
  lines.push("");
  lines.push(SEPARATOR);
  lines.push(
    "  " +
      color(finding.errorType, ANSI.bold, ANSI.red) +
      ": " +
      color(finding.headline, ANSI.bold),
  );
  lines.push(SEPARATOR);

  if (finding.lineNumber !== null) {
    const where =
      finding.column !== null
        ? `line ${finding.lineNumber}, column ${finding.column + 1}`
        : `line ${finding.lineNumber}`;
    const tokenSuffix = finding.nameToken
      ? ` (` + color(finding.nameToken, ANSI.yellow) + `)`
      : "";
    lines.push("  " + color("at", ANSI.dim) + ` ${where}${tokenSuffix}`);
  }

  pushSection(lines, "What happened", finding.whatHappened);
  pushSection(lines, "Why this might happen", finding.whyItHappens);
  pushSection(lines, "How to fix", finding.howToFix);

  lines.push("");
  lines.push("  " + color("Original Python message:", ANSI.dim));
  for (const raw of finding.raw.split(/\r?\n/)) {
    lines.push("    " + color(raw, ANSI.dim));
  }
  lines.push("");
  return lines;
}

export function formatFriendlyErrorPlain(finding: AnalysisFinding): string[] {
  return formatFriendlyErrorAnsi(finding).map(stripAnsi);
}

function pushSection(out: string[], title: string, items: string[]): void {
  if (items.length === 0) {
    return;
  }
  out.push("");
  out.push("  " + color(title + ":", ANSI.cyan, ANSI.bold));
  for (const item of items) {
    const wrapped = wrapText(item, 76);
    const [first, ...rest] = wrapped;
    out.push("    " + color("•", ANSI.cyan) + ` ${first}`);
    for (const cont of rest) {
      out.push("      " + cont);
    }
  }
}

function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) {
      current = word;
      continue;
    }
    if (visibleLength(current) + 1 + visibleLength(word) > width) {
      lines.push(current);
      current = word;
    } else {
      current += " " + word;
    }
  }
  if (current.length > 0) {
    lines.push(current);
  }
  return lines.length > 0 ? lines : [""];
}

function visibleLength(s: string): number {
  return stripAnsi(s).length;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
