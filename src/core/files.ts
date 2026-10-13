/**
 * Which files PLL puts where a program can open them, and which of the
 * files it wrote are saved - for every host. Kept free of vscode so smoke
 * tests can import it.
 *
 * Files are moved as bytes both ways: a CSV saved as Latin-1, a `.dat` of
 * packed integers or a PNG arrives exactly as it is on disk, and what the
 * program wrote is saved exactly as it wrote it.
 */

export interface WorkspaceFile {
  /**
   * Where the file is, relative to the program's folder, with `/` between
   * folders: `cars.csv`, `data/2024.csv`.
   */
  name: string;
  /** Bytes - or, for an editor's unsaved buffer, its text. */
  contents: Uint8Array | string;
}

/** What a run did to the files it was given. */
export interface WorkspaceChanges {
  /** Files it made or changed. */
  files: WorkspaceFile[];
  /** Files it was given and deleted. */
  deleted: string[];
}

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_FILES = 100;

/** A file a limit or a rule kept back, and which. */
export interface LeftOut {
  name: string;
  reason:
    | "count"
    | "size"
    | "total"
    | "unreadable"
    | "notLoaded"
    | "changed"
    | "python"
    | "hidden"
    | "unsaved"
    | "failed";
  /** For "failed": what went wrong. */
  detail?: string;
}

/** A file as it was on disk when it was given to the program. */
export interface FileStamp {
  size: number;
  mtimeMs: number;
}

/** The files a limit let through, those it kept back, and how each loaded one was on disk. */
export interface Selection {
  files: WorkspaceFile[];
  leftOut: LeftOut[];
  loaded: Record<string, FileStamp>;
}

const MB = 1024 * 1024;

/** Why a file was kept back, as the end of a sentence. */
const WHY_LEFT_OUT: Record<LeftOut["reason"], (action: "loaded" | "saved") => string> = {
  count: () => `at most ${MAX_FILES} files next to a program are`,
  size: () => `each file can be at most ${MAX_FILE_BYTES / MB} MB`,
  total: () => `the files together can be at most ${MAX_TOTAL_BYTES / MB} MB`,
  unreadable: () => "it could not be read",
  notLoaded: () => "it was not loaded, so saving it would replace a file the program never saw",
  changed: () => "it changed on disk while the program ran",
  python: () => "PLL never overwrites or deletes a .py file",
  hidden: () => "PLL saves nothing into hidden folders",
  unsaved: () => "it has unsaved changes in the editor; save it and run again",
  failed: () => "it could not be written",
};

/** Why `file` was kept back, as the end of a sentence about loading it. */
export function whyNotLoaded(file: LeftOut): string {
  return WHY_LEFT_OUT[file.reason]("loaded");
}

/**
 * What to say about the files a limit or a rule kept back - one sentence
 * per reason - so that a program that cannot open or import one, or whose
 * output is not where it was written, is never left without a reason.
 * `action` is what did not happen to them.
 */
export function leftOutNotes(leftOut: LeftOut[], action: "loaded" | "saved"): string[] {
  const notes: string[] = [];
  for (const reason of Object.keys(WHY_LEFT_OUT) as LeftOut["reason"][]) {
    const kept = leftOut.filter((file) => file.reason === reason);
    if (kept.length === 0) {
      continue;
    }
    const names = kept.map((file) => (file.detail ? `${file.name} (${file.detail})` : file.name));
    const shown = names.slice(0, 5).join(", ");
    const more = names.length > 5 ? ` and ${names.length - 5} more` : "";
    notes.push(`Not ${action}: ${shown}${more} - ${WHY_LEFT_OUT[reason](action)}.`);
  }
  return notes;
}

/** The kinds of file a program reads, which are given to it. */
const MOUNT_EXTENSIONS = new Set([
  ".csv",
  ".tsv",
  ".txt",
  ".text",
  ".json",
  ".md",
  ".dat",
  ".xml",
  ".html",
  ".htm",
  ".log",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".py",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
]);

/** Folders that are a tool's, not the student's, and are never walked or written. */
const TOOL_FOLDERS = new Set(["__pycache__", "node_modules", "venv", "env", "site-packages"]);

export function extensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/** A relative path with no way out of the folder: no `..`, no root, no NUL. */
export function isSafePath(name: string): boolean {
  if (!name || name.includes("\\") || name.includes("\0") || name.startsWith("/")) {
    return false;
  }
  return name.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** A path into a hidden folder or file, or a tool's folder. */
export function isHiddenPath(name: string): boolean {
  return name.split("/").some((part) => part.startsWith(".") || TOOL_FOLDERS.has(part));
}

/** Whether a folder with this name is walked for files. */
export function isWalkedFolder(name: string): boolean {
  return !name.startsWith(".") && !TOOL_FOLDERS.has(name);
}

export function isMountableName(name: string): boolean {
  return isSafePath(name) && !isHiddenPath(name) && MOUNT_EXTENSIONS.has(extensionOf(name));
}

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** Size on the wire, whichever form the contents are in. */
export function contentsByteLength(contents: string | Uint8Array): number {
  return typeof contents === "string" ? utf8ByteLength(contents) : contents.byteLength;
}

/** A file as bytes. An editor's buffer is its text, saved as UTF-8. */
export function contentsBytes(contents: string | Uint8Array): Uint8Array {
  return typeof contents === "string" ? new TextEncoder().encode(contents) : contents;
}

/** A file under a program's folder, as a host lists it. */
export interface FolderEntry {
  name: string;
  size: number;
  mtimeMs: number;
}

/**
 * A program's folder, as a host reaches it: the editor through
 * `vscode.workspace.fs`, the command line through Node's. Everything else
 * about its files - which, how many, how big, what may be saved - is
 * decided here, so `open("data.csv")` sees the same files in both.
 */
export interface SiblingFolder {
  /** Every file under it, subfolders included, hidden and tool folders left out. */
  files(): Promise<FolderEntry[]>;
  read(name: string): Promise<Uint8Array | string>;
  /** How the file is on disk now, or null when there is none. */
  stat(name: string): Promise<FileStamp | null>;
  /** Write a file, making the folders it is in. */
  write(name: string, bytes: Uint8Array): Promise<void>;
  remove(name: string): Promise<void>;
  /** Whether the file is open in an editor with changes not yet saved. */
  unsaved?(name: string): boolean;
}

/**
 * Apply the kind, size and count limits to a folder's files, nearest
 * first - those beside the program, then each subfolder's - so a limit
 * keeps back what is furthest away. Nothing is read that a limit keeps
 * back.
 */
export async function readSiblingFiles(folder: SiblingFolder): Promise<Selection> {
  let entries: FolderEntry[];
  try {
    entries = await folder.files();
  } catch {
    return { files: [], leftOut: [], loaded: {} };
  }
  const depth = (name: string) => name.split("/").length;
  const ordered = entries
    .filter((entry) => isMountableName(entry.name))
    .sort((a, b) => depth(a.name) - depth(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const files: WorkspaceFile[] = [];
  const leftOut: LeftOut[] = [];
  const loaded: Record<string, FileStamp> = {};
  let total = 0;
  for (const entry of ordered) {
    if (files.length >= MAX_FILES) {
      leftOut.push({ name: entry.name, reason: "count" });
      continue;
    }
    if (entry.size > MAX_FILE_BYTES) {
      leftOut.push({ name: entry.name, reason: "size" });
      continue;
    }
    let contents: Uint8Array | string;
    try {
      contents = await folder.read(entry.name);
    } catch (err) {
      leftOut.push({ name: entry.name, reason: "unreadable", detail: errorCode(err) });
      continue;
    }
    // An editor's buffer may have grown past the file on disk.
    const size = contentsByteLength(contents);
    if (size > MAX_FILE_BYTES) {
      leftOut.push({ name: entry.name, reason: "size" });
      continue;
    }
    if (total + size > MAX_TOTAL_BYTES) {
      leftOut.push({ name: entry.name, reason: "total" });
      continue;
    }
    files.push({ name: entry.name, contents });
    loaded[entry.name] = { size: entry.size, mtimeMs: entry.mtimeMs };
    total += size;
  }
  return { files, leftOut, loaded };
}

/** What happened to the files a run changed. */
export interface WriteBackResult {
  written: string[];
  deleted: string[];
  leftOut: LeftOut[];
}

/**
 * Save what a run changed, deleting what it deleted - but only what it is
 * safe to: never a file that is on disk and was not given to the program
 * (the program never saw it, so writing would replace it), never one that
 * changed on disk while it ran, never an existing `.py`, never into a
 * hidden folder, and within the same limits as loading. Every file not
 * saved is named, with why.
 */
export async function writeSiblingFiles(
  folder: SiblingFolder,
  changes: WorkspaceChanges,
  loaded: Record<string, FileStamp>,
): Promise<WriteBackResult> {
  const written: string[] = [];
  const deleted: string[] = [];
  const leftOut: LeftOut[] = [];
  let total = 0;

  /** Why `name` may not be touched, as it is on disk now, or null. */
  const refusal = async (name: string): Promise<LeftOut["reason"] | null> => {
    if (!isSafePath(name)) return "hidden";
    if (isHiddenPath(name)) return "hidden";
    if (folder.unsaved?.(name)) return "unsaved";
    const now = await folder.stat(name).catch(() => null);
    const before = loaded[name];
    if (now !== null && extensionOf(name) === ".py") return "python";
    if (before === undefined) return now === null ? null : "notLoaded";
    if (now === null || now.size !== before.size || now.mtimeMs !== before.mtimeMs) return "changed";
    return null;
  };

  for (const file of [...changes.files].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const reason = await refusal(file.name);
    if (reason !== null) {
      leftOut.push({ name: file.name, reason });
      continue;
    }
    const bytes = contentsBytes(file.contents);
    if (written.length >= MAX_FILES) {
      leftOut.push({ name: file.name, reason: "count" });
      continue;
    }
    if (bytes.byteLength > MAX_FILE_BYTES) {
      leftOut.push({ name: file.name, reason: "size" });
      continue;
    }
    if (total + bytes.byteLength > MAX_TOTAL_BYTES) {
      leftOut.push({ name: file.name, reason: "total" });
      continue;
    }
    try {
      await folder.write(file.name, bytes);
      written.push(file.name);
      total += bytes.byteLength;
    } catch (err) {
      leftOut.push({ name: file.name, reason: "failed", detail: errorCode(err) });
    }
  }
  for (const name of [...changes.deleted].sort()) {
    const reason = await refusal(name);
    if (reason !== null) {
      leftOut.push({ name, reason });
      continue;
    }
    try {
      await folder.remove(name);
      deleted.push(name);
    } catch (err) {
      leftOut.push({ name, reason: "failed", detail: errorCode(err) });
    }
  }
  return { written, deleted, leftOut };
}

/** A short reason from a filesystem error: `permission denied`, not a stack. */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  const byCode: Record<string, string> = {
    EACCES: "permission denied",
    EPERM: "permission denied",
    EROFS: "read-only file system",
    ENOSPC: "no space left",
    EISDIR: "a folder is in the way",
    ENOTDIR: "a file is in the way",
    NoPermissions: "permission denied",
  };
  if (typeof code === "string" && byCode[code]) return byCode[code];
  const message = err instanceof Error ? err.message : String(err);
  return message.split("\n")[0].slice(0, 80);
}
