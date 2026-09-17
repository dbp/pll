import * as path from "node:path";
import type * as vscode from "vscode";
import { activateWithRuntime } from "./common/activate";
import { DesktopPyodideRuntime } from "./desktop/pyodideRuntime";

export function activate(context: vscode.ExtensionContext): void {
  const root = context.extensionPath;
  const runtime = new DesktopPyodideRuntime({
    indexUrlCandidates: [
      path.join(root, "vendor", "pyodide"),
      path.join(root, "node_modules", "pyodide"),
    ],
    workerPath: path.join(root, "dist", "desktop", "pyodideWorker.js"),
    missingAssetsHint:
      "Pyodide runtime assets not found. Run `pnpm run build` to copy them into vendor/pyodide.",
  });
  activateWithRuntime(context, runtime);
}

export function deactivate(): void {
  // Resources cleaned up via context.subscriptions.
}
