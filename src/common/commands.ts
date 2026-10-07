import * as vscode from "vscode";
import { editorCopy, editorCut, editorPaste } from "./editorClipboard";
import type { InteractionsView } from "./interactionsView";
import type { ReplSession } from "./replSession";
import { errorText } from "./errorText";
import { showError, showWarning } from "./notify";
import { isProgramDocument } from "./programDocuments";

export interface ExtensionServices {
  repl: ReplSession;
  view: InteractionsView;
}

export function registerCommands(
  context: vscode.ExtensionContext,
  services: ExtensionServices,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("pll.showInteractions", () =>
      services.view.reveal({ preserveFocus: false }).catch(reportError),
    ),
    vscode.commands.registerCommand("pll.startRepl", () => services.repl.showNoFileSession()),
    vscode.commands.registerCommand("pll.runActiveFile", () =>
      runActiveFile(services).catch(reportError),
    ),
    vscode.commands.registerCommand("pll.clearInteractions", () =>
      services.repl.clearActiveSession(),
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
    void showWarning("no active editor.");
    return;
  }
  const document = editor.document;
  if (document.languageId !== "python") {
    void showWarning("active file is not Python.");
    return;
  }
  if (!isProgramDocument(document.uri)) {
    void showWarning("only a file can be run, and this editor shows something else - a diff, or a notebook cell.");
    return;
  }

  const fileName = document.uri.path.split("/").pop() ?? "user_script.py";
  await services.repl.runFile(document.getText(), fileName, document);
}

function reportError(err: unknown): void {
  void showError(errorText(err));
}
