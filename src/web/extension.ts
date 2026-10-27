import type * as vscode from "vscode";
import { activateWithRuntime } from "../editor/activate";
import type { PllApi } from "../editor/api";
import { webPython } from "./pyodideRuntime";

export function activate(context: vscode.ExtensionContext): PllApi {
  return activateWithRuntime(context, webPython(context.extensionUri));
}

export function deactivate(): void {
  // Resources cleaned up via context.subscriptions.
}
