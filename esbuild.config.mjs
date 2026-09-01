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

const allConfigs = [desktopOptions, desktopWorkerOptions, webExtensionOptions, webWorkerOptions];

copyPyodideAssets();

if (watch) {
  const contexts = await Promise.all(allConfigs.map((c) => esbuild.context(c)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log("[esbuild] watching...");
} else {
  await Promise.all(allConfigs.map((c) => esbuild.build(c)));
  console.log("[esbuild] build complete");
}
