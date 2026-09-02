import {
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
  stat(path: string): { mode: number; size: number };
  isFile(mode: number): boolean;
  unlink(path: string): void;
}

let lastMounted = new Map<string, string>();

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
    if (utf8ByteLength(file.contents) > MAX_FILE_BYTES) {
      continue;
    }
    FS.writeFile(joinCwd(FS, file.name), file.contents);
    lastMounted.set(file.name, file.contents);
  }
}

/**
 * Files in the work dir that are eligible for writeback and differ from
 * (or were not in) the last mount snapshot.
 */
export function collectChangedWorkspaceFiles(FS: MemFS): WorkspaceFile[] {
  ensureWorkDir(FS);
  const out: WorkspaceFile[] = [];
  for (const name of listRegularFiles(FS)) {
    if (!isWritebackName(name)) {
      continue;
    }
    let contents: string;
    try {
      const raw = FS.readFile(joinCwd(FS, name), { encoding: "utf8" });
      contents = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    } catch {
      continue;
    }
    if (utf8ByteLength(contents) > MAX_FILE_BYTES) {
      continue;
    }
    if (lastMounted.get(name) === contents) {
      continue;
    }
    out.push({ name, contents });
  }
  return out;
}
