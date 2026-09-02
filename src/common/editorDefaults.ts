import * as vscode from "vscode";

/**
 * vscode-web does not dispatch Ctrl/Cmd+C/X/V to commands (so the browser
 * can fire copy/paste events without a permission prompt). Extension
 * keybindings for those keys make the workbench swallow them and then
 * never run the command. Remove any we wrote in earlier attempts.
 */
export async function clearWebClipboardKeybindings(): Promise<void> {
  if (vscode.env.uiKind !== vscode.UIKind.Web) {
    return;
  }
  const uri = vscode.Uri.parse("vscode-userdata:/User/keybindings.json");
  let existing: unknown[] = [];
  try {
    const raw = await vscode.workspace.fs.readFile(uri);
    const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
    existing = Array.isArray(parsed) ? parsed : [];
  } catch {
    existing = [];
  }
  const kept = existing.filter((entry) => {
    if (!entry || typeof entry !== "object") {
      return true;
    }
    const command = (entry as { command?: unknown }).command;
    return typeof command !== "string" || !/(^|-)pll\.editor\./.test(command);
  });
  const next = `${JSON.stringify(kept, null, 2)}\n`;
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(next));
}

/**
 * Insiders / test-web enable EditContext (no DOM selection), so the
 * browser cannot copy from the editor. Turn it off before files open.
 */
export async function disableEditContext(): Promise<void> {
  const editor = vscode.workspace.getConfiguration("editor");
  await Promise.all([
    writeDefault(editor, "editContext", false),
    writeDefault(editor, "experimentalEditContextEnabled", false),
  ]);
}

async function writeDefault(
  config: vscode.WorkspaceConfiguration,
  key: string,
  value: boolean,
): Promise<void> {
  if (config.get(key) === value) {
    return;
  }
  try {
    await config.update(key, value, vscode.ConfigurationTarget.Workspace);
  } catch {
    try {
      await config.update(key, value, vscode.ConfigurationTarget.Global);
    } catch {
      /* Restricted Mode / missing folder: keep going. */
    }
  }
}
