import * as vscode from "vscode";
import {
  isWalkedFolder,
  readSiblingFiles,
  writeSiblingFiles,
  type FileStamp,
  type FolderEntry,
  type Selection,
  type SiblingFolder,
  type WorkspaceChanges,
  type WriteBackResult,
} from "./workspaceFilePolicy";

export type { WorkspaceFile } from "./workspaceFilePolicy";

export function folderUri(fileUri: vscode.Uri): vscode.Uri | undefined {
  if (fileUri.scheme === "untitled") {
    return undefined;
  }
  return vscode.Uri.joinPath(fileUri, "..");
}

function openDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === uri.toString());
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
  const at = (name: string) => vscode.Uri.joinPath(folder, ...name.split("/"));
  return {
    async files() {
      const out: FolderEntry[] = [];
      const walk = async (dir: vscode.Uri, prefix: string) => {
        for (const [name, type] of await vscode.workspace.fs.readDirectory(dir)) {
          // A type is a set of flags: a symlink to a file is File | SymbolicLink.
          if (type & vscode.FileType.Directory) {
            if (isWalkedFolder(name) && !(type & vscode.FileType.SymbolicLink)) {
              await walk(vscode.Uri.joinPath(dir, name), `${prefix}${name}/`);
            }
          } else if (type & vscode.FileType.File) {
            const stat = await vscode.workspace.fs.stat(vscode.Uri.joinPath(dir, name));
            out.push({ name: `${prefix}${name}`, size: stat.size, mtimeMs: stat.mtime });
          }
        }
      };
      await walk(folder, "");
      return out;
    },
    // An unsaved buffer over the disk: a CSV the student is editing is
    // what `open` should see.
    read: async (name) => openDocument(at(name))?.getText() ?? (await vscode.workspace.fs.readFile(at(name))),
    async stat(name): Promise<FileStamp | null> {
      try {
        const stat = await vscode.workspace.fs.stat(at(name));
        return { size: stat.size, mtimeMs: stat.mtime };
      } catch {
        return null;
      }
    },
    async write(name, bytes) {
      const target = at(name);
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, ".."));
      await vscode.workspace.fs.writeFile(target, bytes);
    },
    remove: async (name) => {
      await vscode.workspace.fs.delete(at(name));
    },
    unsaved: (name) => openDocument(at(name))?.isDirty === true,
  };
}

/** The files under the folder `documentUri` is in, and those the limits kept back. */
export async function collectSiblingFiles(documentUri: vscode.Uri): Promise<Selection> {
  const folder = siblingFolder(documentUri);
  return folder ? readSiblingFiles(folder) : { files: [], leftOut: [], loaded: {} };
}

/** Save what the program changed in that folder, as `writeSiblingFiles` allows. */
export async function writeBackSiblingFiles(
  documentUri: vscode.Uri,
  changes: WorkspaceChanges,
  loaded: Selection["loaded"],
): Promise<WriteBackResult> {
  const folder = siblingFolder(documentUri);
  return folder ? writeSiblingFiles(folder, changes, loaded) : { written: [], deleted: [], leftOut: [] };
}
