#!/usr/bin/env node
/**
 * Smoke test for same-file pytest support.
 *
 * Boots Pyodide, loads pytest, then exercises `_pll_has_tests` and
 * `_pll_run_file` with its tests: the file runs once, and its tests run
 * after it, against the names it defined.
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
  const runFile = pyodide.globals.get("_pll_run_file");
  const replEval = pyodide.globals.get("_pll_repl_eval");
  let sessions = 0;
  /** A file run with its tests; the whole result, `tests` being theirs. */
  const run = (src, name, session = `tests:${(sessions += 1)}`) =>
    call(runFile, [src, name, session, "raw", true]);
  /** Just the tests' part. */
  const runTests = (src, name) => run(src, name).tests;

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
    const result = runTests(src, "tests.py");
    console.log(`    passed=${result.passed} failed=${result.failed} errors=${result.errors}`);
    expect(result.failed === 0 && result.errors === 0, "all tests in tests.py should pass");
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
    const result = runTests(src, "fail.py");
    console.log(`    passed=${result.passed} failed=${result.failed}`);
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
    const first = runTests(passSrc, "tests.py");
    expect(first.failed === 0 && first.passed === 1, "first run should pass");
    const second = runTests(failSrc, "tests.py");
    console.log(`    second: passed=${second.passed} failed=${second.failed} n=${(second.tests || []).length}`);
    expect(second.failed === 1, "second run should report the failure, got failed=" + second.failed);
    expect((second.tests || []).length === 1, "second run should still collect the test");
  }

  console.log("\n[3c] five consecutive runs of the same file");
  {
    const src = readPy("samples/tests.py");
    for (let i = 1; i <= 5; i++) {
      const result = runTests(src, "tests.py");
      expect(
        result.failed === 0 && result.errors === 0 && result.passed === 3,
        `run ${i} should collect 3 passing tests (passed=${result.passed} n=${(result.tests || []).length})`,
      );
    }
  }

  console.log("\n[4] the file runs once, and its tests see what it made");
  {
    const src = [
      "runs = []",
      "runs.append(1)",
      'if __name__ == "__main__":',
      '    print("main block")',
      "total = sum([1, 2, 3])",
      "def test_total():",
      "    assert total == 6",
      "def test_ran_once():",
      "    assert runs == [1]",
      "",
    ].join("\n");
    const result = run(src, "once.py", "session:once");
    expect(result.ok === true, `the program ran: ${result.error_message}`);
    expect(result.stdout === "main block\n", `as __main__, once: ${JSON.stringify(result.stdout)}`);
    expect(result.tests?.passed === 2, `its tests see its names: ${JSON.stringify(result.tests?.tests?.map((t) => [t.name, t.outcome, t.message]))}`);
    // The session is the program's, so the prompt sees the same names - and
    // can call a test, whose rewritten asserts need pytest's helpers.
    expect(call(replEval, ["total", "session:once"]).result_repr === "6", "the prompt sees the program's names");
    const again = call(replEval, ["test_total()", "session:once"]);
    expect(again.ok === true, `a test can be called from the prompt: ${again.error_type} ${again.error_message}`);
  }

  console.log("\n[5] a program that does not finish leaves its tests unrun");
  {
    const raised = run("def test_a():\n    assert True\n\n1 / 0\n", "raises.py");
    expect(raised.error_type === "ZeroDivisionError", `the program's error: ${raised.error_type}`);
    expect(raised.tests == null, `no tests: ${JSON.stringify(raised.tests)}`);
    const exited = run("import sys\ndef test_a():\n    assert True\n\nsys.exit(2)\n", "exits.py");
    expect(exited.exit_code === 2 && exited.tests == null, `an exit ends it too: ${exited.exit_code} ${JSON.stringify(exited.tests)}`);
    const broken = run("def test_a(:\n    pass\n", "broken.py");
    expect(broken.error_type === "SyntaxError" && broken.tests == null, `a file that does not parse: ${broken.error_type}`);
    const without = call(runFile, ["def test_a():\n    assert False\n", "off.py", "tests:off", "raw", false]);
    expect(without.ok === true && without.tests == null, "and none are run unless asked for");
  }

  hasTests.destroy?.();
  runFile.destroy?.();
  replEval.destroy?.();

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
