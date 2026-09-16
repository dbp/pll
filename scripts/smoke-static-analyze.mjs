#!/usr/bin/env node
/**
 * Smoke test for the language-level static analyzer.
 *
 * Boots Pyodide in Node, loads the bootstrap, and runs
 * `_pll_static_analyze` against each sample file. Asserts a sensible set
 * of findings is produced (or none, for the OK sample).
 *
 * Usage: node scripts/smoke-static-analyze.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { loadPyodide } from "pyodide";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

function readPy(rel) {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

function expect(cond, msg) {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    process.exitCode = 1;
  }
}

async function main() {
  const indexURL = resolve(ROOT, "node_modules", "pyodide");
  const pyodide = await loadPyodide({ indexURL });
  const bootstrap = readPy("src/common/pyodideBootstrap.py");
  pyodide.runPython(bootstrap);

  const fn = pyodide.globals.get("_pll_static_analyze");
  const analyze = (code, level, fileName, sessionKey = null) => {
    const proxy = fn(code, level, fileName, sessionKey);
    const obj = proxy.toJs({ dict_converter: Object.fromEntries });
    proxy.destroy?.();
    return obj;
  };

  console.log("\n[1] beginner_ok.py - expect 0 findings");
  {
    const findings = analyze(readPy("samples/beginner_ok.py"), "beginner", "beginner_ok.py");
    console.log(`    findings: ${findings.length}`);
    expect(findings.length === 0, "expected 0 findings, got " + JSON.stringify(findings));
  }

  console.log("\n[2] beginner_shadowing.py - expect shadowing + shadowing-builtin");
  {
    const findings = analyze(
      readPy("samples/beginner_shadowing.py"),
      "beginner",
      "beginner_shadowing.py",
    );
    console.log(`    findings: ${findings.length}`);
    for (const f of findings) {
      const outer =
        f.outer_line_number != null
          ? ` (outer: line ${f.outer_line_number} in ${f.outer_scope_kind})`
          : "";
      console.log(`      [${f.id}] line ${f.line_number}: ${f.message}${outer}`);
    }
    const ids = findings.map((f) => f.id);
    expect(ids.includes("shadowing"), "missing 'shadowing' (count -> count inside increment)");
    expect(ids.includes("shadowing-builtin"), "missing 'shadowing-builtin' (list = [...])");
    const shadow = findings.find((f) => f.id === "shadowing");
    expect(shadow.outer_line_number != null, "shadowing should carry outer_line_number");
    expect(shadow.outer_scope_kind != null, "shadowing should carry outer_scope_kind");
  }

  console.log("\n[3] beginner_reassignment.py - expect 'reassignment' findings");
  {
    const findings = analyze(
      readPy("samples/beginner_reassignment.py"),
      "beginner",
      "beginner_reassignment.py",
    );
    console.log(`    findings: ${findings.length}`);
    for (const f of findings) {
      console.log(`      [${f.id}] line ${f.line_number}: ${f.message}`);
    }
    const reassignments = findings.filter((f) => f.id === "reassignment");
    expect(
      reassignments.length >= 2,
      "expected at least 2 reassignment findings (total += 1, result += n)",
    );
  }

  console.log("\n[4] advanced.py - expect 0 findings (advanced level disables checks)");
  {
    const findings = analyze(readPy("samples/advanced.py"), "advanced", "advanced.py");
    console.log(`    findings: ${findings.length}`);
    expect(findings.length === 0, "advanced level should produce no findings");
  }

  console.log("\n[5] advanced.py treated as beginner - expect findings");
  {
    const findings = analyze(readPy("samples/advanced.py"), "beginner", "advanced.py");
    console.log(`    findings: ${findings.length}`);
    expect(findings.length > 0, "advanced.py should fail at beginner level");
  }

  console.log(
    "\n[6] intermediate_ok.py - expect 0 findings " +
      "(rebinding inside `def` is allowed at intermediate)",
  );
  {
    const findings = analyze(
      readPy("samples/intermediate_ok.py"),
      "intermediate",
      "intermediate_ok.py",
    );
    console.log(`    findings: ${findings.length}`);
    for (const f of findings) {
      console.log(`      [${f.id}] line ${f.line_number}: ${f.message}`);
    }
    expect(findings.length === 0, "intermediate_ok should pass at intermediate");
  }

  console.log(
    "\n[7] intermediate_ok.py treated as beginner - expect reassignment findings",
  );
  {
    const findings = analyze(
      readPy("samples/intermediate_ok.py"),
      "beginner",
      "intermediate_ok.py",
    );
    console.log(`    findings: ${findings.length}`);
    const reassignments = findings.filter((f) => f.id === "reassignment");
    expect(
      reassignments.length > 0,
      "beginner should still flag in-function reassignment that intermediate allows",
    );
  }

  console.log(
    "\n[8] intermediate_shadowing.py - expect shadowing + shadowing-builtin",
  );
  {
    const findings = analyze(
      readPy("samples/intermediate_shadowing.py"),
      "intermediate",
      "intermediate_shadowing.py",
    );
    console.log(`    findings: ${findings.length}`);
    for (const f of findings) {
      console.log(`      [${f.id}] line ${f.line_number}: ${f.message}`);
    }
    const ids = findings.map((f) => f.id);
    expect(ids.includes("shadowing"), "intermediate must still flag shadowing");
    expect(
      ids.includes("shadowing-builtin"),
      "intermediate must still flag shadowing of built-ins",
    );
  }

  console.log(
    "\n[9] intermediate_keyword.py - expect 'disallowed-keyword' findings (global + nonlocal)",
  );
  {
    const findings = analyze(
      readPy("samples/intermediate_keyword.py"),
      "intermediate",
      "intermediate_keyword.py",
    );
    console.log(`    findings: ${findings.length}`);
    for (const f of findings) {
      console.log(
        `      [${f.id}] line ${f.line_number}: ${f.message} (keyword=${f.keyword})`,
      );
    }
    const kw = findings.filter((f) => f.id === "disallowed-keyword");
    const keywords = new Set(kw.map((f) => f.keyword));
    expect(kw.length >= 2, "expected at least one finding per keyword");
    expect(keywords.has("global"), "missing 'global' finding");
    expect(keywords.has("nonlocal"), "missing 'nonlocal' finding");
  }

  console.log(
    "\n[10] beginner level on intermediate_keyword.py - " +
      "should also flag global/nonlocal",
  );
  {
    const findings = analyze(
      readPy("samples/intermediate_keyword.py"),
      "beginner",
      "intermediate_keyword.py",
    );
    const kw = findings.filter((f) => f.id === "disallowed-keyword");
    expect(kw.length >= 2, "beginner must also flag global/nonlocal");
  }

  console.log(
    "\n[11] advanced level: global/nonlocal are NOT flagged",
  );
  {
    const findings = analyze(
      readPy("samples/intermediate_keyword.py"),
      "advanced",
      "intermediate_keyword.py",
    );
    expect(
      findings.length === 0,
      "advanced level should produce 0 findings even with global/nonlocal",
    );
  }

  console.log(
    "\n[12] REPL-style analysis: session names count as preexisting bindings",
  );
  {
    pyodide.runPython(`
_g = _pll_get_session("smoke-repl")
_g["x"] = 1
`);
    const none = analyze("y = 1", "beginner", "<repl>", "smoke-repl");
    expect(none.length === 0, "new name at prompt is not a finding");

    const reassign = analyze("x = 2", "beginner", "<repl>", "smoke-repl");
    expect(
      reassign.some((f) => f.id === "reassignment" && f.name_token === "x"),
      "reassigning a session name at beginner is flagged",
    );
    expect(
      reassign.find((f) => f.id === "reassignment")?.first_line_number === 0,
      "preexisting binding is recorded as line 0",
    );

    const shadow = analyze("def f():\n    x = 1\n", "beginner", "<repl>", "smoke-repl");
    expect(
      shadow.some((f) => f.id === "shadowing" && f.name_token === "x"),
      "nested assignment of a session name is shadowing",
    );

    const noSession = analyze("x = 2", "beginner", "<repl>");
    expect(
      !noSession.some((f) => f.id === "reassignment"),
      "without a session, x = 2 is a first assignment",
    );

    const interFn = analyze(
      "def f():\n    y = 1\n    y = 2\n",
      "intermediate",
      "<repl>",
      "smoke-repl",
    );
    expect(
      !interFn.some((f) => f.id === "reassignment"),
      "intermediate still allows reassignment inside a function at the prompt",
    );

    const interMod = analyze("x = 2", "intermediate", "<repl>", "smoke-repl");
    expect(
      interMod.some((f) => f.id === "reassignment" && f.name_token === "x"),
      "intermediate still flags top-level reassignment at the prompt",
    );
  }

  console.log("\n[13] every sample is clean at its own declared level");
  {
    // These exist to *demonstrate* findings, so they are expected to have
    // them. Everything else must pass the level it asks for - a sample that
    // cannot run is worse than no sample.
    const demos = /reassignment|shadowing|keyword|name_error/;
    const samples = readdirSync(resolve(ROOT, "samples")).filter((f) => f.endsWith(".py"));
    expect(samples.length > 10, `expected to find the samples, got ${samples.length}`);
    for (const name of samples) {
      const code = readPy(`samples/${name}`);
      const first = code.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
      const level = first.startsWith("#level ") ? first.slice("#level ".length) : "raw";
      const findings = analyze(code, level, name) ?? [];
      if (demos.test(name)) continue;
      expect(
        findings.length === 0,
        `${name} declares #level ${level} but has ${findings.length} finding(s): ` +
          findings.map((f) => `${f.id} ${f.name_token} on line ${f.line_number}`).join(", "),
      );
    }
    console.log(`    checked ${samples.length} samples`);
  }

  fn.destroy?.();

  if (process.exitCode) {
    console.log("\nFAILED");
  } else {
    console.log("\nALL SMOKE TESTS PASSED");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
