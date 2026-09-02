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
    // Show the integrated interactions view.
    vscode.commands.registerCommand("pll.showInteractions", () =>
      services.view.reveal({ preserveFocus: false }).catch(reportError),
    ),
    // Back-compat alias for users who had this bound; just opens the view.
    vscode.commands.registerCommand("pll.startRepl", () =>
      services.view.reveal({ preserveFocus: false }).catch(reportError),
    ),
    vscode.commands.registerCommand("pll.runActiveFile", () =>
      runActiveFile(services).catch(reportError),
    ),
    vscode.commands.registerCommand("pll.clearInteractions", () =>
      services.view.clear(),
    ),
    vscode.commands.registerCommand("pll.interactions.copy", () =>
      services.view.copySelectionOrInterrupt().catch(reportError),
    ),
    vscode.commands.registerCommand("pll.interactions.cut", () =>
      services.view.cutSelection().catch(reportError),
    ),
    vscode.commands.registerCommand("pll.interactions.paste", () =>
      services.view.pasteClipboard().catch(reportError),
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
