import { levelHeaderProblem, type Level } from "../level";
import type { AnalysisFinding } from "./types";

/**
 * A broken `#level` line, as a finding that stops the run.
 *
 * It has to stop the run. The whole point of the line is to ask for
 * checks, and a file that asked and silently got none is worse than one
 * that never asked: the student believes `beginner` is watching. So this is
 * reported before anything else, at any level - there is no level to
 * consult, which is exactly the problem.
 */
export function levelHeaderFinding(
  source: string,
  fileName: string,
  level: Level,
): AnalysisFinding | null {
  const problem = levelHeaderProblem(source);
  if (problem === null) {
    return null;
  }
  return {
    id: "level-header",
    errorType: "Level",
    headline: problem.message,
    howToFix: problem.howToFix,
    fileName,
    lineNumber: problem.line,
    column: null,
    nameToken: null,
    severity: "error",
    origin: "static",
    level,
  };
}
