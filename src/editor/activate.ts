import * as vscode from "vscode";
import { registerCommands } from "./commands";
import { Diagnostics } from "./diagnostics";
import { checkConflictingExtensions } from "./setup/extensionGuard";
import { InteractionsView } from "./panel/view";
import { LevelLineKeeper } from "./levelLine";
import { registerNewFileLevel } from "./setup/newFileLevel";
import { trackProgramSchemes } from "./programDocuments";
import { ReplSession } from "./replSession";
import type { PythonRuntime } from "../run/python";
import { connectUniverse } from "./reactors/universe";
import { createMementoStore } from "./bundleStore";

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
  const levelLine = new LevelLineKeeper();
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
    levelLine,
    registerNewFileLevel(),
    trackProgramSchemes(),
    { dispose: () => runtime.dispose() },
  );

  registerCommands(context, { repl, view, levelLine });
  void checkConflictingExtensions(context);
}
