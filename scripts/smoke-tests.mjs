#!/usr/bin/env node
/**
 * Smoke test for same-file pytest support.
 *
 * Boots Pyodide, loads pytest from the CDN fallback, then exercises
 * `_pll_has_tests` and `_pll_run_tests`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, passed } from "./lib/check.mjs";
import { bootPll } from "./lib/pyodide.mjs";
import { ROOT } from "./lib/bundle.mjs";

function readPy(rel) {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

function call(fn, args) {
  const proxy = fn(...args);
  if (proxy && typeof proxy === "object" && typeof proxy.toJs === "function") {
    const obj = proxy.toJs({ dict_converter: Object.fromEntries });
    proxy.destroy?.();
    return obj;
  }
  return proxy;
}

async function main() {
  const pyodide = await bootPll();
  await pyodide.loadPackage("pytest");

  const hasTests = pyodide.globals.get("_pll_has_tests");
  const runTests = pyodide.globals.get("_pll_run_tests");

  console.log("\n[1] hello.py - no tests");
  {
    const found = call(hasTests, [readPy("samples/hello.py")]);
    console.log(`    has_tests: ${found}`);
    expect(found === false, "hello.py should not look like it has tests");
  }

  console.log("\n[2] samples/tests.py - passing tests");
  {
    const src = readPy("samples/tests.py");
    expect(call(hasTests, [src]) === true, "tests.py should have tests");
    const result = call(runTests, [src, "tests.py"]);
    console.log(
      `    passed=${result.passed} failed=${result.failed} errors=${result.errors} ok=${result.ok}`,
    );
    expect(result.internal_error === false, "pytest should not crash");
    expect(result.ok === true, "all tests in tests.py should pass");
    expect(result.passed === 3, "expected 3 passed, got " + result.passed);
    expect(result.failed === 0, "expected 0 failed");
    const names = (result.tests || []).map((t) => t.name);
    expect(names.includes("test_add_positive"), "missing test_add_positive");
    expect(names.includes("TestAdd::test_negative"), "missing class test");
  }

  console.log("\n[3] a failing assertion");
  {
    const src = `
def add(x, y):
    return x + y

def test_wrong():
    assert add(1, 1) == 3
`;
    const result = call(runTests, [src, "fail.py"]);
    console.log(`    passed=${result.passed} failed=${result.failed} ok=${result.ok}`);
    expect(result.ok === false, "failing test should set ok=False");
    expect(result.failed === 1, "expected 1 failed");
    const fail = (result.tests || []).find((t) => t.outcome === "failed");
    expect(!!fail, "expected a failed test row");
    expect(typeof fail.message === "string" && fail.message.length > 0, "failed test needs a message");
    expect(fail.line_number === 5, "failed test line should be the def (got " + fail.line_number + ")");
    expect(!fail.message.includes("_pytest"), "failure message should not include pytest internals");
    expect(!fail.message.includes("pluggy"), "failure message should not include pluggy internals");
    expect(!fail.message.includes("site-packages"), "failure message should not include site-packages");
    expect(fail.message.includes("assert"), "failure message should show the assert, got: " + fail.message);
    expect(
      fail.message.includes("2 == 3") || fail.message.includes("assert 2 == 3"),
      "rewritten assert should show 2 == 3, got: " + fail.message,
    );
  }

  console.log("\n[3b] pass then fail in the same interpreter");
  {
    const passSrc = `
def add(x, y):
    return x + y
def test_add():
    assert add(2, 3) == 5
`;
    const failSrc = `
def add(x, y):
    return x + y
def test_add():
    assert add(2, 3) == 6
`;
    const first = call(runTests, [passSrc, "tests.py"]);
    expect(first.ok === true && first.passed === 1, "first run should pass");
    const second = call(runTests, [failSrc, "tests.py"]);
    console.log(`    second: passed=${second.passed} failed=${second.failed} ok=${second.ok} n=${(second.tests || []).length}`);
    expect(second.internal_error === false, "second run should not crash");
    expect(second.failed === 1, "second run should report the failure, got failed=" + second.failed);
    expect((second.tests || []).length === 1, "second run should still collect the test");
  }

  console.log("\n[3c] five consecutive runs of the same file");
  {
    const src = readPy("samples/tests.py");
    for (let i = 1; i <= 5; i++) {
      const result = call(runTests, [src, "tests.py"]);
      expect(
        result.internal_error === false && result.ok === true && result.passed === 3,
        `run ${i} should collect 3 passing tests (passed=${result.passed} n=${(result.tests || []).length} err=${result.error_message})`,
      );
    }
  }

  console.log("\n[4] pytest isolation - does not clobber the REPL session");
  {
    const runFile = pyodide.globals.get("_pll_run_file");
    const replEval = pyodide.globals.get("_pll_repl_eval");
    const session = "session:iso";
    const primed = call(runFile, ["x = 42", "iso.py", session]);
    expect(primed.ok === true, "priming run_file should succeed");
    call(runTests, ["x = 99\ndef test_x():\n    assert x == 99\n", "iso.py"]);
    const after = call(replEval, ["x", session]);
    expect(after.ok === true, "repl eval of x should succeed");
    expect(
      after.result_repr === "42",
      "pytest must not overwrite session globals (got " + after.result_repr + ")",
    );
    runFile.destroy?.();
    replEval.destroy?.();
  }

  hasTests.destroy?.();
  runTests.destroy?.();

  if (!passed()) {
    console.error("\nsmoke-tests: FAILED");
    process.exit(1);
  }
  console.log("\nsmoke-tests: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
