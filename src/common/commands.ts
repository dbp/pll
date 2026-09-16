import * as vscode from "vscode";
import type { Diagnostics } from "./diagnostics";
import { editorCopy, editorCut, editorPaste } from "./editorClipboard";
import type { InteractionsView } from "./interactionsView";
import type { ReplSession } from "./replSession";

export interface ExtensionServices {
  repl: ReplSession;
  diagnostics: Diagnostics;
  view: InteractionsView;
}

export function registerCommands(
  context: vscode.ExtensionContext,
  services: ExtensionServices,
): void {
  context.subscriptions.push(
    // Show the integrated interactions view. `startRepl` is a back-compat
    // alias for users who had it bound.
    ...["pll.showInteractions", "pll.startRepl"].map((id) =>
      vscode.commands.registerCommand(id, () =>
        services.view.reveal({ preserveFocus: false }).catch(reportError),
      ),
    ),
    vscode.commands.registerCommand("pll.runActiveFile", () =>
      runActiveFile(services).catch(reportError),
    ),
    vscode.commands.registerCommand("pll.clearInteractions", () =>
      services.view.clear(),
    ),
    vscode.commands.registerCommand("pll.stopProgram", () =>
      services.repl.stopActiveProgram(),
    ),
    vscode.commands.registerCommand("pll.editor.copy", () =>
      editorCopy().catch(reportError),
    ),
    vscode.commands.registerCommand("pll.editor.cut", () =>
      editorCut().catch(reportError),
    ),
    vscode.commands.registerCommand("pll.editor.paste", () =>
      editorPaste().catch(reportError),
    ),
  );
}

async function runActiveFile(services: ExtensionServices): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("Python Language Levels: no active editor.");
    return;
  }
  const document = editor.document;
  if (document.languageId !== "python") {
    vscode.window.showWarningMessage("Python Language Levels: active file is not Python.");
    return;
  }

  const fileName = document.uri.path.split("/").pop() ?? "user_script.py";
  await services.repl.runFile(document.getText(), fileName, document);
}

function reportError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  vscode.window.showErrorMessage(`Python Language Levels: ${message}`);
}
