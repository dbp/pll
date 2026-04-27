import * as vscode from "vscode";
import { registerCommands } from "../common/commands";
import { BonnieDiagnostics } from "../common/diagnostics";
import { BonnieOutput } from "../common/output";
import { WebPyodideRuntime } from "./pyodideRuntime";

export function activate(context: vscode.ExtensionContext): void {
  const runtime = new WebPyodideRuntime(context.extensionUri);
  const output = new BonnieOutput();
  const diagnostics = new BonnieDiagnostics();

  context.subscriptions.push({ dispose: () => runtime.dispose() });
  context.subscriptions.push(output);
  context.subscriptions.push(diagnostics);

  registerCommands(context, { runtime, output, diagnostics });
}

export function deactivate(): void {
  // Resources cleaned up via context.subscriptions
}
