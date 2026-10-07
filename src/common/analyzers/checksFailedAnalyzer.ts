import { enrichStaticFindings } from "./static/registry";
import { runtimeFindingFor, type AnalysisFinding, type RuntimeAnalyzer, type RuntimeAnalyzerInput } from "./types";

/**
 * One of the student's files that another imports, refused because it did
 * not pass its own level's checks (`imports.py`).
 *
 * Reported at the `import`, which is where the program stopped, with each
 * problem in the file worded as a run of that file words it.
 */
export const checksFailedAnalyzer: RuntimeAnalyzer = {
  handles: ["ChecksFailed"],
  analyze(input: RuntimeAnalyzerInput): AnalysisFinding | null {
    const checks = input.error.facts.checks;
    if (checks === undefined) {
      return null;
    }
    const { file, level, headerProblem } = checks;
    const problems =
      headerProblem !== null
        ? [`Line ${headerProblem.line}: ${headerProblem.message}`]
        : enrichStaticFindings(checks.findings, level, file).map(
            (finding) => `Line ${finding.lineNumber}: ${finding.headline}`,
          );
    const count = problems.length === 1 ? "a problem" : `${problems.length} problems`;
    return runtimeFindingFor(input, {
      id: "checks-failed",
      errorType: "ChecksFailed",
      headline:
        headerProblem !== null
          ? `\`${file}\` was not imported: there is a problem with its \`#level\` line.`
          : `\`${file}\` was not imported: the checks of \`#level ${level}\` found ${count} in it.`,
      howToFix: [...problems, `Run \`${file}\` itself to see ${problems.length === 1 ? "it" : "each one"} where it is.`],
    });
  },
};
