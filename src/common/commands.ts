import * as vscode from "vscode";
import type { BonnieDiagnostics } from "./diagnostics";
import type { BonnieInteractionsView } from "./interactionsView";
import type { BonnieReplSession } from "./replSession";

export interface BonnieServices {
  repl: BonnieReplSession;
  diagnostics: BonnieDiagnostics;
  view: BonnieInteractionsView;
}

export function registerCommands(
  context: vscode.ExtensionContext,
  services: BonnieServices,
): void {
  context.subscriptions.push(
    // Show the integrated interactions view.
    vscode.commands.registerCommand("bonniePython.showInteractions", () =>
      services.view.reveal({ preserveFocus: false }).catch(reportError),
    ),
    // Back-compat alias for users who had this bound; just opens the view.
    vscode.commands.registerCommand("bonniePython.startRepl", () =>
      services.view.reveal({ preserveFocus: false }).catch(reportError),
    ),
    vscode.commands.registerCommand("bonniePython.runActiveFile", () =>
      runActiveFile(services).catch(reportError),
    ),
    vscode.commands.registerCommand("bonniePython.clearInteractions", () =>
      services.view.clear(),
    ),
  );
}

async function runActiveFile(services: BonnieServices): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("Bonnie Python: no active editor.");
    return;
  }
  const document = editor.document;
  if (document.languageId !== "python") {
    vscode.window.showWarningMessage("Bonnie Python: active file is not Python.");
    return;
  }

  const fileName = document.uri.path.split("/").pop() ?? "user_script.py";
  await services.repl.runFile(document.getText(), fileName, document);
}

function reportError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  vscode.window.showErrorMessage(`Bonnie Python: ${message}`);
}
