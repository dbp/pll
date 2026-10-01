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
import { findRuntimeFinding } from "../src/common/analyzers/registry";
import { parsePythonError } from "../src/common/errors/pythonErrorParser";

export {
  parseLevel,
  levelHasTypeChecking,
  enrichStaticFindings,
  formatFriendlyError,
  findRuntimeFinding,
  parsePythonError,
};
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

console.log("[shadowing-library explainer]");
{
  const libFindings = mod.enrichStaticFindings(
    [
      {
        id: "shadowing-library",
        error_type: "Shadowing",
        message: "`circle` is already defined by the image library",
        line_number: 3,
        column: 0,
        name_token: "circle",
        scope_kind: "module",
        library: "image",
      },
      {
        id: "shadowing-library",
        error_type: "Shadowing",
        message: "`table` is already defined by the table library",
        line_number: 8,
        column: 4,
        name_token: "table",
        scope_kind: "function",
        library: "table",
      },
      {
        id: "shadowing-library",
        error_type: "Shadowing",
        message: "`animate` is already defined by the reactor library",
        line_number: 12,
        column: 0,
        name_token: "animate",
        scope_kind: "module",
        library: "reactor",
      },
      {
        // Bootstrap-only harnesses (no pll package registered) label the
        // name "library" generically; the explainer must not crash on it.
        id: "shadowing-library",
        error_type: "Shadowing",
        message: "`circle` is already defined by the library",
        line_number: 15,
        column: 0,
        name_token: "circle",
        scope_kind: "module",
      },
    ],
    "beginner",
    "test.py",
  );
  expect(libFindings.length === 4, "4 shadowing-library findings");
  expect(libFindings[0].errorType === "Shadowing", "shadowing-library errorType");
  expect(
    libFindings[0].headline.includes("`circle` is already defined by the image library"),
    "image library headline names the library",
  );
  expect(
    libFindings[1].headline.includes("table library"),
    "table library headline",
  );
  expect(
    libFindings[2].headline.includes("reactor library"),
    "reactor library headline",
  );
  expect(
    libFindings[3].headline.includes("PLL libraries"),
    "missing library label falls back to 'the PLL libraries'",
  );
  expect(
    libFindings[0].howToFix.length >= 2,
    "shadowing-library offers at least 2 fixes",
  );
  expect(
    libFindings[0].howToFix.some((fix) => fix.includes("my_circle")),
    "fix suggests a concrete alternative name",
  );
  expect(libFindings[0].origin === "static", "origin = static");
  expect(libFindings[0].level === "beginner", "level = beginner");

  // The friendly CLI/error formatter renders it like any other finding.
  const lines = mod.formatFriendlyError(libFindings[0]);
  expect(lines[0].startsWith("Shadowing:"), "first line is errorType + headline");
  expect(lines.some((l) => l.includes("at test.py:3:1")), "shows location");
  expect(lines.some((l) => l.includes("How to fix:")), "shows How to fix section");
}

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

console.log("[name errors: a name with no value is named, not called `this name`]");
{
  /** Build a finding from a traceback the way the hosts do. */
  const finding = (traceback, source) =>
    mod.findRuntimeFinding(source, "lab.py", "beginner", mod.parsePythonError(traceback, source));

  // The Lab 10 shape: an inner function reads a name the enclosing function
  // assigns later. Only `name 'x' is not defined` was matched before, so the
  // name was unknown and the report read "Python doesn't know what `this
  // name` means" - four times over, in a file where `title` is right there.
  const free = finding(
    [
      'Traceback (most recent call last):',
      '  File "lab.py", line 3, in inner',
      "    return title",
      "           ^^^^^",
      "NameError: cannot access free variable 'title' where it is not associated with a value",
    ].join("\n"),
    "def outer():\n    def inner():\n        return title\n    inner()\n    title = 1\n",
  );
  expect(free !== null, "a free-variable NameError should be explained");
  expect(free.nameToken === "title", `the name should be found, got ${free.nameToken}`);
  expect(/`title`/.test(free.headline), `the headline should name it: ${free.headline}`);
  expect(!/this name/.test(free.headline + free.howToFix.join(" ")), "no placeholder anywhere");
  // A name spelled correctly needs advice about order, not spelling.
  expect(
    !free.howToFix.some((line) => /spelling/.test(line)),
    `spelling advice is wrong here: ${JSON.stringify(free.howToFix)}`,
  );
  expect(
    free.howToFix.some((line) => /Move the line that sets/.test(line)),
    `expected advice about order: ${JSON.stringify(free.howToFix)}`,
  );

  // `UnboundLocalError` is the same mistake under a different type, and was
  // not handled at all - it fell through to a bare traceback.
  const local = finding(
    [
      'Traceback (most recent call last):',
      '  File "lab.py", line 2, in f',
      "    print(count)",
      "          ^^^^^",
      "UnboundLocalError: cannot access local variable 'count' where it is not associated with a value",
    ].join("\n"),
    "def f():\n    print(count)\n    count = 1\n",
  );
  expect(local !== null, "an UnboundLocalError should be explained too");
  expect(local.nameToken === "count", `the name should be found, got ${local.nameToken}`);
  expect(local.errorType === "UnboundLocalError", `keep Python's type: ${local.errorType}`);
  expect(
    local.howToFix.some((line) => /local to the whole function/.test(line)),
    `expected the assigning-makes-it-local note: ${JSON.stringify(local.howToFix)}`,
  );

  // A genuinely unknown name still gets the spelling advice.
  const unknown = finding(
    [
      'Traceback (most recent call last):',
      '  File "lab.py", line 1, in <module>',
      "    print(Totl)",
      "          ^^^^",
      "NameError: name 'Totl' is not defined",
    ].join("\n"),
    "print(Totl)\n",
  );
  expect(unknown.nameToken === "Totl", `got ${unknown.nameToken}`);
  expect(/doesn't know what `Totl`/.test(unknown.headline), `headline: ${unknown.headline}`);
  expect(
    unknown.howToFix.some((line) => /spelling/.test(line)),
    "an unknown name does want the spelling check",
  );
  console.log("    free, local and unknown names each named and advised correctly");
}

rmSync(tmp, { recursive: true, force: true });

if (!ok) {
  console.log("\nFAILED");
  process.exit(1);
}
console.log("\nALL EXPLAINER SMOKE TESTS PASSED");
