import * as path from "node:path";
import type * as vscode from "vscode";
import { activateWithRuntime } from "../editor/activate";
import type { PllApi } from "../editor/api";
import { desktopPython } from "./pyodideRuntime";

export function activate(context: vscode.ExtensionContext): PllApi {
  const root = context.extensionPath;
  const runtime = desktopPython({
    indexUrlCandidates: [
      path.join(root, "vendor", "pyodide"),
      path.join(root, "node_modules", "pyodide"),
    ],
    workerPath: path.join(root, "dist", "desktop", "pyodideWorker.js"),
    missingAssetsHint:
      "Pyodide runtime assets not found. Run `pnpm run build` to copy them into vendor/pyodide.",
  });
  return activateWithRuntime(context, runtime);
}

export function deactivate(): void {
  // Resources cleaned up via context.subscriptions.
}
