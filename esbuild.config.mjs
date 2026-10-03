import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import * as esbuild from "esbuild";

const require = createRequire(import.meta.url);

/**
 * The exact Pyodide installed here, and so the one PLL is tested with: its
 * assets are copied into `vendor/pyodide` for desktop, the web host loads
 * this version from the CDN, and the CLI depends on exactly it. This is the
 * one place the version comes from.
 */
const PYODIDE_VERSION = JSON.parse(
  fs.readFileSync(require.resolve("pyodide/package.json"), "utf8"),
).version;

/** Where the web host loads that Pyodide from. */
const PYODIDE_CDN_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

/**
 * The `pll.pyodideIndexUrl` setting's default is in the manifest, which
 * cannot compute it - so the build refuses to go on when it names another
 * version, rather than ship a web extension running a Pyodide nobody tested.
 */
function checkIndexUrlDefault() {
  const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
  const declared =
    manifest.contributes?.configuration?.properties?.["pll.pyodideIndexUrl"]?.default;
  if (declared !== PYODIDE_CDN_URL) {
    throw new Error(
      `package.json: the default of pll.pyodideIndexUrl is ${JSON.stringify(declared)}, ` +
        `but the installed Pyodide is ${PYODIDE_VERSION}. Set it to ${JSON.stringify(PYODIDE_CDN_URL)}.`,
    );
  }
}

/** Files loadPyodide fetches from indexURL (JS loader is bundled into dist/). */
const PYODIDE_ASSETS = [
  "pyodide.asm.js",
  "pyodide.asm.wasm",
  "python_stdlib.zip",
  "pyodide-lock.json",
];

function copyPyodideAssets() {
  const srcDir = path.join(process.cwd(), "node_modules", "pyodide");
  const destDir = path.join(process.cwd(), "vendor", "pyodide");
  fs.mkdirSync(destDir, { recursive: true });
  for (const file of PYODIDE_ASSETS) {
    const src = path.join(srcDir, file);
    if (!fs.existsSync(src)) {
      throw new Error(`Missing Pyodide asset: ${src}`);
    }
    fs.copyFileSync(src, path.join(destDir, file));
  }
  console.log("[esbuild] copied Pyodide assets to vendor/pyodide");
}

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {esbuild.BuildOptions} */
const baseOptions = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: "info",
  legalComments: "none",
  loader: {
    ".py": "text",
    // Vendored pure-Python wheels, inlined so the worker can write them
    // into Pyodide's MEMFS without a network fetch.
    ".whl": "base64",
  },
};

/** @type {esbuild.BuildOptions} */
const desktopOptions = {
  ...baseOptions,
  entryPoints: ["src/desktop/extension.ts"],
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: ["node18"],
  external: ["vscode"],
};

/** @type {esbuild.BuildOptions} */
const webExtensionOptions = {
  ...baseOptions,
  entryPoints: ["src/web/extension.ts"],
  outfile: "dist/web/extension.js",
  platform: "browser",
  format: "cjs",
  target: ["es2022"],
  external: ["vscode"],
  define: {
    global: "globalThis",
    PLL_PYODIDE_INDEX_URL: JSON.stringify(PYODIDE_CDN_URL),
  },
};

/** @type {esbuild.BuildOptions} */
const webWorkerOptions = {
  ...baseOptions,
  entryPoints: ["src/web/pyodideWorker.ts"],
  outfile: "dist/web/pyodideWorker.js",
  platform: "browser",
  format: "iife",
  target: ["es2022"],
  define: {
    global: "globalThis",
  },
};

/** @type {esbuild.BuildOptions} */
const desktopWorkerOptions = {
  ...baseOptions,
  entryPoints: ["src/desktop/pyodideWorker.ts"],
  outfile: "dist/desktop/pyodideWorker.js",
  platform: "node",
  format: "cjs",
  target: ["node18"],
};

const cliVersion = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
).version;

/**
 * The `pll` command line, published to npm as `pll-python`.
 *
 * Same worker, same Python, same analyzers as the extension - only the view
 * differs. `pyodide` is external here rather than bundled: the package
 * depends on it for the .wasm and stdlib assets anyway, so bundling the
 * loader as well would just double it up.
 */
const cliOptions = {
  ...baseOptions,
  entryPoints: ["src/cli/bin.ts"],
  outfile: "dist-cli/cli.cjs",
  platform: "node",
  format: "cjs",
  target: ["node22"],
  external: ["pyodide"],
  banner: { js: "#!/usr/bin/env node" },
  define: { PLL_CLI_VERSION: JSON.stringify(cliVersion) },
};

/** The desktop worker verbatim; only its output path differs. */
const cliWorkerOptions = {
  ...baseOptions,
  entryPoints: ["src/desktop/pyodideWorker.ts"],
  outfile: "dist-cli/worker.cjs",
  platform: "node",
  format: "cjs",
  target: ["node22"],
  external: ["pyodide"],
};

/**
 * Assemble `dist-cli/` into something `npm publish` can take, so the CLI
 * needs no second source tree and no monorepo: its manifest is generated
 * from the extension's, which keeps name, version and links in step.
 */
function writeCliPackage() {
  const root = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
  );
  const manifest = {
    name: "pll-python",
    version: root.version,
    description:
      "Run Python with PLL's language levels from the command line: level " +
      "checks, in-file tests, friendly errors and the built-in image and " +
      "table libraries, all on Pyodide. No Python install needed.",
    license: root.license,
    repository: root.repository,
    homepage: root.homepage,
    bugs: root.bugs,
    keywords: ["python", "education", "beginner", "pyodide", "cli", "htdp"],
    bin: { pll: "./cli.cjs" },
    files: ["cli.cjs", "worker.cjs", "README.md"],
    // Node 22, not pyodide's own `>=18`: 18 and 20 are both past end of
    // life, so 22 is the oldest Node we could actually support. It also
    // matches the extension, which gets Node 22 via VS Code 1.101 - one
    // floor for the whole project rather than two.
    engines: { node: ">=22" },
    // Exact, not the `^` range this repo develops against. The extension
    // ships one specific Pyodide - vendored for desktop, named in the CDN
    // default for web - and `examplar build` compiles bytecode with
    // whatever this package resolves. A caret range let a fresh install
    // pull a newer patch than the extension has, which is how a bundle
    // could come to be built by a different interpreter than the one that
    // runs it. `built.magic` would catch that, but the point of building
    // bundles with this tool is that it cannot arise.
    dependencies: { pyodide: PYODIDE_VERSION },
  };
  const dest = path.join(process.cwd(), "dist-cli");
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(
    path.join(dest, "package.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  fs.copyFileSync(
    path.join(process.cwd(), "src", "cli", "README.md"),
    path.join(dest, "README.md"),
  );
  fs.chmodSync(path.join(dest, "cli.cjs"), 0o755);
  console.log(`[esbuild] assembled dist-cli/ for pll-python@${manifest.version}`);
}

/** Policy + MEMFS helpers for smoke tests (not part of the extension). */
const testLibOptions = {
  ...baseOptions,
  entryPoints: ["src/common/memfsWorkspace.ts", "src/common/workspaceFilePolicy.ts"],
  outdir: "out/test",
  platform: "node",
  format: "cjs",
  target: ["node18"],
};

const allConfigs = [
  desktopOptions,
  desktopWorkerOptions,
  webExtensionOptions,
  webWorkerOptions,
  cliOptions,
  cliWorkerOptions,
  testLibOptions,
];

checkIndexUrlDefault();
copyPyodideAssets();

if (watch) {
  const contexts = await Promise.all(allConfigs.map((c) => esbuild.context(c)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log("[esbuild] watching...");
} else {
  await Promise.all(allConfigs.map((c) => esbuild.build(c)));
  writeCliPackage();
  console.log("[esbuild] build complete");
}
