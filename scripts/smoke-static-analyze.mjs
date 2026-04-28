#!/usr/bin/env node
/**
 * Smoke test for the language-level static analyzer.
 *
 * Boots Pyodide in Node, loads the bootstrap, and runs
 * `_bonnie_static_analyze` against each sample file. Asserts a sensible set
 * of findings is produced (or none, for the OK sample).
 *
 * Usage: node scripts/smoke-static-analyze.mjs
 */
import { readFileSync } from "node:fs";
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

  const fn = pyodide.globals.get("_bonnie_static_analyze");
  const analyze = (code, level, fileName) => {
    const proxy = fn(code, level, fileName);
    const obj = proxy.toJs({ dict_converter: Object.fromEntries });
    proxy.destroy?.();
    return obj;
  };

  let ok = true;

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

  console.log("\n[4] expert.py - expect 0 findings (expert level disables checks)");
  {
    const findings = analyze(readPy("samples/expert.py"), "expert", "expert.py");
    console.log(`    findings: ${findings.length}`);
    expect(findings.length === 0, "expert level should produce no findings");
  }

  console.log("\n[5] expert.py treated as beginner - expect findings");
  {
    const findings = analyze(readPy("samples/expert.py"), "beginner", "expert.py");
    console.log(`    findings: ${findings.length}`);
    expect(findings.length > 0, "expert.py should fail at beginner level");
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
