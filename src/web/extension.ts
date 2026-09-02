import * as vscode from "vscode";
import { registerCommands } from "../common/commands";
import { Diagnostics } from "../common/diagnostics";
import {
  clearWebClipboardKeybindings,
  disableEditContext,
} from "../common/editorDefaults";
import { checkConflictingExtensions } from "../common/extensionGuard";
import { InteractionsView } from "../common/interactionsView";
import { ReplSession } from "../common/replSession";
import { WebPyodideRuntime } from "./pyodideRuntime";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await disableEditContext();
  try {
    await clearWebClipboardKeybindings();
  } catch (err) {
    console.error("PLL: could not clear web clipboard keybindings", err);
  }
  const runtime = new WebPyodideRuntime(context.extensionUri);
  const diagnostics = new Diagnostics(context.extensionUri);
  const view = new InteractionsView(context.extensionUri);
  const repl = new ReplSession({ runtime, diagnostics, view });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(InteractionsView.viewType, view),
  );
  context.subscriptions.push({ dispose: () => runtime.dispose() });
  context.subscriptions.push(diagnostics);
  context.subscriptions.push(view);
  context.subscriptions.push({ dispose: () => repl.dispose() });

  registerCommands(context, { repl, diagnostics, view });
  void checkConflictingExtensions(context);
}

export function deactivate(): void {
  // Resources cleaned up via context.subscriptions.
}
