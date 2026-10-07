import * as vscode from "vscode";
import {
  readSiblingFiles,
  writeSiblingFiles,
  type LeftOut,
  type Selection,
  type SiblingFolder,
  type WorkspaceFile,
} from "./workspaceFilePolicy";

export type { WorkspaceFile } from "./workspaceFilePolicy";

export function folderUri(fileUri: vscode.Uri): vscode.Uri | undefined {
  if (fileUri.scheme === "untitled") {
    return undefined;
  }
  return vscode.Uri.joinPath(fileUri, "..");
}

function openDocumentText(uri: vscode.Uri): string | undefined {
  const doc = vscode.workspace.textDocuments.find(
    (candidate) => candidate.uri.toString() === uri.toString(),
  );
  return doc ? doc.getText() : undefined;
}

/**
 * The folder `documentUri` is in, through `vscode.workspace.fs` - or null
 * for an untitled file, which is in no folder.
 */
function siblingFolder(documentUri: vscode.Uri): SiblingFolder | null {
  const folder = folderUri(documentUri);
  if (!folder) {
    return null;
  }
  const at = (name: string) => vscode.Uri.joinPath(folder, name);
  return {
    files: async () =>
      (await vscode.workspace.fs.readDirectory(folder))
        .filter(([, type]) => type === vscode.FileType.File)
        .map(([name]) => name),
    // An unsaved buffer over the disk: a CSV the student is editing is
    // what `open` should see.
    read: async (name) => openDocumentText(at(name)) ?? (await vscode.workspace.fs.readFile(at(name))),
    write: async (name, text) => {
      await vscode.workspace.fs.writeFile(at(name), new TextEncoder().encode(text));
    },
  };
}

/** Text and picture files in the same folder as `documentUri`, and those the limits kept back. */
export async function collectSiblingFiles(documentUri: vscode.Uri): Promise<Selection> {
  const folder = siblingFolder(documentUri);
  return folder ? readSiblingFiles(folder) : { files: [], leftOut: [] };
}

/** Write changed and new data files next to the file: the names written, and those kept back. */
export async function writeBackSiblingFiles(
  documentUri: vscode.Uri,
  files: WorkspaceFile[],
): Promise<{ written: string[]; leftOut: LeftOut[] }> {
  const folder = siblingFolder(documentUri);
  return folder ? writeSiblingFiles(folder, files) : { written: [], leftOut: [] };
}
