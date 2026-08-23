import * as vscode from "vscode";
import type { AnalysisFinding } from "./analyzers/types";
import { formatFriendlyErrorPlain } from "./errorFormatter";

/**
 * Owns:
 *   - the DiagnosticCollection (squiggle + Problems panel + tooltip text)
 *   - a gutter-icon decoration shown next to the line of the error
 *   - an overview-ruler tint so the error is also visible in the right strip
 *
 * The decoration has to be re-applied whenever the set of visible editors
 * changes (e.g. user opens the file fresh), since `setDecorations` is
 * editor-scoped.
 */
export class Diagnostics implements vscode.Disposable {
  private readonly collection: vscode.DiagnosticCollection;
  private readonly gutterDecoration: vscode.TextEditorDecorationType;
  private readonly perUriRanges = new Map<string, vscode.Range[]>();
  private readonly editorWatcher: vscode.Disposable;

  constructor(extensionUri: vscode.Uri) {
    this.collection = vscode.languages.createDiagnosticCollection("python-language-levels");
    this.gutterDecoration = vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.joinPath(extensionUri, "media", "error-gutter.svg"),
      gutterIconSize: "contain",
      overviewRulerColor: "rgba(229, 20, 0, 0.85)",
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      isWholeLine: false,
    });
    this.editorWatcher = vscode.window.onDidChangeVisibleTextEditors((editors) => {
      this.applyToEditors(editors);
    });
  }

  clear(uri: vscode.Uri): void {
    this.collection.delete(uri);
    this.perUriRanges.delete(uri.toString());
    this.applyToEditors(vscode.window.visibleTextEditors);
  }

  /** Single-finding shortcut. Equivalent to `setFindings(uri, doc, [f])`. */
  setFinding(
    uri: vscode.Uri,
    document: vscode.TextDocument | undefined,
    finding: AnalysisFinding,
  ): void {
    this.setFindings(uri, document, [finding]);
  }

  /**
   * Replace all diagnostics for `uri` with the given findings. Findings are
   * shown in the Problems panel, get squiggles in the editor, and each
   * contributes a gutter icon at its line.
   */
  setFindings(
    uri: vscode.Uri,
    document: vscode.TextDocument | undefined,
    findings: ReadonlyArray<AnalysisFinding>,
  ): void {
    if (findings.length === 0) {
      this.clear(uri);
      return;
    }
    const diagnostics: vscode.Diagnostic[] = [];
    const ranges: vscode.Range[] = [];
    for (const finding of findings) {
      const range = computeRange(document, finding);
      const diagnostic = new vscode.Diagnostic(
        range,
        formatFriendlyErrorPlain(finding),
        mapSeverity(finding.severity),
      );
      diagnostic.source =
        finding.origin === "static" ? "Python Language Levels (static)" : "Python Language Levels";
      diagnostic.code = finding.errorType;
      diagnostics.push(diagnostic);
      ranges.push(range);
    }
    this.collection.set(uri, diagnostics);
    this.perUriRanges.set(uri.toString(), ranges);
    this.applyToEditors(vscode.window.visibleTextEditors);
  }

  dispose(): void {
    this.editorWatcher.dispose();
    this.collection.dispose();
    this.gutterDecoration.dispose();
  }

  private applyToEditors(editors: readonly vscode.TextEditor[]): void {
    for (const editor of editors) {
      const ranges = this.perUriRanges.get(editor.document.uri.toString()) ?? [];
      editor.setDecorations(this.gutterDecoration, ranges);
    }
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
