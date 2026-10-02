import type { Level } from "../level";
import type { ParsedPythonError } from "../errors/pythonErrorParser";
import { nameErrorAnalyzer } from "./nameErrorAnalyzer";
import { analyzeRuntimeError } from "./runtimeErrorAnalyzer";
import { stockMessageAnalyzer } from "./stockMessageAnalyzer";
import { syntaxErrorAnalyzer } from "./syntaxErrorAnalyzer";
import { typeCheckAnalyzer } from "./typeCheckAnalyzer";
import type { AnalysisFinding, RuntimeAnalyzer } from "./types";

/**
 * Add an analyzer here to give another runtime error a friendly finding.
 * Order matters: the first one that claims the error wins, and anything
 * none of them claims falls through to `analyzeRuntimeError`.
 */
const analyzers: RuntimeAnalyzer[] = [
  nameErrorAnalyzer,
  typeCheckAnalyzer,
  syntaxErrorAnalyzer,
  // Last before the catch-all: it only reaches an error no analyzer
  // above recognised, and claims it only if it can say something better
  // than Python did.
  stockMessageAnalyzer,
];

export function findRuntimeFinding(
  source: string,
  fileName: string,
  level: Level,
  parsedError: ParsedPythonError,
): AnalysisFinding | null {
  for (const analyzer of analyzers) {
    if (!analyzer.handles.includes(parsedError.errorType)) {
      continue;
    }
    const finding = analyzer.analyze({ source, fileName, level, parsedError });
    if (finding) {
      return finding;
    }
  }
  // Never null: every runtime error is reported as a finding, so no student
  // is shown a traceback through PLL's own internals.
  return analyzeRuntimeError({ source, fileName, level, parsedError });
}
