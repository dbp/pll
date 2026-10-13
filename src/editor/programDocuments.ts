import * as vscode from "vscode";

/**
 * Whether a document is a program a student can run - one that gets a
 * session: a file, an untitled editor, or a document on the file system a
 * workspace folder is on (vscode.dev's repositories). Not a view of one: a
 * diff's `git:` side, a notebook cell or an output pane has a file's
 * language and name and is not the file.
 */
export function isProgramDocument(uri: vscode.Uri): boolean {
  return programSchemes().includes(uri.scheme);
}

function programSchemes(): string[] {
  const schemes = new Set(["file", "untitled"]);
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    schemes.add(folder.uri.scheme);
  }
  return [...schemes];
}

/**
 * Keep `pll.programSchemes`, which the editor's Run button is shown by, in
 * step with the workspace folders.
 */
export function trackProgramSchemes(): vscode.Disposable {
  const update = () => void vscode.commands.executeCommand("setContext", "pll.programSchemes", programSchemes());
  update();
  return vscode.workspace.onDidChangeWorkspaceFolders(update);
}
