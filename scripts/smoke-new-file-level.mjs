#!/usr/bin/env node
/**
 * Seeding new `.py` files with a `#level` header.
 *
 * `vscode` is aliased to a stub with an in-memory filesystem and a
 * fire-able `onDidCreateFiles`, so this is pure logic: which files get a
 * header, which are left alone, and that what gets written parses back to
 * the level that was asked for.
 */
import { build } from "esbuild";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

let ok = true;
function expect(cond, msg) {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    ok = false;
  }
}

const VSCODE_STUB = `
class Uri {
  constructor(path) { this.path = path; }
  static file(p) { return new Uri(p); }
  toString() { return "file:" + this.path; }
}

/** In-memory disk, keyed by path. Tests read and seed it directly. */
export const disk = new Map();
export let settings = { newFileLevel: "none" };
export function __setSetting(key, value) { settings[key] = value; }

let createListener = null;
/** Pretend the user created these files. */
export async function __fireCreate(uris) {
  createListener?.({ files: uris });
  // Let the handler's awaits settle.
  await new Promise((r) => setTimeout(r, 5));
}

export const workspace = {
  getConfiguration(section) {
    return {
      get(key, fallback) {
        if (section !== "pll") return fallback;
        return settings[key] ?? fallback;
      },
    };
  },
  onDidCreateFiles(listener) {
    createListener = listener;
    return { dispose() { createListener = null; } };
  },
  fs: {
    async readFile(uri) {
      if (!disk.has(uri.path)) throw new Error("ENOENT " + uri.path);
      return new TextEncoder().encode(disk.get(uri.path));
    },
    async writeFile(uri, bytes) {
      disk.set(uri.path, new TextDecoder().decode(bytes));
    },
  },
};

export { Uri };
`;

async function load() {
  const tmp = mkdtempSync(join(ROOT, ".smoke-"));
  writeFileSync(join(tmp, "vscode.mjs"), VSCODE_STUB);
  writeFileSync(
    join(tmp, "entry.mjs"),
    `
export { registerNewFileLevel, headerFor } from "../src/common/newFileLevel";
export { parseLevel } from "../src/common/level";
export * as vscodeStub from "./vscode.mjs";
`,
  );
  await build({
    entryPoints: [join(tmp, "entry.mjs")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: join(tmp, "out.mjs"),
    alias: { vscode: join(tmp, "vscode.mjs") },
    absWorkingDir: ROOT,
  });
  const mod = await import(pathToFileURL(join(tmp, "out.mjs")).href);
  rmSync(tmp, { recursive: true, force: true });
  return mod;
}

const { registerNewFileLevel, headerFor, parseLevel, vscodeStub } = await load();
const { Uri, disk, __setSetting, __fireCreate } = vscodeStub;

/** Create `path` with `content` on the fake disk, then fire the event. */
async function create(path, content = "") {
  disk.set(path, content);
  await __fireCreate([Uri.file(path)]);
  return disk.get(path);
}

const watcher = registerNewFileLevel();

console.log("\n[1] an empty new .py file gets the configured header");
__setSetting("newFileLevel", "beginner");
{
  const after = await create("/w/hw1.py");
  expect(after === "#level beginner\n\n", "got " + JSON.stringify(after));
  expect(parseLevel(after) === "beginner", "what we wrote must parse back as beginner");
  console.log(`    ${JSON.stringify(after)} -> parseLevel ${parseLevel(after)}`);
}

console.log("\n[2] every level round-trips through the parser");
for (const level of ["raw", "beginner", "intermediate", "advanced"]) {
  __setSetting("newFileLevel", level);
  const after = await create(`/w/rt-${level}.py`);
  expect(after === headerFor(level), `${level}: got ${JSON.stringify(after)}`);
  expect(parseLevel(after) === level, `${level}: parsed back as ${parseLevel(after)}`);
}
console.log("    raw, beginner, intermediate, advanced all round-trip");

console.log("\n[3] a file that already has content is never touched");
__setSetting("newFileLevel", "beginner");
{
  const original = "print('copied in')\n";
  const after = await create("/w/copied.py", original);
  expect(after === original, "existing content must survive, got " + JSON.stringify(after));
}

console.log("\n[4] a whitespace-only file counts as empty");
{
  const after = await create("/w/blankish.py", "\n\n   \n");
  expect(after === "#level beginner\n\n", "got " + JSON.stringify(after));
}

console.log("\n[5] non-Python files are left alone");
{
  const after = await create("/w/notes.txt", "");
  expect(after === "", "a .txt must not get a Python header, got " + JSON.stringify(after));
}

console.log("\n[6] `none` (the default) writes nothing");
__setSetting("newFileLevel", "none");
{
  const after = await create("/w/untouched.py");
  expect(after === "", "nothing should be written, got " + JSON.stringify(after));
}

console.log("\n[7] an unrecognised setting value is treated as `none`");
__setSetting("newFileLevel", "expert");
{
  const after = await create("/w/bogus.py");
  expect(after === "", "a bad setting must not write anything, got " + JSON.stringify(after));
}

console.log("\n[8] the setting is read per event, so no reload is needed");
__setSetting("newFileLevel", "advanced");
{
  const after = await create("/w/later.py");
  expect(after === "#level advanced\n\n", "got " + JSON.stringify(after));
}

watcher.dispose();

console.log(`\nsmoke-new-file-level: ${ok ? "ok" : "FAILED"}`);
if (!ok) process.exit(1);
