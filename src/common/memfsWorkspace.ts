import {
  contentsByteLength,
  isSafeBasename,
  isWritebackName,
  MAX_FILE_BYTES,
  utf8ByteLength,
  type WorkspaceFile,
} from "./workspaceFilePolicy";

/**
 * Dedicated cwd for user `open()` / `to_csv`. Isolated from Pyodide's
 * own files under `/home/pyodide`.
 */
export const PLL_WORK_DIR = "/home/pyodide/pll_workspace";

/** Emscripten MEMFS subset used by both workers. */
export interface MemFS {
  cwd(): string;
  chdir(path: string): void;
  mkdir(path: string): void;
  writeFile(path: string, data: string | Uint8Array): void;
  readFile(path: string, opts?: { encoding?: string }): string | Uint8Array;
  readdir(path: string): string[];
  stat(path: string): { mode: number; size: number; mtime?: Date | number };
  utime(path: string, atime: number, mtime: number): void;
  isFile(mode: number): boolean;
  unlink(path: string): void;
}

interface MountSnapshot {
  /** Bytes for a picture, text for everything else - as mounted. */
  contents: string | Uint8Array;
  mtimeMs: number;
}

let lastMounted = new Map<string, MountSnapshot>();

function mtimeMs(stat: { mtime?: Date | number }): number {
  const m = stat.mtime;
  if (m instanceof Date) {
    return m.getTime();
  }
  return typeof m === "number" ? m : Number.NaN;
}

function joinCwd(FS: MemFS, name: string): string {
  const cwd = FS.cwd();
  return cwd.endsWith("/") ? `${cwd}${name}` : `${cwd}/${name}`;
}

export function ensureWorkDir(FS: MemFS): void {
  try {
    FS.mkdir(PLL_WORK_DIR);
  } catch {
    /* already exists */
  }
  FS.chdir(PLL_WORK_DIR);
}

function listRegularFiles(FS: MemFS): string[] {
  const names: string[] = [];
  for (const name of FS.readdir(FS.cwd())) {
    if (name === "." || name === "..") {
      continue;
    }
    try {
      const stat = FS.stat(joinCwd(FS, name));
      if (FS.isFile(stat.mode)) {
        names.push(name);
      }
    } catch {
      /* skip unreadable entries */
    }
  }
  return names;
}

function clearWorkDirFiles(FS: MemFS): void {
  for (const name of listRegularFiles(FS)) {
    try {
      FS.unlink(joinCwd(FS, name));
    } catch {
      /* ignore */
    }
  }
}

export function mountWorkspaceFiles(FS: MemFS, files: WorkspaceFile[]): void {
  ensureWorkDir(FS);
  clearWorkDirFiles(FS);
  lastMounted = new Map();
  for (const file of files) {
    if (!isSafeBasename(file.name)) {
      continue;
    }
    if (contentsByteLength(file.contents) > MAX_FILE_BYTES) {
      continue;
    }
    const path = joinCwd(FS, file.name);
    FS.writeFile(path, file.contents);
    // Zero mtime so a later open("w") / to_csv is visible even when the
    // bytes are identical.
    try {
      FS.utime(path, 0, 0);
    } catch {
      /* keep the write-time mtime */
    }
    lastMounted.set(file.name, {
      contents: file.contents,
      mtimeMs: mtimeMs(FS.stat(path)),
    });
  }
}

/**
 * Files in the work dir that are eligible for writeback and are new,
 * rewritten (mtime changed), or different from the last mount snapshot.
 */
export function collectChangedWorkspaceFiles(FS: MemFS): WorkspaceFile[] {
  ensureWorkDir(FS);
  const out: WorkspaceFile[] = [];
  for (const name of listRegularFiles(FS)) {
    if (!isWritebackName(name)) {
      continue;
    }
    const path = joinCwd(FS, name);
    let contents: string;
    let stat: { mode: number; size: number; mtime?: Date | number };
    try {
      const raw = FS.readFile(path, { encoding: "utf8" });
      contents = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
      stat = FS.stat(path);
    } catch {
      continue;
    }
    if (utf8ByteLength(contents) > MAX_FILE_BYTES) {
      continue;
    }
    const prev = lastMounted.get(name);
    // `isWritebackName` already excluded every picture, so a snapshot
    // reached here holds text; a byte snapshot would never compare equal
    // and the file would be written back on every run.
    if (
      prev &&
      typeof prev.contents === "string" &&
      prev.contents === contents &&
      prev.mtimeMs === mtimeMs(stat)
    ) {
      continue;
    }
    out.push({ name, contents });
  }
  return out;
}
