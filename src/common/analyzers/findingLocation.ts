import type { AnalysisFinding } from "./types";

/**
 * Where a finding points, in the form every renderer needs: the structured
 * position plus the `file:line[:col]` label shown to the user.
 *
 * `line` and `column` keep the finding's own conventions, while `label`
 * displays the column 1-based the way editors number it.
 */
export interface FindingLocation {
  fileName: string;
  /** 1-based. */
  line: number;
  /** 0-based, or null when unknown. */
  column: number | null;
  /** Display form, e.g. "hello.py:2:5". */
  label: string;
}

/**
 * A finding as the views render it: the interactions panel, a test row, the
 * command line. Plain data, so it crosses into the webview as it is.
 */
export interface SerializedFinding {
  errorType: string;
  headline: string;
  howToFix: string[];
  location: FindingLocation | null;
}

export function serializeFinding(finding: AnalysisFinding): SerializedFinding {
  return {
    errorType: finding.errorType,
    headline: finding.headline,
    howToFix: [...finding.howToFix],
    location: findingLocation(finding),
  };
}

/**
 * The finding's location, or null when there is none worth showing.
 *
 * Null for a finding with no line, and for prompt input: `<repl>` and
 * `<input>` are not real files, so a location reads as noise there.
 *
 * Both renderers go through this - the diagnostic tooltip via
 * `errorFormatter` and the interactions view via `serializeFinding` - so the
 * suppression rule and the label format are decided in exactly one place.
 */
export function findingLocation(finding: AnalysisFinding): FindingLocation | null {
  if (finding.lineNumber === null) {
    return null;
  }
  if (finding.fileName === "<repl>" || finding.fileName === "<input>") {
    return null;
  }
  // Positions from Python are numbers or null by the time they get here:
  // `pythonErrorFrom` and `enrichStaticFindings` see to it.
  const column = finding.column;
  const label =
    column !== null
      ? `${finding.fileName}:${finding.lineNumber}:${column + 1}`
      : `${finding.fileName}:${finding.lineNumber}`;
  return {
    fileName: finding.fileName,
    line: finding.lineNumber,
    column,
    label,
  };
}
