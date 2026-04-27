import type { ParsedPythonError } from "../errors/pythonErrorParser";
import { nameErrorAnalyzer } from "./nameErrorAnalyzer";
import type { AnalysisFinding, Analyzer, RuntimeAnalyzer, StaticAnalyzer } from "./types";

const analyzers: Analyzer[] = [nameErrorAnalyzer];

export function registerAnalyzer(analyzer: Analyzer): void {
  analyzers.push(analyzer);
}

function isRuntime(a: Analyzer): a is RuntimeAnalyzer {
  return a.kind === "runtime";
}

function isStatic(a: Analyzer): a is StaticAnalyzer {
  return a.kind === "static";
}

export function findRuntimeFinding(
  source: string,
  fileName: string,
  parsedError: ParsedPythonError,
): AnalysisFinding | null {
  for (const a of analyzers.filter(isRuntime)) {
    if (!a.handles.includes(parsedError.errorType)) {
      continue;
    }
    const finding = a.analyze({ source, fileName, parsedError });
    if (finding) {
      return finding;
    }
  }
  return null;
}

export async function runStaticAnalyzers(
  source: string,
  fileName: string,
): Promise<AnalysisFinding[]> {
  const findings: AnalysisFinding[] = [];
  for (const a of analyzers.filter(isStatic)) {
    const result = await a.analyze({ source, fileName });
    findings.push(...result);
  }
  return findings;
}
