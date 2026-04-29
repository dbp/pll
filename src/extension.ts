import * as vscode from "vscode";
import { registerCommands } from "./common/commands";
import { BonnieDiagnostics } from "./common/diagnostics";
import { checkConflictingExtensions } from "./common/extensionGuard";
import { BonnieInteractionsView } from "./common/interactionsView";
import { BonnieReplSession } from "./common/replSession";
import { DesktopPyodideRuntime } from "./desktop/pyodideRuntime";

export function activate(context: vscode.ExtensionContext): void {
  const runtime = new DesktopPyodideRuntime(context.extensionPath);
  const diagnostics = new BonnieDiagnostics(context.extensionUri);
  const view = new BonnieInteractionsView(context.extensionUri);
  const repl = new BonnieReplSession({ runtime, diagnostics, view });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(BonnieInteractionsView.viewType, view),
  );
  context.subscriptions.push({ dispose: () => runtime.dispose() });
  context.subscriptions.push(diagnostics);
  context.subscriptions.push(view);
  context.subscriptions.push({ dispose: () => repl.dispose() });

  registerCommands(context, { repl, diagnostics, view });
  void checkConflictingExtensions(context);
}

export function deactivate(): void {
  // Resources cleaned up via context.subscriptions.
}
