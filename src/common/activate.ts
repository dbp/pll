import * as vscode from "vscode";
import { registerCommands } from "./commands";
import { Diagnostics } from "./diagnostics";
import { checkConflictingExtensions } from "./extensionGuard";
import { InteractionsView } from "./interactionsView";
import { registerNewFileLevel } from "./newFileLevel";
import { ReplSession } from "./replSession";
import type { PythonRuntime } from "./types";
import { connectUniverse } from "./universeClient";
import { createMementoStore } from "./vscodeBundleStore";

/**
 * Shared activation for both hosts. The desktop and web entrypoints differ
 * only in which `PythonRuntime` they hand over.
 */
export function activateWithRuntime(
  context: vscode.ExtensionContext,
  runtime: PythonRuntime,
): void {
  const diagnostics = new Diagnostics(context.extensionUri);
  const view = new InteractionsView(context.extensionUri);
  const repl = new ReplSession({
    runtime,
    diagnostics,
    view,
    connectUniverse,
    bundleStore: createMementoStore(context.globalState),
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(InteractionsView.viewType, view),
    diagnostics,
    view,
    repl,
    registerNewFileLevel(),
    { dispose: () => runtime.dispose() },
  );

  registerCommands(context, { repl, view });
  void checkConflictingExtensions(context);
}
