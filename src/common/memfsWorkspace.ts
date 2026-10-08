import {
  contentsBytes,
  isSafePath,
  isWalkedFolder,
  type WorkspaceChanges,
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
  rmdir(path: string): void;
  writeFile(path: string, data: string | Uint8Array): void;
  readFile(path: string, opts?: { encoding?: string }): string | Uint8Array;
  readdir(path: string): string[];
  stat(path: string): { mode: number; size: number; mtime?: Date | number };
  utime(path: string, atime: number, mtime: number): void;
  isFile(mode: number): boolean;
  isDir(mode: number): boolean;
  unlink(path: string): void;
}

/** A file as it was mounted, to tell afterwards whether the program changed it. */
interface MountSnapshot {
  bytes: Uint8Array;
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

export function ensureWorkDir(FS: MemFS): void {
  try {
    FS.mkdir(PLL_WORK_DIR);
  } catch {
    /* already exists */
  }
  FS.chdir(PLL_WORK_DIR);
}

/** Every file under `dir`, as paths relative to it, tool folders left out. */
function walk(FS: MemFS, dir: string, prefix = ""): string[] {
  const names: string[] = [];
  for (const name of FS.readdir(dir)) {
    if (name === "." || name === "..") continue;
    const path = `${dir}/${name}`;
    let stat;
    try {
      stat = FS.stat(path);
    } catch {
      continue;
    }
    if (FS.isDir(stat.mode)) {
      if (isWalkedFolder(name)) names.push(...walk(FS, path, `${prefix}${name}/`));
    } else if (FS.isFile(stat.mode)) {
      names.push(`${prefix}${name}`);
    }
  }
  return names;
}

/** Empty the work dir, folders and all: the last run's files are not this one's. */
function clearWorkDir(FS: MemFS, dir = PLL_WORK_DIR): void {
  for (const name of FS.readdir(dir)) {
    if (name === "." || name === "..") continue;
    const path = `${dir}/${name}`;
    try {
      if (FS.isDir(FS.stat(path).mode)) {
        clearWorkDir(FS, path);
        FS.rmdir(path);
      } else {
        FS.unlink(path);
      }
    } catch {
      /* ignore */
    }
  }
}

/** Make the folders `name` is in. */
function makeFolders(FS: MemFS, name: string): void {
  const parts = name.split("/").slice(0, -1);
  let at = PLL_WORK_DIR;
  for (const part of parts) {
    at = `${at}/${part}`;
    try {
      FS.mkdir(at);
    } catch {
      /* already there */
    }
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function mountWorkspaceFiles(FS: MemFS, files: WorkspaceFile[]): void {
  ensureWorkDir(FS);
  clearWorkDir(FS);
  lastMounted = new Map();
  for (const file of files) {
    if (!isSafePath(file.name)) {
      continue;
    }
    makeFolders(FS, file.name);
    const path = `${PLL_WORK_DIR}/${file.name}`;
    const bytes = contentsBytes(file.contents);
    FS.writeFile(path, bytes);
    // Zero mtime so a later open("w") / to_csv is visible even when the
    // bytes are identical.
    try {
      FS.utime(path, 0, 0);
    } catch {
      /* keep the write-time mtime */
    }
    lastMounted.set(file.name, { bytes, mtimeMs: mtimeMs(FS.stat(path)) });
  }
}

/**
 * What the program did to the work dir since it was mounted: the files it
 * made or rewrote (an mtime that moved counts, so rewriting a file with the
 * same bytes is still a write), as bytes, and the mounted files it deleted.
 */
export function collectChangedWorkspaceFiles(FS: MemFS): WorkspaceChanges {
  ensureWorkDir(FS);
  const files: WorkspaceFile[] = [];
  const present = new Set(walk(FS, PLL_WORK_DIR));
  for (const name of present) {
    if (name.endsWith(".pyc")) continue;
    const path = `${PLL_WORK_DIR}/${name}`;
    let bytes: Uint8Array;
    let stat;
    try {
      bytes = FS.readFile(path) as Uint8Array;
      stat = FS.stat(path);
    } catch {
      continue;
    }
    const prev = lastMounted.get(name);
    if (prev && prev.mtimeMs === mtimeMs(stat) && sameBytes(prev.bytes, bytes)) {
      continue;
    }
    files.push({ name, contents: bytes });
  }
  const deleted = [...lastMounted.keys()].filter((name) => !present.has(name));
  return { files, deleted };
}
