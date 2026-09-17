import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  isMountableName,
  selectMountableFiles,
  selectWritebackFiles,
  type WorkspaceFile,
} from "../common/workspaceFilePolicy";

/**
 * Sibling files, over Node's filesystem instead of `vscode.workspace.fs`.
 *
 * Every rule about *which* files and *how big* lives in
 * `workspaceFilePolicy`, shared with the extension, so `open("data.csv")`
 * sees the same set here as it does in the editor. Only the reading and
 * writing differ. There is no editor, so unlike the extension there are no
 * unsaved buffers to prefer over disk.
 */
export async function collectSiblingFiles(scriptPath: string): Promise<WorkspaceFile[]> {
  const folder = path.dirname(path.resolve(scriptPath));
  let entries;
  try {
    entries = await fs.readdir(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates: { name: string; contents: string | Uint8Array }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isMountableName(entry.name)) {
      continue;
    }
    try {
      candidates.push({ name: entry.name, contents: await fs.readFile(path.join(folder, entry.name)) });
    } catch {
      /* skip unreadable files, as the extension does */
    }
  }
  return selectMountableFiles(candidates);
}

/** Write changed data files back next to the script. Returns basenames. */
export async function writeBackSiblingFiles(
  scriptPath: string,
  files: WorkspaceFile[],
): Promise<string[]> {
  const folder = path.dirname(path.resolve(scriptPath));
  const written: string[] = [];
  for (const file of selectWritebackFiles(files)) {
    try {
      await fs.writeFile(path.join(folder, file.name), file.contents, "utf8");
      written.push(file.name);
    } catch {
      /* skip files we cannot write */
    }
  }
  return written;
}
