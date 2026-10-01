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
export const MAX_FILES = 50;

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
 * Callers resolve editor-vs-disk contents before passing them in.
 */
export function selectMountableFiles(candidates: MountCandidate[]): WorkspaceFile[] {
  const selected: WorkspaceFile[] = [];
  let total = 0;
  for (const candidate of candidates) {
    if (selected.length >= MAX_FILES) {
      break;
    }
    if (!isMountableName(candidate.name)) {
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
        continue;
      }
      contents = raw;
    } else if (typeof candidate.contents === "string") {
      if (utf8ByteLength(candidate.contents) > MAX_FILE_BYTES) {
        continue;
      }
      if (candidate.contents.includes("\0")) {
        continue;
      }
      contents = candidate.contents;
    } else {
      const decoded = decodeMountContents(candidate.contents);
      if (decoded === undefined) {
        continue;
      }
      contents = decoded;
    }
    const size = contentsByteLength(contents);
    if (total + size > MAX_TOTAL_BYTES) {
      continue;
    }
    selected.push({ name: candidate.name, contents });
    total += size;
  }
  return selected;
}

export function selectWritebackFiles(files: WorkspaceFile[]): WorkspaceFile[] {
  const selected: WorkspaceFile[] = [];
  let total = 0;
  for (const file of files) {
    if (selected.length >= MAX_FILES) {
      break;
    }
    if (!isWritebackName(file.name)) {
      continue;
    }
    // Writeback is text only - no picture extension is writeback-eligible -
    // so anything arriving as bytes here is not ours to write back.
    if (typeof file.contents !== "string") {
      continue;
    }
    const size = utf8ByteLength(file.contents);
    if (size > MAX_FILE_BYTES || total + size > MAX_TOTAL_BYTES) {
      continue;
    }
    if (file.contents.includes("\0")) {
      continue;
    }
    selected.push(file);
    total += size;
  }
  return selected;
}
