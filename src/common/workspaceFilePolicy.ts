/**
 * Rules for which sibling files PLL mounts into Pyodide and writes back
 * to the workspace. Kept free of vscode so smoke tests can import it.
 */

export interface WorkspaceFile {
  /** Basename only (`library_loans.csv`). Never a path. */
  name: string;
  /**
   * Text for the file kinds a program reads as text, raw bytes for the
   * picture formats. `load_image("cat.png")` needs the bytes intact, and
   * decoding a PNG as UTF-8 destroys it.
   */
  contents: string | Uint8Array;
}

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_FILES = 100;

/** A file a limit kept back, and which limit. */
export interface LeftOut {
  name: string;
  reason: "count" | "size" | "total" | "notText";
}

/** The files a limit let through, and those it kept back. */
export interface Selection {
  files: WorkspaceFile[];
  leftOut: LeftOut[];
}

const MB = 1024 * 1024;

/** Why a file was kept back, as the end of a sentence. */
const WHY_LEFT_OUT: Record<LeftOut["reason"], string> = {
  count: `at most ${MAX_FILES} files next to a program are`,
  size: `each file can be at most ${MAX_FILE_BYTES / MB} MB`,
  total: `the files together can be at most ${MAX_TOTAL_BYTES / MB} MB`,
  notText: "a text file has to hold text",
};

/**
 * What to say about the files a limit kept back - one sentence per limit -
 * so that a program that cannot open or import one is not left to fail
 * with no reason given. `action` is what did not happen to them.
 */
export function leftOutNotes(leftOut: LeftOut[], action: "loaded" | "saved"): string[] {
  const notes: string[] = [];
  for (const reason of Object.keys(WHY_LEFT_OUT) as LeftOut["reason"][]) {
    const names = leftOut.filter((file) => file.reason === reason).map((file) => file.name);
    if (names.length === 0) {
      continue;
    }
    const shown = names.slice(0, 5).join(", ");
    const more = names.length > 5 ? ` and ${names.length - 5} more` : "";
    notes.push(`Not ${action}: ${shown}${more} - ${WHY_LEFT_OUT[reason]}.`);
  }
  return notes;
}

const MOUNT_EXTENSIONS = new Set([
  ".csv",
  ".txt",
  ".tsv",
  ".json",
  ".md",
  ".dat",
  ".xml",
  ".py",
  // Pictures, for `load_image`. `.svg` is not in BINARY_EXTENSIONS below
  // because it is text, and mounting it as text is lossless.
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
]);

/**
 * Mounted as bytes rather than decoded. The size caps are deliberately
 * left where they were: these are for the graphics a program draws with,
 * not for photographs.
 */
const BINARY_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** Written back after a run. `.py` is mounted for `open` / imports, not overwritten. */
const WRITEBACK_EXTENSIONS = new Set([
  ".csv",
  ".txt",
  ".tsv",
  ".json",
  ".md",
  ".dat",
  ".xml",
]);

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return "";
  }
  return name.slice(dot).toLowerCase();
}

export function isSafeBasename(name: string): boolean {
  if (!name || name === "." || name === "..") {
    return false;
  }
  if (name.startsWith(".")) {
    return false;
  }
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
    return false;
  }
  return true;
}

export function isMountableName(name: string): boolean {
  return isSafeBasename(name) && MOUNT_EXTENSIONS.has(extensionOf(name));
}

export function isWritebackName(name: string): boolean {
  return isSafeBasename(name) && WRITEBACK_EXTENSIONS.has(extensionOf(name));
}

/** True when this name is mounted as raw bytes instead of as text. */
export function isBinaryMountName(name: string): boolean {
  return BINARY_EXTENSIONS.has(extensionOf(name));
}

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** Size on the wire, whichever form the contents are in. */
export function contentsByteLength(contents: string | Uint8Array): number {
  return typeof contents === "string"
    ? utf8ByteLength(contents)
    : contents.byteLength;
}

/**
 * Decode workspace bytes as text. Returns undefined for empty names,
 * oversize files, or content that looks binary (NUL bytes).
 */
export function decodeMountContents(data: Uint8Array): string | undefined {
  if (data.byteLength > MAX_FILE_BYTES) {
    return undefined;
  }
  for (let i = 0; i < data.byteLength; i++) {
    if (data[i] === 0) {
      return undefined;
    }
  }
  return new TextDecoder("utf-8").decode(data);
}

export interface MountCandidate {
  name: string;
  contents: string | Uint8Array;
}

/**
 * Apply extension / size / count limits to a directory listing.
 * Callers resolve editor-vs-disk contents before passing them in. A file of
 * a kind a program does not read is not one kept back.
 */
export function selectMountableFiles(candidates: MountCandidate[]): Selection {
  const selected: WorkspaceFile[] = [];
  const leftOut: LeftOut[] = [];
  let total = 0;
  for (const candidate of candidates) {
    if (!isMountableName(candidate.name)) {
      continue;
    }
    if (selected.length >= MAX_FILES) {
      leftOut.push({ name: candidate.name, reason: "count" });
      continue;
    }
    let contents: string | Uint8Array;
    if (isBinaryMountName(candidate.name)) {
      // Kept as bytes. The NUL check below is what rejects binary content
      // in a *text* file; applying it here would reject every picture.
      const raw =
        typeof candidate.contents === "string"
          ? new TextEncoder().encode(candidate.contents)
          : candidate.contents;
      if (raw.byteLength > MAX_FILE_BYTES) {
        leftOut.push({ name: candidate.name, reason: "size" });
        continue;
      }
      contents = raw;
    } else if (typeof candidate.contents === "string") {
      if (utf8ByteLength(candidate.contents) > MAX_FILE_BYTES) {
        leftOut.push({ name: candidate.name, reason: "size" });
        continue;
      }
      if (candidate.contents.includes("\0")) {
        leftOut.push({ name: candidate.name, reason: "notText" });
        continue;
      }
      contents = candidate.contents;
    } else {
      const decoded = decodeMountContents(candidate.contents);
      if (decoded === undefined) {
        leftOut.push({ name: candidate.name, reason: candidate.contents.byteLength > MAX_FILE_BYTES ? "size" : "notText" });
        continue;
      }
      contents = decoded;
    }
    const size = contentsByteLength(contents);
    if (total + size > MAX_TOTAL_BYTES) {
      leftOut.push({ name: candidate.name, reason: "total" });
      continue;
    }
    selected.push({ name: candidate.name, contents });
    total += size;
  }
  return { files: selected, leftOut };
}

export function selectWritebackFiles(files: WorkspaceFile[]): Selection {
  const selected: WorkspaceFile[] = [];
  const leftOut: LeftOut[] = [];
  let total = 0;
  for (const file of files) {
    // Writeback is text only - no picture extension is writeback-eligible -
    // so anything arriving as bytes here is not ours to write back.
    if (!isWritebackName(file.name) || typeof file.contents !== "string") {
      continue;
    }
    if (selected.length >= MAX_FILES) {
      leftOut.push({ name: file.name, reason: "count" });
      continue;
    }
    const size = utf8ByteLength(file.contents);
    if (size > MAX_FILE_BYTES) {
      leftOut.push({ name: file.name, reason: "size" });
      continue;
    }
    if (total + size > MAX_TOTAL_BYTES) {
      leftOut.push({ name: file.name, reason: "total" });
      continue;
    }
    if (file.contents.includes("\0")) {
      leftOut.push({ name: file.name, reason: "notText" });
      continue;
    }
    selected.push(file);
    total += size;
  }
  return { files: selected, leftOut };
}

/**
 * A script's folder, as a host reaches it: the editor through
 * `vscode.workspace.fs`, the command line through Node's. Everything else
 * about sibling files - which, how many, how big - is decided here, so
 * `open("data.csv")` sees the same files in both.
 */
export interface SiblingFolder {
  /** The names of the plain files in it. */
  files(): Promise<string[]>;
  read(name: string): Promise<string | Uint8Array>;
  write(name: string, text: string): Promise<void>;
}

/** The files a program in `folder` gets to read, within the limits. */
export async function readSiblingFiles(folder: SiblingFolder): Promise<Selection> {
  let names: string[];
  try {
    names = await folder.files();
  } catch {
    return { files: [], leftOut: [] };
  }
  const candidates: MountCandidate[] = [];
  for (const name of names) {
    if (!isMountableName(name)) {
      continue;
    }
    try {
      candidates.push({ name, contents: await folder.read(name) });
    } catch {
      /* skip unreadable files */
    }
  }
  return selectMountableFiles(candidates);
}

/** Write back the files a run changed or made: the names written, and those a limit kept back. */
export async function writeSiblingFiles(
  folder: SiblingFolder,
  files: WorkspaceFile[],
): Promise<{ written: string[]; leftOut: LeftOut[] }> {
  const written: string[] = [];
  const { files: selected, leftOut } = selectWritebackFiles(files);
  for (const file of selected) {
    try {
      // `selectWritebackFiles` keeps text only: no picture is written back.
      await folder.write(file.name, file.contents as string);
      written.push(file.name);
    } catch {
      /* skip files the host refuses to write */
    }
  }
  return { written, leftOut };
}
