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
import { parseLevel, levelHasTypeChecking } from "../src/common/level";
import { enrichStaticFindings } from "../src/common/analyzers/static/registry";
import { formatFriendlyError } from "../src/common/errorFormatter";

export { parseLevel, levelHasTypeChecking, enrichStaticFindings, formatFriendlyError };
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
expect(mod.parseLevel("#level raw\nx=1") === "raw", "#level raw");
expect(mod.parseLevel("#level beginner\nx=1") === "beginner", "#level beginner");
expect(mod.parseLevel("# level beginner\nx=1") === "beginner", "# level beginner (with space)");
expect(mod.parseLevel("#level intermediate\nx=1") === "intermediate", "#level intermediate");
expect(mod.parseLevel("#level advanced\nx=1") === "advanced", "#level advanced");
expect(mod.parseLevel("#level  advanced \nx=1") === "advanced", "extra spaces around the name");
expect(mod.parseLevel("\n\n#level beginner\n") === "beginner", "blank lines before header");
// No header at all is `raw`: code written without PLL in mind runs as plain
// Python, and every difference has to be opted into by naming a level.
expect(mod.parseLevel("x = 1") === "raw", "no header defaults to raw");
expect(mod.parseLevel("# random comment\nx=1") === "raw", "non-level comment defaults to raw");
// Exactly one spelling: the bare form and any other casing are not levels.
expect(mod.parseLevel("#beginner\nx=1") === "raw", "the bare #beginner form is gone");
expect(mod.parseLevel("#LEVEL beginner\nx=1") === "raw", "#LEVEL is not #level");
expect(mod.parseLevel("#level Beginner\nx=1") === "raw", "#level Beginner is not a level");
expect(mod.parseLevel("#level expert\nx=1") === "raw", "expert is not a level");
expect(mod.parseLevel("#level\nx=1") === "raw", "a bare #level names nothing");

console.log("\n[levelHasTypeChecking]");
expect(mod.levelHasTypeChecking("beginner") === true, "beginner checks annotations");
expect(mod.levelHasTypeChecking("intermediate") === true, "intermediate checks annotations");
expect(mod.levelHasTypeChecking("advanced") === true, "advanced checks annotations");
expect(mod.levelHasTypeChecking("raw") === false, "raw checks nothing");

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
expect(
  findings[2].howToFix.every((fix) => !/#level advanced/i.test(fix)),
  "reassignment fixes no longer suggest switching to advanced",
);

console.log("[explainers omit line 0 for preexisting session bindings]");
{
  const preexisting = mod.enrichStaticFindings(
    [
      {
        id: "reassignment",
        error_type: "Reassignment",
        message: "`x` is assigned more than once in this scope",
        line_number: 1,
        column: 0,
        name_token: "x",
        scope_kind: "module",
        first_line_number: 0,
        first_column: 0,
      },
      {
        id: "shadowing",
        error_type: "Shadowing",
        message: "`x` is already defined in an outer scope",
        line_number: 2,
        column: 4,
        name_token: "x",
        scope_kind: "function",
        outer_line_number: 0,
        outer_column: 0,
        outer_scope_kind: "module",
      },
    ],
    "beginner",
    "<repl>",
  );
  expect(
    !preexisting[0].headline.includes("line 0"),
    "reassignment headline omits first assigned on line 0",
  );
  expect(
    !preexisting[1].headline.includes("line 0"),
    "shadowing headline omits first defined on line 0",
  );
  expect(
    preexisting[1].headline.includes("the file"),
    "shadowing still mentions the outer scope",
  );
}

console.log("[disallowed-keyword explainer - global at intermediate]");
const kwFindings = mod.enrichStaticFindings(
  [
    {
      id: "disallowed-keyword",
      error_type: "DisallowedKeyword",
      message: "`global` is not allowed at the intermediate level",
      line_number: 8,
      column: 4,
      name_token: "counter",
      scope_kind: "function",
      keyword: "global",
      names: ["counter"],
    },
    {
      id: "disallowed-keyword",
      error_type: "DisallowedKeyword",
      message: "`nonlocal` is not allowed at the intermediate level",
      line_number: 14,
      column: 8,
      name_token: "n",
      scope_kind: "function",
      keyword: "nonlocal",
      names: ["n"],
    },
  ],
  "intermediate",
  "intermediate_keyword.py",
);
expect(kwFindings.length === 2, "two keyword findings");
expect(
  kwFindings[0].errorType === "DisallowedKeyword",
  "errorType is DisallowedKeyword",
);
expect(
  kwFindings[0].headline.includes("`global`"),
  "global headline mentions the keyword",
);
expect(
  kwFindings[0].headline.includes("intermediate"),
  "global headline mentions level",
);
expect(
  kwFindings[1].headline.includes("`nonlocal`"),
  "nonlocal headline mentions the keyword",
);
expect(
  kwFindings[0].howToFix.length >= 2,
  "global has at least 2 fix suggestions",
);
expect(
  kwFindings[0].howToFix.some((fix) => fix.includes("argument")),
  "global suggests passing as an argument",
);
expect(
  kwFindings[1].howToFix.some((fix) => fix.toLowerCase().includes("return")),
  "nonlocal suggests returning a value",
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
