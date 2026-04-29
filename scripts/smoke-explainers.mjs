#!/usr/bin/env node
/**
 * Smoke test for parseLevel + the static-finding explainers.
 *
 * This bundles the relevant TS modules with esbuild on the fly so we don't
 * need a separate build step.
 */
import { build } from "esbuild";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const tmp = mkdtempSync(join(ROOT, ".smoke-"));
const entry = join(tmp, "entry.mjs");

writeFileSync(
  entry,
  `
import { parseLevel } from "../src/common/level";
import { enrichStaticFindings } from "../src/common/analyzers/static/registry";
import { formatFriendlyError } from "../src/common/errorFormatter";

export { parseLevel, enrichStaticFindings, formatFriendlyError };
`,
);

await build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: join(tmp, "out.mjs"),
  loader: { ".py": "text" },
  external: ["vscode"],
  absWorkingDir: ROOT,
});

const mod = await import(pathToFileURL(join(tmp, "out.mjs")).href);

let ok = true;
function expect(cond, msg) {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    ok = false;
  }
}

console.log("\n[parseLevel]");
expect(mod.parseLevel("#beginner\nx=1") === "beginner", "#beginner");
expect(mod.parseLevel("# beginner\nx=1") === "beginner", "# beginner (with space)");
expect(mod.parseLevel("#Beginner\nx=1") === "beginner", "case-insensitive #Beginner");
expect(mod.parseLevel("#expert\nx=1") === "expert", "#expert");
expect(mod.parseLevel("\n\n#beginner\n") === "beginner", "blank lines before header");
expect(mod.parseLevel("x = 1") === "expert", "default expert");
expect(mod.parseLevel("# random comment\nx=1") === "expert", "non-level comment defaults expert");

console.log("[enrichStaticFindings]");
const findings = mod.enrichStaticFindings(
  [
    {
      id: "shadowing",
      error_type: "Shadowing",
      message: "`count` is already defined in an outer scope",
      line_number: 10,
      column: 4,
      name_token: "count",
      scope_kind: "function",
      outer_line_number: 4,
      outer_column: 0,
      outer_scope_kind: "module",
    },
    {
      id: "shadowing-builtin",
      error_type: "Shadowing",
      message: "`list` is the name of a Python built-in",
      line_number: 15,
      column: 0,
      name_token: "list",
      scope_kind: "module",
    },
    {
      id: "reassignment",
      error_type: "Reassignment",
      message: "`total` is assigned more than once in this scope",
      line_number: 6,
      column: 0,
      name_token: "total",
      scope_kind: "module",
      first_line_number: 5,
      first_column: 0,
    },
  ],
  "beginner",
  "test.py",
);

expect(findings.length === 3, "3 findings");
expect(findings[0].errorType === "Shadowing", "shadowing errorType");
expect(findings[0].headline.includes("count"), "shadowing headline mentions name");
expect(
  findings[0].headline.includes("first defined on line 4"),
  "shadowing headline mentions outer line",
);
expect(
  findings[0].headline.includes("the file"),
  "shadowing headline mentions outer scope kind (module -> 'the file')",
);
expect(findings[0].origin === "static", "origin = static");
expect(findings[0].level === "beginner", "level = beginner");
expect(findings[1].headline.includes("built-in"), "shadowing-builtin headline");
expect(findings[2].errorType === "Reassignment", "reassignment errorType");
expect(findings[2].headline.includes("first assigned on line 5"), "reassignment headline mentions first line");
expect(findings[2].howToFix.length >= 2, "reassignment offers at least 2 fixes");
expect(
  findings[2].howToFix.every((fix) => !/comprehension/i.test(fix)),
  "reassignment fixes no longer mention comprehensions",
);
expect(
  findings[2].howToFix.every((fix) => !/#expert/i.test(fix)),
  "reassignment fixes no longer suggest switching to #expert",
);

console.log("[formatFriendlyError - shadowing-builtin]");
const lines = mod.formatFriendlyError(findings[1]);
expect(lines[0].startsWith("Shadowing:"), "first line is errorType + headline");
expect(lines.some((l) => l.includes("at test.py:15:1")), "shows location");
expect(lines.some((l) => l.includes("How to fix:")), "shows How to fix section");

rmSync(tmp, { recursive: true, force: true });

if (!ok) {
  console.log("\nFAILED");
  process.exit(1);
}
console.log("\nALL EXPLAINER SMOKE TESTS PASSED");
