import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  readSiblingFiles,
  writeSiblingFiles,
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

/** Text and picture files next to the script. */
export function collectSiblingFiles(scriptPath: string): Promise<WorkspaceFile[]> {
  return readSiblingFiles(siblingFolder(scriptPath));
}

/** Write changed data files back next to the script. Returns their names. */
export function writeBackSiblingFiles(
  scriptPath: string,
  files: WorkspaceFile[],
): Promise<string[]> {
  return writeSiblingFiles(siblingFolder(scriptPath), files);
}
