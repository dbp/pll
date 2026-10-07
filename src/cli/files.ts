import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  readSiblingFiles,
  writeSiblingFiles,
  type LeftOut,
  type Selection,
  type SiblingFolder,
  type WorkspaceFile,
} from "../common/workspaceFilePolicy";

/**
 * The script's folder over Node's filesystem. There is no editor, so unlike
 * the extension there are no unsaved buffers to prefer over the disk.
 */
function siblingFolder(scriptPath: string): SiblingFolder {
  const folder = path.dirname(path.resolve(scriptPath));
  return {
    files: async () =>
      (await fs.readdir(folder, { withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name),
    read: (name) => fs.readFile(path.join(folder, name)),
    write: (name, text) => fs.writeFile(path.join(folder, name), text, "utf8"),
  };
}

/** Text and picture files next to the script, and those the limits kept back. */
export function collectSiblingFiles(scriptPath: string): Promise<Selection> {
  return readSiblingFiles(siblingFolder(scriptPath));
}

/** Write changed data files back next to the script: the names written, and those kept back. */
export function writeBackSiblingFiles(
  scriptPath: string,
  files: WorkspaceFile[],
): Promise<{ written: string[]; leftOut: LeftOut[] }> {
  return writeSiblingFiles(siblingFolder(scriptPath), files);
}
