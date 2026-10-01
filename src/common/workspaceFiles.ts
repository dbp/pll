import * as vscode from "vscode";
import {
  isMountableName,
  selectMountableFiles,
  selectWritebackFiles,
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
 * Text files in the same folder as `documentUri`. Prefers unsaved editor
 * buffers over disk so a CSV the student is editing is what `open` sees.
 */
export async function collectSiblingFiles(
  documentUri: vscode.Uri,
): Promise<WorkspaceFile[]> {
  const folder = folderUri(documentUri);
  if (!folder) {
    return [];
  }
  let listing: [string, vscode.FileType][];
  try {
    listing = await vscode.workspace.fs.readDirectory(folder);
  } catch {
    return [];
  }
  const candidates: { name: string; contents: string | Uint8Array }[] = [];
  for (const [name, type] of listing) {
    if (type !== vscode.FileType.File) {
      continue;
    }
    if (!isMountableName(name)) {
      continue;
    }
    const uri = vscode.Uri.joinPath(folder, name);
    const fromEditor = openDocumentText(uri);
    if (fromEditor !== undefined) {
      candidates.push({ name, contents: fromEditor });
      continue;
    }
    try {
      candidates.push({ name, contents: await vscode.workspace.fs.readFile(uri) });
    } catch {
      /* skip unreadable files */
    }
  }
  return selectMountableFiles(candidates);
}

/**
 * Write changed/new data files next to the running script. Returns the
 * basenames that were written.
 */
export async function writeBackSiblingFiles(
  documentUri: vscode.Uri,
  files: WorkspaceFile[],
): Promise<string[]> {
  const folder = folderUri(documentUri);
  if (!folder) {
    return [];
  }
  const written: string[] = [];
  for (const file of selectWritebackFiles(files)) {
    const uri = vscode.Uri.joinPath(folder, file.name);
    try {
      // Only text files are writeback-eligible, so this is a string; the
      // union exists for the pictures that are mounted and never written.
      const bytes =
        typeof file.contents === "string"
          ? new TextEncoder().encode(file.contents)
          : file.contents;
      await vscode.workspace.fs.writeFile(uri, bytes);
      written.push(file.name);
    } catch {
      /* skip files the host refuses to write */
    }
  }
  return written;
}
