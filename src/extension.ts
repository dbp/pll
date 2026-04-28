import * as vscode from "vscode";
import { registerCommands } from "./common/commands";
import { BonnieDiagnostics } from "./common/diagnostics";
import { checkConflictingExtensions } from "./common/extensionGuard";
import { BonnieReplSession } from "./common/replSession";
import { BonnieTerminalLinkProvider } from "./common/terminalLinks";
import { DesktopPyodideRuntime } from "./desktop/pyodideRuntime";

export function activate(context: vscode.ExtensionContext): void {
  const runtime = new DesktopPyodideRuntime(context.extensionPath);
  const diagnostics = new BonnieDiagnostics(context.extensionUri);
  const terminalLinks = new BonnieTerminalLinkProvider();
  const repl = new BonnieReplSession({ runtime, diagnostics, terminalLinks });

  context.subscriptions.push({ dispose: () => runtime.dispose() });
  context.subscriptions.push(diagnostics);
  context.subscriptions.push(terminalLinks);
  context.subscriptions.push({ dispose: () => repl.dispose() });

  registerCommands(context, { repl, diagnostics });
  void checkConflictingExtensions(context);
}

export function deactivate(): void {
  // Resources cleaned up via context.subscriptions
}
