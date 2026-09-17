import * as fs from "node:fs";
import * as path from "node:path";
import * as esbuild from "esbuild";

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
  entryPoints: ["src/extension.ts"],
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
    dependencies: { pyodide: root.devDependencies.pyodide },
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
