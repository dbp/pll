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

function testPolicy() {
  console.log("\n[1] workspace file policy");

  expect(policy.isSafeBasename("library_loans.csv") === true, "plain csv basename is safe");
  expect(policy.isSafeBasename("../secret.csv") === false, "../ should be rejected");
  expect(policy.isSafeBasename("sub/file.csv") === false, "slash should be rejected");
  expect(policy.isSafeBasename(".hidden.csv") === false, "dotfile should be rejected");
  expect(policy.isSafeBasename("..") === false, ".. should be rejected");

  expect(policy.isMountableName("data.csv") === true, "csv is mountable");
  expect(policy.isMountableName("helper.py") === true, "py is mountable");
  // Pictures mount too, for `load_image("cat.png")` - but as bytes, and
  // they are never written back.
  expect(policy.isMountableName("photo.png") === true, "png is mountable");
  expect(policy.isBinaryMountName("photo.png") === true, "png mounts as bytes");
  expect(policy.isBinaryMountName("badge.svg") === false, "svg is text, so it mounts as text");
  expect(policy.isMountableName("badge.svg") === true, "svg is mountable");
  expect(policy.isWritebackName("photo.png") === false, "a picture is never written back");
  expect(policy.isWritebackName("out.csv") === true, "csv is writeback");
  expect(policy.isWritebackName("assignment.py") === false, "py is not writeback");

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]);
  const selected = policy.selectMountableFiles([
    { name: "../x.csv", contents: "a" },
    { name: "ok.csv", contents: "a,b\n1,2\n" },
    { name: "cat.png", contents: png },
    { name: "notes.txt", contents: "hi" },
    { name: "nul.csv", contents: new Uint8Array([65, 0, 66]) },
  ]);
  expect(
    selected.map((f) => f.name).join(",") === "ok.csv,cat.png,notes.txt",
    "pictures mount alongside text, and a NUL in a csv still does not, got " +
      selected.map((f) => f.name).join(","),
  );
  const picture = selected.find((f) => f.name === "cat.png");
  // The bytes have to arrive intact: 0x89 is a PNG's first byte, and any
  // decode-then-encode round trip mangles it.
  expect(
    picture.contents instanceof Uint8Array && picture.contents[0] === 0x89,
    `a picture keeps its bytes, got ${typeof picture.contents}`,
  );
  const text = selected.find((f) => f.name === "ok.csv");
  expect(typeof text.contents === "string", "a csv still arrives as text");

  const bigPng = policy.selectMountableFiles([
    { name: "huge.png", contents: new Uint8Array(policy.MAX_FILE_BYTES + 1) },
  ]);
  expect(bigPng.length === 0, "an oversize picture is dropped, same cap as text");

  const huge = "x".repeat(policy.MAX_FILE_BYTES + 1);
  const oversize = policy.selectMountableFiles([{ name: "big.csv", contents: huge }]);
  expect(oversize.length === 0, "oversize file should be dropped");

  const writeback = policy.selectWritebackFiles([
    { name: "out.csv", contents: "a,b\n" },
    { name: "hack.py", contents: "print(1)\n" },
    { name: "../x.csv", contents: "no" },
    { name: "cat.png", contents: png },
  ]);
  expect(
    writeback.map((f) => f.name).join(",") === "out.csv",
    "selectWritebackFiles should keep data files only, got " +
      writeback.map((f) => f.name).join(","),
  );
  console.log("    safe names, extensions, size, writeback filters ok");
}

async function testMemfsAndPython() {
  const pyodide = await bootPll();
  const FS = pyodide.FS;

  console.log("\n[2] mount sibling csv; open() reads it");
  memfs.mountWorkspaceFiles(FS, [
    { name: "cars.csv", contents: CARS_CSV },
    { name: "helper.py", contents: "VALUE = 7\n" },
    { name: "../escape.csv", contents: "should not land in cwd\n" },
  ]);
  expect(FS.cwd() === memfs.PLL_WORK_DIR, "cwd should be the PLL work dir, got " + FS.cwd());

  const listed = FS.readdir(FS.cwd()).filter((n) => n !== "." && n !== "..");
  expect(listed.includes("cars.csv"), "cars.csv should be mounted");
  expect(listed.includes("helper.py"), "helper.py should be mounted");
  expect(!listed.includes("escape.csv") && !listed.includes(".."), "path traversal must not mount");

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
    unchanged.length === 0,
    "fresh mount should collect nothing, got " + JSON.stringify(unchanged.map((f) => f.name)),
  );

  pyodide.runPython(`
with open('efficient_cars.csv', 'w') as f:
    f.write('name,mpg\\n')
    f.write('honda,33\\n')
with open('cars.csv', 'w') as f:
    f.write(${JSON.stringify(CARS_CSV)})
with open('helper.py', 'w') as f:
    f.write('VALUE = 99\\n')
`);
  const changed = memfs.collectChangedWorkspaceFiles(FS);
  const names = changed.map((f) => f.name).sort();
  console.log(`    collected=${JSON.stringify(names)}`);
  expect(names.includes("efficient_cars.csv"), "new csv should be collected");
  expect(names.includes("cars.csv"), "rewriting the same csv contents should still collect");
  expect(!names.includes("helper.py"), ".py must not be written back");
  const efficient = changed.find((f) => f.name === "efficient_cars.csv");
  expect(
    efficient !== undefined && efficient.contents.includes("honda,33"),
    "efficient_cars.csv should contain the honda row",
  );

  console.log("\n[4] remount clears leftovers from a previous folder");
  memfs.mountWorkspaceFiles(FS, [{ name: "other.txt", contents: "only\n" }]);
  const afterRemount = FS.readdir(FS.cwd()).filter((n) => n !== "." && n !== "..");
  expect(afterRemount.includes("other.txt"), "new mount should include other.txt");
  expect(!afterRemount.includes("cars.csv"), "previous cars.csv should be gone");
  expect(!afterRemount.includes("efficient_cars.csv"), "previous output should be gone");

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
  const pandasFile = pandasChanged.find((f) => f.name === "efficient_pandas.csv");
  expect(!!pandasFile, "to_csv should produce a collectable file");
  expect(
    pandasFile !== undefined && pandasFile.contents.includes("honda"),
    "efficient_pandas.csv should contain honda, got " + JSON.stringify(pandasFile?.contents),
  );
  expect(
    pandasFile !== undefined && !pandasFile.contents.includes("ford"),
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
  testPolicy();
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
