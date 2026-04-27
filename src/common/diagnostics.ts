import * as vscode from "vscode";
import type { AnalysisFinding } from "./analyzers/types";

export class BonnieDiagnostics {
  private readonly collection: vscode.DiagnosticCollection;

  constructor() {
    this.collection = vscode.languages.createDiagnosticCollection("bonnie-python");
  }

  clear(uri: vscode.Uri): void {
    this.collection.delete(uri);
  }

  setFinding(uri: vscode.Uri, document: vscode.TextDocument | undefined, finding: AnalysisFinding): void {
    const range = computeRange(document, finding);
    const diagnostic = new vscode.Diagnostic(
      range,
      buildDiagnosticMessage(finding),
      mapSeverity(finding.severity),
    );
    diagnostic.source = "Bonnie Python";
    diagnostic.code = finding.errorType;
    this.collection.set(uri, [diagnostic]);
  }

  dispose(): void {
    this.collection.dispose();
  }
}

function mapSeverity(severity: AnalysisFinding["severity"]): vscode.DiagnosticSeverity {
  switch (severity) {
    case "error":
      return vscode.DiagnosticSeverity.Error;
    case "warning":
      return vscode.DiagnosticSeverity.Warning;
    case "info":
      return vscode.DiagnosticSeverity.Information;
    default:
      return vscode.DiagnosticSeverity.Error;
  }
}

function buildDiagnosticMessage(finding: AnalysisFinding): string {
  const parts: string[] = [finding.headline];
  if (finding.howToFix.length > 0) {
    parts.push("");
    parts.push("How to fix:");
    for (const step of finding.howToFix) {
      parts.push(`  - ${step}`);
    }
  }
  return parts.join("\n");
}

function computeRange(
  document: vscode.TextDocument | undefined,
  finding: AnalysisFinding,
): vscode.Range {
  if (finding.lineNumber === null) {
    return new vscode.Range(0, 0, 0, 0);
  }
  const lineIndex = Math.max(0, finding.lineNumber - 1);

  if (!document) {
    return new vscode.Range(lineIndex, 0, lineIndex, Number.MAX_SAFE_INTEGER);
  }
  if (lineIndex >= document.lineCount) {
    const last = Math.max(0, document.lineCount - 1);
    return document.lineAt(last).range;
  }

  const lineRange = document.lineAt(lineIndex).range;
  if (finding.nameToken) {
    const lineText = document.lineAt(lineIndex).text;
    const tokenRange = findTokenRange(lineText, lineIndex, finding.nameToken, finding.column);
    if (tokenRange) {
      return tokenRange;
    }
  }
  return lineRange;
}

function findTokenRange(
  lineText: string,
  lineIndex: number,
  token: string,
  preferredColumn: number | null,
): vscode.Range | null {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${escaped}\\b`, "g");

  const matches: { index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(lineText)) !== null) {
    matches.push({ index: m.index });
    if (m.index === re.lastIndex) {
      re.lastIndex++;
    }
  }
  if (matches.length === 0) {
    return null;
  }

  let chosen = matches[0];
  if (preferredColumn !== null) {
    let bestDelta = Number.MAX_SAFE_INTEGER;
    for (const candidate of matches) {
      const delta = Math.abs(candidate.index - preferredColumn);
      if (delta < bestDelta) {
        bestDelta = delta;
        chosen = candidate;
      }
    }
  }

  return new vscode.Range(lineIndex, chosen.index, lineIndex, chosen.index + token.length);
}
