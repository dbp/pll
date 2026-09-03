import type { Level } from "../level";
import type { ParsedPythonError } from "../errors/pythonErrorParser";
import { nameErrorAnalyzer } from "./nameErrorAnalyzer";
import type { AnalysisFinding, RuntimeAnalyzer } from "./types";

/** Add an analyzer here to give another runtime error a friendly finding. */
const analyzers: RuntimeAnalyzer[] = [nameErrorAnalyzer];

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
  return null;
}
