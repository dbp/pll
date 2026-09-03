import type * as vscode from "vscode";
import { activateWithRuntime } from "./common/activate";
import { DesktopPyodideRuntime } from "./desktop/pyodideRuntime";

export function activate(context: vscode.ExtensionContext): void {
  activateWithRuntime(context, new DesktopPyodideRuntime(context.extensionPath));
}

export function deactivate(): void {
  // Resources cleaned up via context.subscriptions.
}
