import * as vscode from "vscode";
import { registerCommands } from "../common/commands";
import { BonnieDiagnostics } from "../common/diagnostics";
import { checkConflictingExtensions } from "../common/extensionGuard";
import { BonnieReplSession } from "../common/replSession";
import { WebPyodideRuntime } from "./pyodideRuntime";

export function activate(context: vscode.ExtensionContext): void {
  const runtime = new WebPyodideRuntime(context.extensionUri);
  const diagnostics = new BonnieDiagnostics();
  const repl = new BonnieReplSession({ runtime, diagnostics });

  context.subscriptions.push({ dispose: () => runtime.dispose() });
  context.subscriptions.push(diagnostics);
  context.subscriptions.push({ dispose: () => repl.dispose() });

  registerCommands(context, { repl, diagnostics });
  void checkConflictingExtensions(context);
}

export function deactivate(): void {
  // Resources cleaned up via context.subscriptions
}
