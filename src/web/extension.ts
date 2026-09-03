import type * as vscode from "vscode";
import { activateWithRuntime } from "../common/activate";
import { WebPyodideRuntime } from "./pyodideRuntime";

export function activate(context: vscode.ExtensionContext): void {
  activateWithRuntime(context, new WebPyodideRuntime(context.extensionUri));
}

export function deactivate(): void {
  // Resources cleaned up via context.subscriptions.
}
