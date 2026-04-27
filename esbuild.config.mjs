import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {esbuild.BuildOptions} */
const baseOptions = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: "info",
  legalComments: "none",
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

const allConfigs = [desktopOptions, webExtensionOptions, webWorkerOptions];

if (watch) {
  const contexts = await Promise.all(allConfigs.map((c) => esbuild.context(c)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log("[esbuild] watching...");
} else {
  await Promise.all(allConfigs.map((c) => esbuild.build(c)));
  console.log("[esbuild] build complete");
}
