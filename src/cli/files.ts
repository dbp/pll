import * as fs from "node:fs/promises";
import * as path from "node:path";
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
} from "../common/workspaceFilePolicy";

/**
 * The script's folder over Node's filesystem. There is no editor, so unlike
 * the extension there are no unsaved buffers to prefer over the disk. A
 * symlink is followed - a grader's shared fixtures are often linked in - but
 * a folder is walked once however many links reach it.
 */
function siblingFolder(scriptPath: string): SiblingFolder {
  const folder = path.dirname(path.resolve(scriptPath));
  const at = (name: string) => path.join(folder, ...name.split("/"));
  return {
    async files() {
      const out: FolderEntry[] = [];
      const seen = new Set<string>();
      const walk = async (dir: string, prefix: string) => {
        const real = await fs.realpath(dir);
        if (seen.has(real)) return;
        seen.add(real);
        for (const name of await fs.readdir(dir)) {
          const full = path.join(dir, name);
          const stat = await fs.stat(full).catch(() => null);
          if (stat === null) continue;
          if (stat.isDirectory()) {
            if (isWalkedFolder(name)) await walk(full, `${prefix}${name}/`);
          } else if (stat.isFile()) {
            out.push({ name: `${prefix}${name}`, size: stat.size, mtimeMs: stat.mtimeMs });
          }
        }
      };
      await walk(folder, "");
      return out;
    },
    read: (name) => fs.readFile(at(name)),
    async stat(name): Promise<FileStamp | null> {
      const stat = await fs.stat(at(name)).catch(() => null);
      return stat === null ? null : { size: stat.size, mtimeMs: stat.mtimeMs };
    },
    async write(name, bytes) {
      await fs.mkdir(path.dirname(at(name)), { recursive: true });
      await fs.writeFile(at(name), bytes);
    },
    remove: (name) => fs.unlink(at(name)),
  };
}

/** The files under the script's folder, and those the limits kept back. */
export function collectSiblingFiles(scriptPath: string): Promise<Selection> {
  return readSiblingFiles(siblingFolder(scriptPath));
}

/** Save what the program changed under the script's folder, as `writeSiblingFiles` allows. */
export function writeBackSiblingFiles(
  scriptPath: string,
  changes: WorkspaceChanges,
  loaded: Selection["loaded"],
): Promise<WriteBackResult> {
  return writeSiblingFiles(siblingFolder(scriptPath), changes, loaded);
}
