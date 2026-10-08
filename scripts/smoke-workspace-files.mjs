#!/usr/bin/env node
/**
 * Smoke test for sibling-folder files: policy filters, MEMFS mount/collect,
 * and the Python students write (`open`, `pd.read_csv` / `to_csv`).
 *
 * Requires `pnpm run build` so out/test/*.js exists.
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { expect, passed } from "./lib/check.mjs";
import { bootPll } from "./lib/pyodide.mjs";
import { ROOT } from "./lib/bundle.mjs";

const POLICY_PATH = resolve(ROOT, "out/test/workspaceFilePolicy.js");
const MEMFS_PATH = resolve(ROOT, "out/test/memfsWorkspace.js");

const CARS_CSV = "name,mpg\nvw,29\nhonda,33\nford,18\n";

function requireBuilt(path) {
  if (!existsSync(path)) {
    console.error(`Missing ${path}. Run \`pnpm run build\` first.`);
    process.exit(1);
  }
  return createRequire(import.meta.url)(path);
}

const policy = requireBuilt(POLICY_PATH);
const memfs = requireBuilt(MEMFS_PATH);

const bytes = (text) => new TextEncoder().encode(text);
const text = (contents) => (typeof contents === "string" ? contents : new TextDecoder().decode(contents));

/**
 * A program's folder in memory, as a host would reach it: `files` maps a
 * path to its bytes. `stamps` can be moved to stand for a file changed on
 * disk; `unsaved` and `failing` name files open with changes, and files a
 * write of fails.
 */
function fakeFolder(files, { unsaved = [], failing = {} } = {}) {
  const disk = new Map(Object.entries(files).map(([name, contents]) => [name, bytes(contents)]));
  const stamps = new Map([...disk.keys()].map((name) => [name, 1000]));
  let reads = 0;
  return {
    disk,
    stamps,
    reads: () => reads,
    folder: {
      async files() {
        return [...disk].map(([name, b]) => ({ name, size: b.byteLength, mtimeMs: stamps.get(name) }));
      },
      async read(name) {
        reads++;
        if (failing[name] === "read") throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        return disk.get(name);
      },
      async stat(name) {
        return disk.has(name) ? { size: disk.get(name).byteLength, mtimeMs: stamps.get(name) } : null;
      },
      async write(name, b) {
        if (failing[name] === "write") throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        disk.set(name, b);
        stamps.set(name, 2000);
      },
      async remove(name) {
        disk.delete(name);
      },
      unsaved: (name) => unsaved.includes(name),
    },
  };
}

async function testPolicy() {
  console.log("\n[1] which files are given, and which saved");

  expect(policy.isSafePath("library_loans.csv") === true, "a plain name is safe");
  expect(policy.isSafePath("data/2024.csv") === true, "a path into a subfolder is safe");
  for (const bad of ["../secret.csv", "data/../../x.csv", "/etc/passwd", "a\\b.csv", "", "a//b.csv", "./a.csv"]) {
    expect(policy.isSafePath(bad) === false, `${JSON.stringify(bad)} is not safe`);
  }
  expect(policy.isHiddenPath(".git/config") && policy.isHiddenPath("__pycache__/a.pyc"), "tool folders are hidden");
  expect(policy.isHiddenPath(".hidden.csv") && !policy.isHiddenPath("data/cars.csv"), "a dotfile is hidden, a data file not");
  for (const name of ["data.csv", "helper.py", "photo.png", "badge.svg", "data/2024.csv", "notes.md", "nums.dat"]) {
    expect(policy.isMountableName(name) === true, `${name} is given to the program`);
  }
  for (const name of [".hidden.csv", ".git/config", "venv/lib/x.py", "report.docx", "a.pyc"]) {
    expect(policy.isMountableName(name) === false, `${name} is not`);
  }

  // Bytes both ways: a PNG's 0x89, a Latin-1 0xff and a NUL arrive as they are.
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]);
  const latin = fakeFolder({ "data/cities.csv": "name\n", "cars.csv": "a\n", "z.txt": "z", "notes.docx": "no" });
  latin.disk.set("cat.png", png);
  latin.disk.set("latin.csv", new Uint8Array([0xff, 0x00, 0x41]));
  latin.stamps.set("cat.png", 1000).set("latin.csv", 1000);
  const given = await policy.readSiblingFiles(latin.folder);
  expect(
    given.files.map((f) => f.name).join() === "cars.csv,cat.png,latin.csv,z.txt,data/cities.csv",
    `beside the program first, then each subfolder's: ${given.files.map((f) => f.name).join()}`,
  );
  const picture = given.files.find((f) => f.name === "cat.png").contents;
  expect(picture instanceof Uint8Array && picture[0] === 0x89, "a picture keeps its bytes");
  const raw = given.files.find((f) => f.name === "latin.csv").contents;
  expect(raw instanceof Uint8Array && raw[0] === 0xff && raw[1] === 0x00, "a file that is not UTF-8 keeps its bytes");
  expect(given.leftOut.length === 0, `a kind not given is not one kept back: ${JSON.stringify(given.leftOut)}`);
  expect(
    JSON.stringify(given.loaded["cars.csv"]) === JSON.stringify({ size: 2, mtimeMs: 1000 }),
    `how each was on disk is kept: ${JSON.stringify(given.loaded)}`,
  );

  // A size the listing says is too big is never read.
  const big = fakeFolder({ "big.csv": "x".repeat(policy.MAX_FILE_BYTES + 1) });
  const oversize = await policy.readSiblingFiles(big.folder);
  expect(oversize.files.length === 0 && oversize.leftOut[0]?.reason === "size", "an oversize file is kept back");
  expect(big.reads() === 0, `and not read: ${big.reads()} reads`);

  const unreadable = await policy.readSiblingFiles(fakeFolder({ "a.csv": "a" }, { failing: { "a.csv": "read" } }).folder);
  expect(
    policy.leftOutNotes(unreadable.leftOut, "loaded")[0] === "Not loaded: a.csv (permission denied) - it could not be read.",
    `a file that cannot be read is named, with why: ${policy.leftOutNotes(unreadable.leftOut, "loaded")}`,
  );

  // At most MAX_FILES, the furthest kept back, and the rest said.
  expect(policy.MAX_FILES === 100, `the limit: ${policy.MAX_FILES}`);
  const manyFiles = Object.fromEntries(
    Array.from({ length: 107 }, (_, i) => [i < 5 ? `deep/f${i}.csv` : `f${String(i).padStart(3, "0")}.csv`, "a\n"]),
  );
  const counted = await policy.readSiblingFiles(fakeFolder(manyFiles).folder);
  expect(
    counted.files.length === 100 && counted.leftOut.length === 7 && counted.leftOut.every((f) => f.reason === "count"),
    `100 mounted and 7 kept back: ${counted.files.length} ${JSON.stringify(counted.leftOut)}`,
  );
  const [note] = policy.leftOutNotes(counted.leftOut, "loaded");
  expect(
    note === "Not loaded: f105.csv, f106.csv, deep/f0.csv, deep/f1.csv, deep/f2.csv and 2 more - at most 100 files next to a program are.",
    `said once, naming them, the subfolder's last: ${note}`,
  );
  const almost = "x".repeat(policy.MAX_FILE_BYTES - 10);
  const total = await policy.readSiblingFiles(
    fakeFolder(Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`b${i}.csv`, almost]))).folder,
  );
  expect(
    total.files.length === 4 && total.leftOut.map((f) => `${f.name}:${f.reason}`).join() === "b4.csv:total",
    `the total kept: ${JSON.stringify(total.leftOut)}`,
  );
  expect(
    policy.leftOutNotes(total.leftOut, "loaded")[0] === "Not loaded: b4.csv - the files together can be at most 8 MB.",
    `and said: ${policy.leftOutNotes(total.leftOut, "loaded")[0]}`,
  );

  console.log("\n[1b] saving what a run changed");
  const home = fakeFolder(
    {
      "cars.csv": "old\n",
      "moved.csv": "old\n",
      "history.txt": "precious\n",
      "helper.py": "VALUE = 1\n",
      "gone.txt": "x\n",
      "keep.py": "print(1)\n",
      "open.csv": "a\n",
      "locked.csv": "a\n",
    },
    { unsaved: ["open.csv"], failing: { "locked.csv": "write" } },
  );
  const { loaded } = await policy.readSiblingFiles(home.folder);
  // history.txt was kept back (say, by a limit): the program never saw it.
  delete loaded["history.txt"];
  home.stamps.set("moved.csv", 1500);
  const result = await policy.writeSiblingFiles(
    home.folder,
    {
      files: [
        { name: "cars.csv", contents: bytes("new\n") },
        { name: "moved.csv", contents: bytes("mine\n") },
        { name: "history.txt", contents: bytes("new entry\n") },
        { name: "helper.py", contents: bytes("oops") },
        { name: "made.py", contents: bytes("print(2)\n") },
        { name: "out/result.txt", contents: bytes("done\n") },
        { name: "nums.dat", contents: new Uint8Array([1, 0, 0, 0, 0xff]) },
        { name: ".git/config", contents: bytes("x") },
        { name: "open.csv", contents: bytes("b\n") },
        { name: "locked.csv", contents: bytes("b\n") },
      ],
      deleted: ["gone.txt", "keep.py"],
    },
    loaded,
  );
  expect(
    result.written.join() === "cars.csv,made.py,nums.dat,out/result.txt",
    `new files, subfolders and unchanged loaded ones are saved: ${result.written.join()}`,
  );
  expect(text(home.disk.get("history.txt")) === "precious\n", "a file the program never saw is not replaced");
  expect(text(home.disk.get("moved.csv")) === "old\n", "nor one changed on disk while it ran");
  expect(text(home.disk.get("helper.py")) === "VALUE = 1\n", "nor an existing .py");
  expect(home.disk.get("nums.dat").join() === "1,0,0,0,255", `bytes are saved as written: ${home.disk.get("nums.dat")}`);
  expect(result.deleted.join() === "gone.txt" && !home.disk.has("gone.txt"), `a deletion is carried back: ${result.deleted}`);
  expect(home.disk.has("keep.py"), "but never of a .py");
  const reasons = result.leftOut.map((f) => `${f.name}:${f.reason}`).sort().join();
  expect(
    reasons ===
      ".git/config:hidden,helper.py:python,history.txt:notLoaded,keep.py:python,locked.csv:failed,moved.csv:changed,open.csv:unsaved",
    `each file not saved, with why: ${reasons}`,
  );
  const notes = policy.leftOutNotes(result.leftOut, "saved");
  for (const expected of [
    "Not saved: history.txt - it was not loaded, so saving it would replace a file the program never saw.",
    "Not saved: moved.csv - it changed on disk while the program ran.",
    "Not saved: helper.py, keep.py - PLL never overwrites or deletes a .py file.",
    "Not saved: open.csv - it has unsaved changes in the editor; save it and run again.",
    "Not saved: locked.csv (permission denied) - it could not be written.",
  ]) {
    expect(notes.includes(expected), `said: ${expected}\n      got: ${JSON.stringify(notes)}`);
  }

  const lots = Object.fromEntries(Object.entries(manyFiles).map(([name]) => [name, bytes("a\n")]));
  const tooMany = await policy.writeSiblingFiles(
    fakeFolder({}).folder,
    { files: Object.entries(lots).map(([name, contents]) => ({ name, contents })), deleted: [] },
    {},
  );
  expect(
    tooMany.written.length === 100 && policy.leftOutNotes(tooMany.leftOut, "saved")[0]?.startsWith("Not saved: f100.csv"),
    `writing back past the limit is said too: ${JSON.stringify(policy.leftOutNotes(tooMany.leftOut, "saved"))}`,
  );
  console.log("    paths, kinds, limits, bytes, refusals and deletions ok");
}

async function testMemfsAndPython() {
  const pyodide = await bootPll();
  const FS = pyodide.FS;

  console.log("\n[2] mount sibling csv; open() reads it");
  memfs.mountWorkspaceFiles(FS, [
    { name: "cars.csv", contents: CARS_CSV },
    { name: "helper.py", contents: "VALUE = 7\n" },
    { name: "data/2024.csv", contents: bytes("year\n2024\n") },
    { name: "old.txt", contents: bytes("x\n") },
    { name: "../escape.csv", contents: "should not land in cwd\n" },
  ]);
  expect(FS.cwd() === memfs.PLL_WORK_DIR, "cwd should be the PLL work dir, got " + FS.cwd());

  const listed = FS.readdir(FS.cwd()).filter((n) => n !== "." && n !== "..");
  expect(listed.includes("cars.csv"), "cars.csv should be mounted");
  expect(listed.includes("helper.py"), "helper.py should be mounted");
  expect(!listed.includes("escape.csv") && !listed.includes(".."), "path traversal must not mount");
  expect(text(FS.readFile(`${memfs.PLL_WORK_DIR}/data/2024.csv`)) === "year\n2024\n", "a subfolder's file is mounted in it");

  const readCode = [
    "with open('cars.csv', 'r') as f:",
    "    lines = f.readlines()",
    "print(lines[0].strip())",
    "print(len(lines) - 1)",
  ].join("\n");
  const readOut = String(pyodide.runPython(`
import sys, io
_buf = io.StringIO()
_old = sys.stdout
sys.stdout = _buf
${readCode}
sys.stdout = _old
_buf.getvalue()
`));
  console.log(`    stdout=${JSON.stringify(readOut)}`);
  expect(readOut.includes("name,mpg"), "open() should read the header");
  expect(readOut.includes("3"), "open() should see 3 data rows");

  console.log("\n[3] unread files are not collected; open('w') is, even if bytes match");
  const unchanged = memfs.collectChangedWorkspaceFiles(FS);
  expect(
    unchanged.files.length === 0 && unchanged.deleted.length === 0,
    "fresh mount should collect nothing, got " + JSON.stringify(unchanged),
  );

  pyodide.runPython(`
with open('efficient_cars.csv', 'w') as f:
    f.write('name,mpg\\n')
    f.write('honda,33\\n')
with open('cars.csv', 'w') as f:
    f.write(${JSON.stringify(CARS_CSV)})
with open('helper.py', 'w') as f:
    f.write('VALUE = 99\\n')
import os, struct
os.makedirs('out/deep', exist_ok=True)
with open('out/deep/nums.dat', 'wb') as f:
    f.write(struct.pack('<2i', 1, 300))
os.remove('old.txt')
`);
  const changed = memfs.collectChangedWorkspaceFiles(FS);
  const names = changed.files.map((f) => f.name).sort();
  console.log(`    collected=${JSON.stringify(names)} deleted=${JSON.stringify(changed.deleted)}`);
  expect(names.includes("efficient_cars.csv"), "new csv should be collected");
  expect(names.includes("cars.csv"), "rewriting the same csv contents should still collect");
  // Collected, so that saving can say why it is not saved over the original.
  expect(names.includes("helper.py"), "a rewritten .py is collected");
  expect(!names.includes("data/2024.csv"), "an untouched subfolder file is not");
  const efficient = changed.files.find((f) => f.name === "efficient_cars.csv");
  expect(
    efficient !== undefined && text(efficient.contents).includes("honda,33"),
    "efficient_cars.csv should contain the honda row",
  );
  const packed = changed.files.find((f) => f.name === "out/deep/nums.dat");
  expect(
    packed?.contents instanceof Uint8Array && packed.contents.join() === "1,0,0,0,44,1,0,0",
    `binary output in a new subfolder arrives as its bytes: ${packed?.contents}`,
  );
  expect(JSON.stringify(changed.deleted) === '["old.txt"]', `a deleted file is collected as deleted: ${changed.deleted}`);

  console.log("\n[4] remount clears leftovers from a previous folder");
  memfs.mountWorkspaceFiles(FS, [{ name: "other.txt", contents: "only\n" }]);
  const afterRemount = FS.readdir(FS.cwd()).filter((n) => n !== "." && n !== "..");
  expect(afterRemount.includes("other.txt"), "new mount should include other.txt");
  expect(!afterRemount.includes("cars.csv"), "previous cars.csv should be gone");
  expect(!afterRemount.includes("efficient_cars.csv"), "previous output should be gone");
  expect(!afterRemount.includes("out") && !afterRemount.includes("data"), "and previous folders");

  console.log("\n[5] pandas read_csv / to_csv on a mounted file");
  memfs.mountWorkspaceFiles(FS, [{ name: "cars.csv", contents: CARS_CSV }]);
  const pandasCode = [
    "import pandas as pd",
    "df = pd.read_csv('cars.csv')",
    "print(len(df), df[df['mpg'] >= 30]['name'].tolist())",
    "df[df['mpg'] >= 30].to_csv('efficient_pandas.csv', index=False)",
  ].join("\n");
  await pyodide.loadPackagesFromImports(pandasCode);
  const pandasOut = String(pyodide.runPython(`
import sys, io
_buf = io.StringIO()
_old = sys.stdout
sys.stdout = _buf
${pandasCode}
sys.stdout = _old
_buf.getvalue()
`));
  console.log(`    stdout=${JSON.stringify(pandasOut.trim())}`);
  expect(pandasOut.includes("3") && pandasOut.includes("honda"), "pandas should filter to honda");
  const pandasChanged = memfs.collectChangedWorkspaceFiles(FS);
  const pandasFile = pandasChanged.files.find((f) => f.name === "efficient_pandas.csv");
  expect(!!pandasFile, "to_csv should produce a collectable file");
  expect(
    pandasFile !== undefined && text(pandasFile.contents).includes("honda"),
    "efficient_pandas.csv should contain honda, got " + JSON.stringify(pandasFile && text(pandasFile.contents)),
  );
  expect(
    pandasFile !== undefined && !text(pandasFile.contents).includes("ford"),
    "efficient_pandas.csv should not contain ford",
  );

  console.log("\n[6] sibling pandas.py must not shadow the pandas package");
  memfs.mountWorkspaceFiles(FS, [
    { name: "cars.csv", contents: CARS_CSV },
    {
      name: "pandas.py",
      contents: 'import pandas as pd\npd.read_csv("missing-on-purpose.csv")\n',
    },
    { name: "helper.py", contents: "VALUE = 7\n" },
  ]);
  const shadowCode = [
    "import pandas as pd",
    "import helper",
    "df = pd.read_csv('cars.csv')",
    "print(len(df), helper.VALUE)",
  ].join("\n");
  await pyodide.loadPackagesFromImports(shadowCode);
  const shadowProxy = pyodide.globals.get("_pll_run_file")(
    shadowCode,
    "files.py",
    "shadow-pandas",
  );
  const shadowJs = shadowProxy.toJs({ dict_converter: Object.fromEntries });
  shadowProxy.destroy?.();
  console.log(
    `    ok=${shadowJs.ok} stdout=${JSON.stringify(shadowJs.stdout)} error=${shadowJs.error_message || ""}`,
  );
  expect(
    shadowJs.ok === true,
    "import pandas must use the real package, not sibling pandas.py: " +
      (shadowJs.error_message || ""),
  );
  expect(
    String(shadowJs.stdout).includes("3") && String(shadowJs.stdout).includes("7"),
    "should read cars.csv and import helper.py, got " + JSON.stringify(shadowJs.stdout),
  );
}

async function main() {
  await testPolicy();
  await testMemfsAndPython();

  console.log(`\nsmoke-workspace-files: ${passed() ? "ok" : "FAILED"}`);
  if (!passed()) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
