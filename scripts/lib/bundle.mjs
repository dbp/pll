import { build } from "esbuild";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Import TypeScript from `src/` into a test.
 *
 * `entry` is the body of a module, with paths relative to the repository
 * root: `export { findRuntimeFinding } from "./src/common/analyzers/registry";`.
 * It is bundled with the loaders the build itself uses, so a module that
 * reaches the Python sources or the vendored wheels imports the same way
 * here as in the extension. `vscodeStub`, when given, is the source of the
 * module that stands in for `vscode`; without it `vscode` is left external.
 */
export async function importSource(entry, { vscodeStub } = {}) {
  const tmp = mkdtempSync(join(ROOT, ".smoke-"));
  try {
    const plugins = [];
    if (vscodeStub !== undefined) {
      const stubPath = join(tmp, "vscode.mjs");
      writeFileSync(stubPath, vscodeStub);
      plugins.push({
        name: "vscode-stub",
        setup(b) {
          b.onResolve({ filter: /^vscode$/ }, () => ({ path: stubPath }));
        },
      });
    }
    const outfile = join(tmp, "out.mjs");
    await build({
      stdin: { contents: entry, resolveDir: ROOT, sourcefile: "entry.mjs", loader: "js" },
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      loader: { ".py": "text", ".whl": "base64" },
      external: vscodeStub === undefined ? ["vscode"] : [],
      plugins,
      logLevel: "silent",
    });
    return await import(pathToFileURL(outfile).href);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
