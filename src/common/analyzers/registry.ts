import type { Level } from "../level";
import type { ParsedPythonError } from "../errors/pythonErrorParser";
import { nameErrorAnalyzer } from "./nameErrorAnalyzer";
import type { AnalysisFinding, Analyzer } from "./types";

const analyzers: Analyzer[] = [nameErrorAnalyzer];

export function registerAnalyzer(analyzer: Analyzer): void {
  analyzers.push(analyzer);
}

export function findRuntimeFinding(
  source: string,
  fileName: string,
  level: Level,
  parsedError: ParsedPythonError,
): AnalysisFinding | null {
  for (const a of analyzers) {
    if (a.kind !== "runtime") continue;
    if (!a.handles.includes(parsedError.errorType)) {
      continue;
    }
    const finding = a.analyze({ source, fileName, level, parsedError });
    if (finding) {
      return finding;
    }
  }
  return null;
}
