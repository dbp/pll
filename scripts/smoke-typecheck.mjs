#!/usr/bin/env node
/**
 * Smoke test for runtime type checking (typeguard).
 *
 * Drives the built desktop worker over the real protocol, so this covers
 * the whole stack: the vendored wheels being written into MEMFS and put on
 * sys.path, the AST instrumentation, the level that selects it, and the
 * traceback filtering that keeps typeguard's own frames out of what a
 * student sees.
 *
 * Requires `pnpm run build` so dist/desktop/pyodideWorker.js exists.
 */
import { expect, passed } from "./lib/check.mjs";
import { importSource } from "./lib/bundle.mjs";
import { INDEX_URL } from "./lib/pyodide.mjs";
import { startWorker, talk } from "./lib/worker.mjs";

/** Bundle the host-side analyzer so the rewritten messages can be checked. */
async function loadAnalyzer() {
  const mod = await importSource(`
export { findRuntimeFinding } from "./src/common/analyzers/registry";
export { deliverRunResult, pythonErrorFrom } from "./src/common/fromPython";
export { explainTestReport } from "./src/common/analyzers/runtimeFinding";
`);
  return mod;
}

async function main() {
  const { findRuntimeFinding, pythonErrorFrom, deliverRunResult, explainTestReport } = await loadAnalyzer();

  /**
   * A run's test report as both hosts show it: translated, then each error
   * explained. `shown` is what a view prints for a test.
   */
  const reportOf = (result, fileName, level, code) => {
    let report = null;
    deliverRunResult(result, (event) => {
      if (event.kind === "testReport") report = explainTestReport(event, code, fileName, level);
    }, fileName);
    return report;
  };
  const shown = (test) =>
    test?.finding
      ? [test.finding.headline, ...test.finding.howToFix].join("\n")
      : (test?.message ?? "");
  const worker = startWorker();
  const { send } = talk(worker);
  let session = 0;
  /** Run a file and return its result dict. */
  const run = (code, opts = {}) =>
    send({
      type: "runFile",
      code,
      fileName: opts.fileName ?? "hello.py",
      sessionKey: "tc-" + session++,
      // Annotations are only checked away from `raw`; these tests are about
      // the checking, so default to the level that uses Python's own rules.
      level: "advanced",
      ...opts,
    }).then((r) => r.result);

  try {
    console.log("\n[1] init (writes the vendored wheels, enables typeguard)");
    await send({ type: "init", indexUrl: INDEX_URL });
    // For the runs with tests, whose asserts pytest rewrites.
    await send({ type: "loadPytest" });
    console.log("    ready");

    console.log("\n[2] annotations that hold: program runs normally");
    {
      const r = await run(
        "def add(x: int, y: int) -> int:\n    return x + y\n\nprint(add(2, 3))\n",
      );
      console.log(`    ok=${r.ok} stdout=${JSON.stringify(r.stdout)}`);
      expect(r.ok === true, "valid annotated code should run: " + (r.error_message || ""));
      expect(r.stdout === "5\n", "should print 5, got " + JSON.stringify(r.stdout));
    }

    console.log("\n[3] wrong argument type: reported at the CALL site");
    {
      const r = await run(
        "def add(x: int, y: int) -> int:\n    return x + y\n\nresult = add(2, \"three\")\n",
      );
      console.log(`    ${r.error_type}: ${r.error_message}`);
      console.log(`    line_number=${r.line_number}`);
      expect(r.ok === false, "a bad argument should fail the run");
      expect(r.error_type === "TypeCheckError", "expected TypeCheckError, got " + r.error_type);
      expect(
        /argument "y" \(str\) is not an instance of int/.test(r.error_message),
        "message should name the argument and both types, got " + r.error_message,
      );
      // The `typeguard.TypeCheckError:` exception name is fine; what must
      // not appear is a *frame* inside the vendored checker.
      const frames = r.traceback.split("\n").filter((l) => l.includes('File "'));
      expect(
        !frames.some((l) => /pll_vendor|_checkers\.py|_functions\.py/.test(l)),
        "traceback must not expose typeguard's own frames:\n" + frames.join("\n"),
      );
      expect(
        /hello\.py", line 4/.test(r.traceback),
        "traceback should include the call site (line 4):\n" + r.traceback,
      );
    }

    console.log("\n[4] wrong return type: reported at the return statement");
    {
      const r = await run(
        "def label(n: int) -> str:\n    return n * 2\n\nlabel(5)\n",
      );
      console.log(`    ${r.error_type}: ${r.error_message} (line ${r.line_number})`);
      expect(r.error_type === "TypeCheckError", "expected TypeCheckError, got " + r.error_type);
      expect(
        /the return value \(int\) is not an instance of str/.test(r.error_message),
        "message should describe the return value, got " + r.error_message,
      );
      expect(r.line_number === 2, "should point at the return statement, got " + r.line_number);
    }

    console.log("\n[5] module-level annotated assignment (typeguard alone misses this)");
    {
      const r = await run('total: int = "not a number"\nprint(total)\n');
      console.log(`    ${r.error_type}: ${r.error_message} (line ${r.line_number})`);
      expect(r.error_type === "TypeCheckError", "top-level annassign should be checked, got " + r.error_type);
      expect(
        /value assigned to total \(str\) is not an instance of int/.test(r.error_message || ""),
        "message should name the variable, got " + r.error_message,
      );
      expect(r.line_number === 1, "should point at the assignment, got " + r.line_number);
    }
    {
      const r = await run("total: int = 7\nprint(total)\n");
      expect(r.ok === true, "a valid top-level annassign should run: " + (r.error_message || ""));
      expect(r.stdout === "7\n", "should still assign the value, got " + JSON.stringify(r.stdout));
    }

    console.log("\n[6] every list item is checked, not just the first");
    {
      const r = await run(
        "def total(nums: list[int]) -> int:\n    return sum(nums)\n\ntotal([1, 2, \"three\"])\n",
      );
      console.log(`    ${r.error_type}: ${r.error_message}`);
      expect(r.error_type === "TypeCheckError", "a bad item late in a list should be caught");
      expect(
        /item 2 of argument "nums"/.test(r.error_message || ""),
        "message should name the item index, got " + r.error_message,
      );
    }

    console.log("\n[7] int is accepted where float is annotated (PEP 484 numeric tower)");
    {
      const r = await run(
        "def cost(n: int) -> float:\n    return n * 25\n\nprint(cost(2))\n",
      );
      console.log(`    ok=${r.ok} stdout=${JSON.stringify(r.stdout)}`);
      expect(r.ok === true, "int for -> float must be allowed: " + (r.error_message || ""));
    }

    console.log("\n[8] unannotated code is untouched");
    {
      const r = await run("def add(x, y):\n    return x + y\n\nprint(add('a', 'b'))\n");
      expect(r.ok === true, "unannotated code should be unaffected: " + (r.error_message || ""));
      expect(r.stdout === "ab\n", "should print ab, got " + JSON.stringify(r.stdout));
    }

    console.log("\n[9] #level raw runs as plain Python");
    {
      const r = await run(
        "def add(x: int, y: int) -> int:\n    return x + y\n\nprint(add(2, \"three\"))\n",
        { level: "raw" },
      );
      console.log(`    ok=${r.ok} error=${r.error_type || "(none)"}`);
      expect(r.error_type !== "TypeCheckError", "raw must not check annotations");
      // "2" + "three" is a TypeError from Python itself, not from typeguard.
      expect(r.error_type === "TypeError", "plain Python should still fail its own way, got " + r.error_type);

      // And a request with no level at all must behave the same, because a
      // file with no header is raw.
      const bare = (
        await send({
          type: "runFile",
          code: 'def add(x: int, y: int) -> int:\n    return x + y\n\nprint(add(2, "three"))\n',
          fileName: "hello.py",
          sessionKey: "tc-bare",
        })
      ).result;
      console.log(`    no level at all -> ${bare.error_type}`);
      expect(
        bare.error_type === "TypeError",
        "omitting the level should behave like raw, got " + bare.error_type,
      );
    }

    console.log("\n[10] annotated assignment inside a function");
    {
      const r = await run(
        "def f(x: int) -> None:\n    label: str = x\n    print(label)\n\nf(3)\n",
      );
      console.log(`    ${r.error_type}: ${r.error_message} (line ${r.line_number})`);
      expect(r.error_type === "TypeCheckError", "in-function annassign should be checked");
      expect(r.line_number === 2, "should point at the assignment, got " + r.line_number);
    }

    console.log("\n[11] tests still run, and type checks apply inside them");
    {
      const code = [
        "import pytest",
        "",
        "def double(n: int) -> int:",
        "    return n * 2",
        "",
        "def test_double():",
        "    assert double(4) == 8",
        "",
        "def test_double_bad_type():",
        "    double('four')",
        "",
      ].join("\n");
      const reply = await send({
        type: "runFile",
        withTests: true,
        code,
        fileName: "tests.py",
        sessionKey: "tc-tests-11",
        level: "advanced",
      });
      expect(reply.result.ok === true, `assert rewriting + instrumentation should coexist: ${reply.result.error_message}`);
      const r = reply.result.tests ?? {};
      console.log(`    passed=${r.passed} failed=${r.failed} errors=${r.errors}`);
      const names = (r.tests || []).map((t) => `${t.name}:${t.outcome}`);
      console.log(`    ${names.join(" ")}`);
      expect(r.passed === 1, "the good test should pass, got " + r.passed);
      expect(
        r.failed + r.errors === 1,
        "the bad-type test should fail, got failed=" + r.failed + " errors=" + r.errors,
      );
      const bad = (r.tests || []).find((t) => t.name === "test_double_bad_type");
      expect(
        bad && /not an instance of int/.test(bad.message || ""),
        "the failure should explain the type problem, got " + (bad && bad.message),
      );
    }

    console.log("\n[12] assert-based test failures still report normally");
    {
      const code = "def double(n: int) -> int:\n    return n * 3\n\ndef test_double():\n    assert double(4) == 8\n";
      const reply = await send({
        type: "runFile",
        withTests: true,
        code,
        fileName: "tests.py",
        sessionKey: "tc-tests-12",
        level: "advanced",
      });
      const r = reply.result.tests ?? {};
      const t = (r.tests || [])[0];
      console.log(`    ${t && t.name}: ${t && t.outcome} / ${t && (t.message || "").split("\n")[0]}`);
      expect(r.failed === 1, "the assert should fail, got failed=" + r.failed);
      expect(
        t && /12|assert/.test(t.message || ""),
        "pytest's assert explanation should survive instrumentation, got " + (t && t.message),
      );
    }

    console.log("\n[13] the prompt is instrumented too");
    {
      const key = "tc-repl";
      await send({
        type: "runFile",
        code: "def add(x: int, y: int) -> int:\n    return x + y\n",
        fileName: "hello.py",
        sessionKey: key,
        level: "advanced",
      });
      const reply = await send({
        type: "replEval",
        code: 'add(1, "two")',
        sessionKey: key,
        level: "advanced",
      });
      const r = reply.result;
      console.log(`    ${r.error_type}: ${r.error_message}`);
      expect(r.error_type === "TypeCheckError", "prompt calls should be checked, got " + r.error_type);
      const good = (
        await send({ type: "replEval", code: "add(1, 2)", sessionKey: key, level: "advanced" })
      ).result;
      expect(good.result_repr === "3", "a valid prompt call should work, got " + good.result_repr);
    }
    console.log("\n[14] beginner/intermediate reject a bool where a number is annotated");
    {
      const cases = [
        ["bool argument for int", 'def f(n: int) -> int:\n    return n\n\nf(True)\n'],
        ["bool argument for float", 'def f(x: float) -> float:\n    return x\n\nf(True)\n'],
        ["bool returned for int", 'def f(n: int) -> int:\n    return True\n\nf(1)\n'],
        ["bool assigned to int", "count: int = True\n"],
        ["bool inside list[int]", 'def f(xs: list[int]) -> int:\n    return 0\n\nf([1, True])\n'],
      ];
      for (const [label, code] of cases) {
        const strict = await run(code, { level: "beginner" });
        const loose = await run(code, { level: "advanced" });
        console.log(
          `    ${label.padEnd(24)} beginner=${strict.error_type || "ok"} advanced=${loose.error_type || "ok"}`,
        );
        expect(
          strict.error_type === "TypeCheckError",
          `${label} should be rejected at beginner, got ` + (strict.error_type || "no error"),
        );
        expect(
          loose.ok === true,
          `${label} must still be allowed at advanced: ` + (loose.error_message || ""),
        );
      }
      // The rule must not leak into genuinely bool-typed code, or reject
      // ints where a float is annotated.
      const boolOk = await run(
        'def f(b: bool) -> bool:\n    return b\n\nf(True)\n',
        { level: "beginner" },
      );
      expect(boolOk.ok === true, "bool for bool must still be fine: " + (boolOk.error_message || ""));
      const towerOk = await run(
        'def cost(n: int) -> float:\n    return n * 25\n\ncost(2)\n',
        { level: "beginner" },
      );
      expect(towerOk.ok === true, "int for float must still be fine: " + (towerOk.error_message || ""));
    }

    console.log("\n[15] typeguard's wording is rewritten for students");
    {
      /** Run `code`, then push it through the host-side analyzer. */
      const finding = async (code, level = "advanced") => {
        const r = await run(code, { level });
        return findRuntimeFinding(code, "hello.py", level, pythonErrorFrom(r));
      };

      const arg = await finding(
        'def add(x: int, y: int) -> int:\n    return x + y\n\nresult = add(2, "three")\n',
      );
      console.log(`    arg      line ${arg.lineNumber}: ${arg.headline}`);
      expect(arg.errorType === "TypeMismatch", "should not surface typeguard's class name");
      expect(arg.lineNumber === 4, "an argument should be blamed on the call, got " + arg.lineNumber);
      expect(
        arg.headline === "`add` expects `y` to be a whole number (`int`), but got a string (`str`).",
        "argument headline: " + arg.headline,
      );
      expect(
        arg.howToFix.some((h) => h.includes("`int(...)`")),
        "should suggest the conversion, got " + JSON.stringify(arg.howToFix),
      );
      expect(
        !/instance of|typeguard/.test(arg.headline),
        "headline must not keep typeguard's vocabulary: " + arg.headline,
      );

      const ret = await finding('def label(n: int) -> str:\n    return n * 2\n\nlabel(5)\n');
      console.log(`    return   line ${ret.lineNumber}: ${ret.headline}`);
      expect(ret.lineNumber === 2, "a return should be blamed on the return, got " + ret.lineNumber);
      expect(/says it returns a string/.test(ret.headline), "return headline: " + ret.headline);

      const fell = await finding(
        'def grade(s: int) -> str:\n    if s > 90:\n        return "A"\n\ngrade(50)\n',
      );
      console.log(`    no-return: ${fell.headline}`);
      expect(
        /finished without returning a value/.test(fell.headline),
        "falling off the end should be explained as such: " + fell.headline,
      );
      expect(
        fell.howToFix.some((h) => h.includes("`else`")),
        "should mention the missing else, got " + JSON.stringify(fell.howToFix),
      );

      const variable = await finding('total: int = "lots"\n');
      console.log(`    variable: ${variable.headline}`);
      expect(variable.lineNumber === 1, "variable blamed on its line, got " + variable.lineNumber);
      expect(variable.nameToken === "total", "nameToken should be the variable, got " + variable.nameToken);

      const item = await finding(
        'def total(nums: list[int]) -> int:\n    return 0\n\ntotal([1, 2, "three"])\n',
      );
      console.log(`    list item: ${item.headline}`);
      expect(/every item in `nums`/.test(item.headline), "item headline: " + item.headline);
      // The index, and what is at it - "item 2 is not" left the student to
      // go and look.
      expect(
        /item 2 is the string "three"/.test(item.headline),
        "should name the index and the value: " + item.headline,
      );

      const union = await finding(
        'from typing import Optional\ndef f(x: Optional[int]) -> int:\n    return 0\n\nf("s")\n',
      );
      console.log(`    union:    ${union.headline}`);
      expect(
        /a whole number \(`int`\) or `None`/.test(union.headline),
        "a union should list its accepted types: " + union.headline,
      );

      const klass = await finding(
        "class Dog:\n    pass\n\ndef walk(d: Dog) -> None:\n    pass\n\nwalk(3)\n",
      );
      console.log(`    class:    ${klass.headline}`);
      expect(
        !/__main__/.test(klass.headline + klass.howToFix.join(" ")),
        "the __main__ prefix should be stripped: " + klass.headline + klass.howToFix.join(" "),
      );

      const dictValue = await finding(
        'def f(d: dict[str, int]) -> int:\n    return 0\n\nf({"a": "b"})\n',
      );
      console.log(`    dict:     ${dictValue.headline}`);
      expect(
        /every value in `d`/.test(dictValue.headline),
        "dict values are values, not items: " + dictValue.headline,
      );

      const boolNum = await finding(
        'def f(n: int) -> int:\n    return n\n\nf(True)\n',
        "beginner",
      );
      console.log(`    bool:     ${boolNum.headline}`);
      expect(
        /`True` or `False` \(`bool`\)/.test(boolNum.headline),
        "should name what arrived: " + boolNum.headline,
      );
      expect(
        boolNum.howToFix.some((h) => /Python counts them as/.test(h)),
        "should explain that this is PLL's rule, not Python's: " + JSON.stringify(boolNum.howToFix),
      );

      const none = await finding("def f(x: int) -> None:\n    return 5\n\nf(1)\n");
      console.log(`    -> None:  ${none.headline}`);
      expect(
        !/\(`None`\)/.test(none.headline),
        "should not say \"`None` (`None`)\": " + none.headline,
      );
    }
    console.log("\n[16] recursive data: forward references, and checked fields");
    {
      // `rest: "NumList"` is the shape of every recursive data definition.
      // `dataclasses` resolves a string annotation through
      // `sys.modules[cls.__module__]`, so the module a file runs as has to
      // be registered there, or this fails with `AttributeError: 'NoneType'
      // object has no attribute '__dict__'`.
      const recursive = [
        "from dataclasses import dataclass",
        "from typing import Optional",
        "",
        "@dataclass",
        "class Cons:",
        "    first: int",
        '    rest: "Optional[Cons]"',
        "",
        "def total(nl: \"Optional[Cons]\") -> int:",
        "    if nl is None:",
        "        return 0",
        "    return nl.first + total(nl.rest)",
        "",
        "def test_total():",
        "    assert total(Cons(1, Cons(2, None))) == 3",
        "",
        "print(total(Cons(1, Cons(2, None))))",
      ].join("\n");

      const ran = await run(recursive, { level: "beginner" });
      expect(ran.ok === true, `the run phase should work: ${ran.error_message ?? ""}`);
      expect(ran.stdout.trim() === "3", `expected 3, got ${JSON.stringify(ran.stdout)}`);

      const tested = await send({
        type: "runFile",
        withTests: true,
        code: recursive,
        fileName: "rec.py",
        sessionKey: "tc-rec",
        level: "beginner",
      }).then((r) => r.result);
      expect(tested.ok === true, `the run with tests must not crash: ${tested.error_type}: ${tested.error_message}`);
      expect(tested.tests?.passed === 1, `expected 1 passing test, got ${tested.tests?.passed}`);
      console.log("    a recursive dataclass runs and tests cleanly");

      // `@dataclass` writes `__init__` after typeguard has instrumented the
      // source, so its fields were never checked at all.
      const fields = [
        "from dataclasses import dataclass",
        "",
        "@dataclass",
        "class Dog:",
        "    name: str",
        "    age: int",
        "",
        "Dog(5, 3)",
      ].join("\n");
      const bad = await run(fields, { level: "beginner" });
      expect(bad.ok === false, "a dataclass field of the wrong type must be refused");
      expect(
        (bad.error_message ?? "").includes("name"),
        `the message should name the field, got ${bad.error_message}`,
      );
      const good = await run(fields.replace("Dog(5, 3)", 'Dog("Rex", 3)'), {
        level: "beginner",
      });
      expect(good.ok === true, `a well-typed dataclass still works: ${good.error_message ?? ""}`);

      // And a recursive field is checked too, which needs the annotation
      // resolved in the student's own namespace rather than `__main__`.
      const badRest = await run(
        recursive.replace("print(total(Cons(1, Cons(2, None))))", "Cons(1, 2)"),
        { level: "beginner" },
      );
      expect(badRest.ok === false, "a bad recursive field must be refused too");
      console.log("    dataclass fields are checked, including recursive ones");

      // At `#level raw` nothing is checked, so the same file has to run.
      const raw = await run(fields, { level: "raw" });
      expect(raw.ok === true, `#level raw must not check fields: ${raw.error_message ?? ""}`);
      console.log("    and #level raw still checks nothing");
    }

    console.log("\n[17] a type error inside a test is worded for students");
    {
      // The run path went through the analyzers; the test path did not, so
      // students read typeguard's own "is not an instance of str".
      const code = [
        "def shout(word: str) -> str:",
        "    return None",
        "",
        "def test_shout():",
        '    print("checking")',
        '    assert shout("hi") == "HI!"',
      ].join("\n");
      const result = await send({
        type: "runFile",
        withTests: true,
        code,
        fileName: "tw.py",
        sessionKey: "tc-tw",
        level: "beginner",
      }).then((r) => r.result);
      // The *worker* result still carries typeguard's own text; the
      // rewriting happens where the result becomes events, so that both the
      // editor's card and the command line get it. Check it there.
      const raw = (result.tests?.tests ?? [])[0];
      expect(raw !== undefined, "a test case should be reported");
      expect(
        (raw.message ?? "").includes("is not an instance of"),
        `the worker reports typeguard's text: ${raw.message}`,
      );

      const report = reportOf(result, "tw.py", "beginner", code);
      expect(report !== null, "a testReport event should be emitted");
      const test = { ...report.tests[0], message: shown(report.tests[0]) };
      expect(
        !(test.message ?? "").includes("is not an instance of"),
        `typeguard's wording must not reach the report: ${test.message}`,
      );
      expect(
        (test.message ?? "").includes("should return"),
        `expected PLL's wording, got ${test.message}`,
      );
      expect(
        (test.message ?? "").includes("returns `None` on this line"),
        `a written-out \`return None\` is said as much, got ${test.message}`,
      );
      // The function is named, not "this function": pytest prints the
      // frames, so the name is there to be read.
      expect(
        (test.message ?? "").includes("`shout`"),
        `the report should name the function, got ${test.message}`,
      );
      expect(
        !(test.message ?? "").includes("this function"),
        `and not call it "this function": ${test.message}`,
      );
      // `stdout` is on the case already - the command line just was not
      // printing it.
      expect((test.stdout ?? "").includes("checking"), `the test's output is carried: ${test.stdout}`);
      console.log(`    report message: ${JSON.stringify((test.message ?? "").split("\n")[0])}`);
    }

    console.log("\n[18] a `None` result is told apart from running off the end");
    {
      // One message for every `None` - "it finished without returning a
      // value" - describes the symptom. There are three quite different
      // causes, and each needs its own thing said about it.
      const cases = [
        {
          label: "ran off the end",
          code: 'def grade(score: int) -> str:\n    if score > 90:\n        return "A"\n\n\nprint(grade(50))\n',
          wanted: /finished without returning a value/,
          also: /every path through the function reaches a `return`/,
        },
        {
          label: "returned a name set from .append(...)",
          code:
            "def shout(words: list[str]) -> list[str]:\n" +
            "    result = []\n" +
            "    for w in words:\n" +
            "        result = result.append(w.upper())\n" +
            "    return result\n\n\n" +
            'print(shout(["hi"]))\n',
          wanted: /`result` was set to the result of `\.append\(\.\.\.\)` on line 5/,
          also: /changes the list in place and gives back nothing/,
        },
        {
          label: "a list pattern of a fixed length",
          code:
            "def my_len(nums: list[int]) -> int:\n" +
            "    match nums:\n" +
            "        case []:\n" +
            "            return 0\n" +
            "        case [first, rest]:\n" +
            "            return 1 + my_len(rest)\n\n\n" +
            "print(my_len([1, 2, 3]))\n",
          wanted: /No `case` in `my_len` fitted `nums`/,
          also: /matches a list of exactly 2 items; for a first and a rest, write `\[first, \*rest\]`/,
        },
        {
          label: "a union variant with no case",
          code:
            "from dataclasses import dataclass\n\n\n" +
            "@dataclass\nclass Boa:\n    name: str\n\n\n" +
            "@dataclass\nclass Armadillo:\n    name: str\n\n\n" +
            "Animal = Boa | Armadillo\n\n\n" +
            "def describe(a: Animal) -> str:\n" +
            "    match a:\n" +
            "        case Boa(name):\n" +
            '            return "a boa called " + name\n\n\n' +
            'print(describe(Armadillo("Dilly")))\n',
          wanted: /No `case` in `describe` fitted `a`/,
          also: /There is no `case` for `Armadillo`/,
        },

        {
          label: "a print where a return was meant",
          code: "def double(n: int) -> int:\n    print(n * 2)\n\n\nprint(double(2))\n",
          wanted: /finished without returning a value/,
          // One plain argument, so the suggestion is their own expression.
          also: /ends its branch with `print`: did you mean `return n \* 2`\?/,
        },
        {
          // fn-print-not-return: two branches return, and the third - the
          // one that ran - prints. "Prints and never returns" missed it.
          label: "a print ending the one branch that ran",
          code:
            "def add_shipping(order_amt: float) -> float:\n" +
            "    if order_amt <= 10:\n" +
            "        print(order_amt + 4)\n" +
            "    elif order_amt <= 30:\n" +
            "        return order_amt + 8\n" +
            "    else:\n" +
            "        return order_amt + 12\n\n\n" +
            "print(add_shipping(3.5))\n",
          wanted: /finished without returning a value/,
          also: /Line 4 ends its branch with `print`: did you mean `return order_amt \+ 4`\?/,
        },
      ];
      for (const { label, code, wanted, also } of cases) {
        const source = `#level beginner\n${code}`;
        const result = await run(source, { level: "beginner", fileName: "none.py" });
        expect(result.ok === false, `${label}: should fail`);
        const finding = findRuntimeFinding(
          source,
          "none.py",
          "beginner",
          pythonErrorFrom(result),
        );
        const text = `${finding.headline}\n${finding.howToFix.join("\n")}`;
        expect(wanted.test(finding.headline), `${label}: headline was ${finding.headline}`);
        expect(also.test(text), `${label}: wanted ${also}, got ${JSON.stringify(text)}`);
        // Once a print is found ending the branch, it is the cause: the
        // general advice ("an `if` with no `else`") would contradict it.
        if (/ends its branch with `print`/.test(text)) {
          expect(
            !/An `if` with no `else`|annotate the return type as `None`/.test(text),
            `${label}: no general advice beside the cause: ${text}`,
          );
        }
        // A `match` that fitted nothing is a missing case: annotating the
        // return type as `None` would hide the bug, so it is not offered.
        if (/No `case`/.test(finding.headline)) {
          expect(
            !/annotate the return type as `None`/.test(text),
            `${label}: no "annotate as None" for a missing case: ${text}`,
          );
        }
      }
      console.log("    off the end, a void method, a short pattern, a missing variant, a print");
    }

    console.log("\n[19] advice that fits where the value came from");
    {
      // A dataclass field, which typeguard words as an assignment because
      // that is the check being reused - and nobody assigned anything.
      const DC =
        "from dataclasses import dataclass\n\n\n@dataclass\nclass ITunesSong:\n" +
        "    name: str\n    singer: str\n    year: int\n\n\n";
      const field = `#level beginner\n${DC}s = ITunesSong("Yesterday", 2015, 1965)\n`;
      const fieldRun = await run(field, { level: "beginner", fileName: "dc.py" });
      expect(fieldRun.ok === false, "a wrong field type should fail");
      const fieldFinding = findRuntimeFinding(
        field,
        "dc.py",
        "beginner",
        pythonErrorFrom(fieldRun),
      );
      expect(
        fieldFinding.headline ===
          "The `singer` field of `ITunesSong` should be a string (`str`), but got `2015`.",
        `the field and the value are named: ${fieldFinding.headline}`,
      );
      expect(
        !/assigned/.test(fieldFinding.headline),
        `and it is not called an assignment: ${fieldFinding.headline}`,
      );

      // A value a library handed over, where "check the value you passed on
      // this line" names a line that passed nothing.
      const column =
        "#level beginner\n" +
        't = table(["wage"], [[10]])\n\n\n' +
        "def compute(r: dict) -> float:\n" +
        '    return r["wage"] * 2\n\n\n' +
        'print(t.transform_column("wage", compute))\n';
      const columnRun = await run(column, { level: "beginner", fileName: "tc.py" });
      expect(columnRun.ok === false, "a row function on a column should fail");
      const columnFinding = findRuntimeFinding(
        column,
        "tc.py",
        "beginner",
        pythonErrorFrom(columnRun),
      );
      const advice = columnFinding.howToFix.join("\n");
      expect(
        /transform_column` calls your function with one \*value\* from the column, not a row/.test(
          advice,
        ),
        `it should say what was handed over: ${JSON.stringify(columnFinding.howToFix)}`,
      );
      expect(
        !/value you passed for `r` on this line/.test(advice),
        `and not blame this line: ${advice}`,
      );
      console.log("    a dataclass field, and a value a library supplied");
    }

    console.log("\n[20] two floats that differ only in the dust");
    {
      // `0.9299999999999999 == 0.93` is how decimals work, not a mistake
      // in the student's arithmetic, and nothing in the failure said so.
      const code = "def test_close():\n    total = 1.1 * 3\n    assert total == 3.3\n";
      const result = await send({
        type: "runFile",
        withTests: true,
        code,
        fileName: "fl.py",
        sessionKey: "tc-fl",
        level: "raw",
      }).then((r) => r.result);
      const message = shown(reportOf(result, "fl.py", "raw", code)?.tests?.[0]);
      expect(/pytest\.approx\(3\.3\)/.test(message), `approx should be suggested: ${message}`);
      expect(
        /differ only in the last few digits/.test(message),
        `and the reason given: ${message}`,
      );

      // A test that fails for a real reason gets no such note.
      const wrong = "def test_wrong():\n    total = 1.0 * 3\n    assert total == 4.0\n";
      const other = await send({
        type: "runFile",
        withTests: true,
        code: wrong,
        fileName: "fw.py",
        sessionKey: "tc-fw",
        level: "raw",
      }).then((r) => r.result);
      const wrongMessage = shown(reportOf(other, "fw.py", "raw", wrong)?.tests?.[0]);
      expect(!/approx/.test(wrongMessage), `a genuinely wrong answer gets no approx note: ${wrongMessage}`);
      console.log("    approx suggested for rounding, and not for a wrong answer");
    }

    console.log("\n[21] errors raised inside a test are translated too");
    {
      // Every error in a test is translated, not only a type-annotation
      // failure.
      const reportFor = async (code, key) => {
        const result = await send({
          type: "runFile",
        withTests: true,
          code,
          fileName: "te.py",
          sessionKey: key,
          level: "raw",
        }).then((r) => r.result);
        return shown(reportOf(result, "te.py", "raw", code)?.tests?.[0]);
      };
      const listPlus = await reportFor(
        'def shout(words):\n    return words + "!"\n\n\ndef test_shout():\n    assert shout(["hi"]) == ["HI"]\n',
        "te-1",
      );
      expect(
        /A list and a string cannot be added together/.test(listPlus),
        `a TypeError inside a test: ${listPlus}`,
      );
      expect(!/can only concatenate/.test(listPlus), `with Python's wording gone: ${listPlus}`);

      const param = await reportFor(
        'def pen_cost(n, m):\n    return n * 2\n\n\ndef test_pen_cost(n):\n    assert pen_cost(n, "x") == 2\n',
        "te-2",
      );
      expect(
        /`test_pen_cost` is a test, so it cannot take any parameters/.test(param),
        `a test with a parameter: ${param}`,
      );

      // A plain failed assert is still shown as the assert, not reworded.
      const plain = await reportFor(
        "def add(a, b):\n    return a + b\n\n\ndef test_add():\n    assert add(1, 2) == 4\n",
        "te-3",
      );
      expect(/^assert 3 == 4/.test(plain), `a failed assert is left as it is: ${plain}`);

      // Through the same analyzers as a run error: a name error is explained
      // too, and a finding says where.
      const named = await reportFor("def test_x():\n    assert totl == 1\n", "te-4");
      expect(/Python doesn't know what `totl` means/.test(named), `a NameError inside a test: ${named}`);
      const located = await send({
        type: "runFile",
        withTests: true,
        code: 'def shout(words):\n    return words + "!"\n\n\ndef test_shout():\n    assert shout(["hi"]) == ["HI"]\n',
        fileName: "te.py",
        sessionKey: "te-5",
        level: "raw",
      }).then((r) => reportOf(r.result, "te.py", "raw", 'def shout(words):\n    return words + "!"\n'));
      const where = located?.tests?.[0]?.finding?.location?.label;
      expect(where === "te.py:2:12", `the error is placed in \`shout\`, not the test: ${where}`);
      expect(located?.tests?.[0]?.error === undefined, "and the report keeps the finding, not the exception");
      const paramWhere = (
        await send({
          type: "runFile",
        withTests: true,
          code: "def test_pen_cost(n):\n    assert n\n",
          fileName: "te.py",
          sessionKey: "te-6",
          level: "raw",
        }).then((r) => reportOf(r.result, "te.py", "raw", "def test_pen_cost(n):\n    assert n\n"))
      )?.tests?.[0]?.finding;
      expect(
        paramWhere !== undefined && paramWhere.location === null,
        `PLL called that test, so there is no line of theirs to point at: ${JSON.stringify(paramWhere?.location)}`,
      );
      console.log("    a TypeError and a parameter reworded; a failed assert left alone");
    }

    console.log("\n[22] a row is a dict, and a reactor's state comes from init");
    {
      // A row is `Row`, a dict subclass, but the course says a row's type is
      // `dict` - so the message must never ask anyone to annotate `Row`.
      const rows =
        "#level beginner\n" +
        't = table(["n"], [[1]])\n\n\n' +
        "def double(r: int) -> int:\n" +
        "    return 2\n\n\n" +
        'print(t.add_column("d", double))\n';
      const rowRun = await run(rows, { level: "beginner", fileName: "row.py" });
      expect(rowRun.ok === false, "a row passed to an int annotation should fail");
      const rowFinding = findRuntimeFinding(
        rows,
        "row.py",
        "beginner",
        pythonErrorFrom(rowRun),
      );
      const rowText = `${rowFinding.headline} ${rowFinding.howToFix.join(" ")}`;
      expect(!/\bRow\b/.test(rowText), `\`Row\` must not appear: ${rowText}`);
      expect(/`dict`/.test(rowText), `it is called a dict: ${rowText}`);

      // A reactor handler's argument is the reactor's state, which no line
      // passed - so "check the value you passed on this line" is wrong.
      const reactorSource =
        "#level beginner\n\n\n" +
        "def draw(state: str) -> Image:\n" +
        '    return circle(5, "solid", "red")\n\n\n' +
        "reactor(init=0, to_draw=draw).interact()\n";
      const rxRun = await run(reactorSource, { level: "beginner", fileName: "rx.py" });
      expect(rxRun.ok === false, "a handler that does not fit init should fail");
      const rxFinding = findRuntimeFinding(
        reactorSource,
        "rx.py",
        "beginner",
        pythonErrorFrom(rxRun),
      );
      const rxText = rxFinding.howToFix.join(" ");
      expect(/`init`/.test(rxText), `it should say the state started as init: ${rxText}`);
      expect(
        !/value you passed for `state` on this line/.test(rxText),
        `and not blame this line: ${rxText}`,
      );
      console.log("    a row is a dict; a reactor's state is traced to init");
    }

    console.log("\n[23] an element failure says what the element is");
    {
      // typeguard names the element that failed but not what it is; Python
      // reads it from the frame the check fired in.
      const code =
        "#level intermediate\n" +
        "def sum_list(lst: list[float]) -> float:\n" +
        "    total = 0.0\n" +
        "    for x in lst:\n" +
        "        total = total + x\n" +
        "    return total\n\n\n" +
        'sum_list(["1", "2", "3"])\n';
      const result = await run(code, { level: "intermediate", fileName: "items.py" });
      expect(result.ok === false, "a list of strings for list[float] should fail");
      const finding = findRuntimeFinding(
        code,
        "items.py",
        "intermediate",
        pythonErrorFrom(result),
      );
      expect(
        /but item 0 is the string "1"\.$/.test(finding.headline),
        `the element is described: ${finding.headline}`,
      );

      // A dict's values, by key.
      const dictCode =
        "#level intermediate\n" +
        "def total(prices: dict[str, float]) -> float:\n" +
        "    return 0.0\n\n\n" +
        'total({"tea": 2.5, "cake": "three"})\n';
      const dictRun = await run(dictCode, { level: "intermediate", fileName: "dict.py" });
      const dictFinding = findRuntimeFinding(
        dictCode,
        "dict.py",
        "intermediate",
        pythonErrorFrom(dictRun),
      );
      expect(
        /is the string "three"/.test(dictFinding.headline),
        `a dict value is described too: ${dictFinding.headline}`,
      );
      console.log("    a list item and a dict value, each shown as what it is");
    }

    console.log("\n[24] what Python can read from the frame: swaps, quoting, lengths");
    {
      const DC =
        "#level intermediate\nfrom dataclasses import dataclass\n\n\n@dataclass\nclass ITunesSong:\n" +
        "    name: str\n    singer: str\n    year: int\n\n\n";
      const findingFor = async (code, fileName) => {
        const result = await run(code, { level: "intermediate", fileName });
        return findRuntimeFinding(code, fileName, "intermediate", pythonErrorFrom(result));
      };

      // Two values in each other's places: converting one would hide it.
      const swappedCode = `${DC}s = ITunesSong("Yesterday", 2015, "The Beatles")\n`;
      const swapped = await findingFor(swappedCode, "swap.py");
      expect(
        /values for `singer` and `year` of `ITunesSong` look swapped/.test(swapped.headline),
        `a swap is named: ${swapped.headline}`,
      );

      // A string value, quoted as the course writes it.
      const stringYear = await findingFor(`${DC}s = ITunesSong("Yesterday", "The Beatles", "2015")\n`, "year.py");
      expect(/but got `"2015"`\.$/.test(stringYear.headline), `double quotes: ${stringYear.headline}`);
      expect(!/look swapped/.test(stringYear.headline), `and no swap where there is none: ${stringYear.headline}`);

      // An index error with the list's real length.
      const indexCode = "#level raw\nnums = [5, 1, 7]\nprint(nums[3])\n";
      const indexRun = await run(indexCode, { level: "raw", fileName: "idx.py" });
      const indexFinding = findRuntimeFinding(indexCode, "idx.py", "raw", pythonErrorFrom(indexRun));
      expect(
        indexFinding.howToFix.some((l) => /`nums` has 3 items, numbered 0 to 2/.test(l)),
        `the real length: ${JSON.stringify(indexFinding.howToFix)}`,
      );
      console.log("    a swap named, a string quoted, a length read from the list itself");
    }

    console.log("\n[25] Python describes an error as data, not as traceback text");
    {
      // `_pll_error_info` is the whole interface between an exception and
      // the host's explanations: where it is, whose frames, what was learned.
      // The file is mounted so Python can read its lines, as it is in a run.
      const described = async (code, level = "raw") => {
        await send({ type: "mountWorkspace", files: [{ name: "hello.py", contents: code }] });
        return run(code, { level });
      };

      const unknown = await described("total = 1\nprint(Total)\n");
      expect(unknown.error_type === "NameError", `type: ${unknown.error_type}`);
      expect(unknown.error_facts?.name === "Total", `the name: ${JSON.stringify(unknown.error_facts)}`);
      expect(
        /Did you mean: 'total'\?/.test(unknown.error_message),
        `Python's suggestion is part of the message it shows: ${unknown.error_message}`,
      );
      expect(unknown.line_number === 2 && unknown.column === 6, `at 2:6, got ${unknown.line_number}:${unknown.column}`);

      // A local read before it is assigned: Python sets no `name` for this
      // one, and the host still has to be told it.
      const local = await described("def f():\n    print(count)\n    count = 1\n\nf()\n");
      expect(local.error_type === "UnboundLocalError", `type: ${local.error_type}`);
      expect(local.error_facts?.name === "count", `the local's name: ${JSON.stringify(local.error_facts)}`);
      const free = await described(
        "def outer():\n    def inner():\n        return title\n    r = inner()\n    title = 1\n\nouter()\n",
      );
      expect(free.error_facts?.name === "title", `the free variable's name: ${JSON.stringify(free.error_facts)}`);

      // Python draws no caret under a name that is the whole line, so
      // there is no column to report.
      const whole = await described("totl\n");
      expect(whole.column == null, `no column for a whole-line name, got ${whole.column}`);

      // Whose frames: the student's, and PLL's own around them.
      const nested = await described("def a(n):\n    return b(n)\n\ndef b(n):\n    return n / 0\n\na(1)\n");
      const frames = (nested.error_frames ?? []).map((f) => `${f.user ? "user" : "pll"}:${f.function ?? "<module>"}:${f.line}`);
      expect(
        frames.filter((f) => f.startsWith("user")).join(",") === "user:<module>:7,user:a:2,user:b:5",
        `the student's frames, outermost first: ${frames.join(",")}`,
      );
      expect(frames[0]?.startsWith("pll:"), `PLL's own frame is there, and not the student's: ${frames[0]}`);
      expect(nested.line_number === 5, `the error is at the innermost frame: ${nested.line_number}`);

      // A recursion sends its innermost frames, not all thousand.
      const deep = await described("def f(n):\n    return f(n + 1)\n\nf(0)\n");
      expect(deep.error_type === "RecursionError", `type: ${deep.error_type}`);
      expect(
        deep.error_frames.length === 100 && deep.error_frames.every((f) => f.function === "f"),
        `100 frames, all of f: ${deep.error_frames.length}`,
      );

      // A syntax error is where Python says, with its message as shown.
      const syntax = await described("x = 1\nif x = 1:\n    pass\n");
      expect(syntax.error_type === "SyntaxError", `type: ${syntax.error_type}`);
      expect(syntax.line_number === 2 && syntax.column === 3, `at 2:3, got ${syntax.line_number}:${syntax.column}`);
      expect(!/hello\.py, line/.test(syntax.error_message), `no "(file, line)" in the message: ${syntax.error_message}`);

      // What was learned travels beside the message, not inside it.
      const index = await described("nums = [5, 1, 7]\nprint(nums[3])\n");
      expect(
        index.error_facts?.sequence === "nums" && index.error_facts?.length === 3,
        `the list and its length: ${JSON.stringify(index.error_facts)}`,
      );
      expect(index.error_message === "list index out of range", `the message is Python's: ${index.error_message}`);
      const element = await described(
        "def total(lst: list[float]) -> float:\n    return 0\n\ntotal([\"1\", 2.0])\n",
        "beginner",
      );
      expect(
        element.error_facts?.element_value === 'the string "1"',
        `the element that failed: ${JSON.stringify(element.error_facts)}`,
      );
      expect(!/->/.test(element.error_message), `and nothing appended to the message: ${element.error_message}`);
      const swapped = await described(
        [
          "from dataclasses import dataclass",
          "@dataclass",
          "class Song:",
          "    title: str",
          "    year: int",
          's = Song(1999, "x")',
        ].join("\n") + "\n",
        "beginner",
      );
      expect(swapped.error_facts?.swapped_with === "year", `the swap: ${JSON.stringify(swapped.error_facts)}`);
      const swappedCheck = swapped.error_facts?.check;
      expect(
        swappedCheck?.kind === "field" &&
          swappedCheck.name === "title" &&
          swappedCheck.owner === "Song" &&
          swappedCheck.value === "1999" &&
          swappedCheck.actual === "int" &&
          swappedCheck.expected.join() === "str" &&
          swappedCheck.level === "beginner",
        `the field check, in parts: ${JSON.stringify(swappedCheck)}`,
      );

      // typeguard's message, read into its parts once, by Python.
      const parts = async (code) => (await described(code, "beginner")).error_facts?.check;
      const same = (got, want) => JSON.stringify(got) === JSON.stringify(want);
      const typeguardShapes = [
        [
          'def f(x: int) -> int:\n    return x\n\nf("a")\n',
          { kind: "argument", name: "x", element: null, actual: "str", expected: ["int"], level: "beginner" },
        ],
        [
          'def f() -> int:\n    return "a"\n\nf()\n',
          { kind: "return", name: null, element: null, actual: "str", expected: ["int"], level: "beginner", annotation: "int" },
        ],
        // A return's annotation as written, for the advice to quote.
        [
          'def f() -> list[int]:\n    return ["a"]\n\nf()\n',
          { kind: "return", name: null, element: "item 0", actual: "list", expected: ["int"], level: "beginner", annotation: "list[int]" },
        ],
        ['x: int = "a"\n', { kind: "variable", name: "x", element: null, actual: "str", expected: ["int"], level: "beginner" }],
        [
          'def f(x: float) -> float:\n    return x\n\nf("a")\n',
          { kind: "argument", name: "x", element: null, actual: "str", expected: ["float"], level: "beginner" },
        ],
        [
          'def f(lst: list[float]) -> float:\n    return 0\n\nf(["1", 2.0])\n',
          { kind: "argument", name: "lst", element: "item 0", actual: "list", expected: ["float"], level: "beginner" },
        ],
        [
          'def f(d: dict[str, int]) -> int:\n    return 0\n\nf({"a": "1"})\n',
          { kind: "argument", name: "d", element: "value of key 'a'", actual: "dict", expected: ["int"], level: "beginner" },
        ],
      ];
      for (const [code, want] of typeguardShapes) {
        const got = await parts(code);
        expect(same(got, want), `${JSON.stringify(code)}: ${JSON.stringify(got)}`);
      }
      const union = await parts('def f(x: int | None) -> int:\n    return 0\n\nf("a")\n');
      expect(
        union?.kind === "argument" && union.name === "x" && union.expected.length === 2 && union.expected.includes("int"),
        `a union names what it accepts: ${JSON.stringify(union)}`,
      );
      const keyValue = await described('def f(d: dict[str, int]) -> int:\n    return 0\n\nf({"a": "1"})\n', "beginner");
      expect(
        keyValue.error_facts?.element_value === 'the string "1"',
        `a value by its key: ${JSON.stringify(keyValue.error_facts)}`,
      );

      // An IndexError in a file of its own, read from that file's line.
      await send({
        type: "mountWorkspace",
        files: [
          { name: "hello.py", contents: "from helper import get\nnums = [1, 2]\nget(nums)\n" },
          { name: "helper.py", contents: "def get(xs):\n    return xs[5]\n" },
        ],
      });
      const sibling = await run("from helper import get\nnums = [1, 2]\nget(nums)\n", { level: "beginner" });
      expect(
        sibling.error_facts?.sequence === "xs" && sibling.error_facts?.length === 2,
        `the sibling's own line: ${JSON.stringify(sibling.error_facts)}`,
      );

      // What the names in an error are, from the definitions themselves.
      const definitions = async (code, files = []) => {
        await send({ type: "mountWorkspace", files: [{ name: "hello.py", contents: code }, ...files] });
        const result = await run(code, { level: "advanced" });
        return { result, defs: result.error_facts?.definitions ?? {} };
      };
      // In another of their files, reached through its module.
      const area = await definitions("import shapes\nprint(shapes.area(3))\n", [
        { name: "shapes.py", contents: "def area(w, h):\n    return w * h\n" },
      ]);
      expect(
        same(area.defs.area, { kind: "function", parameters: ["w", "h"], required: ["w", "h"] }),
        `a function in another file: ${JSON.stringify(area.defs)}`,
      );
      const areaFinding = findRuntimeFinding("import shapes\nprint(shapes.area(3))\n", "hello.py", "advanced", pythonErrorFrom(area.result));
      expect(
        areaFinding.headline === "`area` takes 2 arguments (`w` and `h`), but got 1.",
        `and its total is said: ${areaFinding.headline}`,
      );
      // PLL's own, a function and a method of a class the student never wrote.
      const circleDefs = (await definitions("circle(10)\n")).defs;
      expect(
        same(circleDefs.circle?.required, ["radius", "mode", "color"]),
        `a library function: ${JSON.stringify(circleDefs)}`,
      );
      const plotDefs = (await definitions('t = table(["a", "b"], [[1, 2]])\nt.scatter_plot("a")\n')).defs;
      expect(
        same(plotDefs["Table.scatter_plot"], { kind: "function", parameters: ["x", "y", "title"], required: ["x", "y"] }),
        `a library method, without its self: ${JSON.stringify(plotDefs["Table.scatter_plot"])}`,
      );
      expect(plotDefs.Table?.kind === "class" && plotDefs.Table.students === false, `and its class is PLL's: ${JSON.stringify(plotDefs.Table)}`);
      // A dataclass of theirs, in another file, by the value it was asked of:
      // no name in this file reaches it.
      const dog = "from dataclasses import dataclass\n\n@dataclass\nclass Dog:\n    name: str\n    age: int\n";
      const dogDefs = (await definitions('import pets\nd = pets.Dog("Rex", 3)\nprint(d.nme)\n', [{ name: "pets.py", contents: dog }])).defs;
      expect(
        same(dogDefs.Dog, { kind: "class", students: true, fields: ["name", "age"], dataclass: true }),
        `a class of theirs: ${JSON.stringify(dogDefs)}`,
      );
      // In the file that ran, where PLL checks its fields in an `__init__` of its own.
      const initDefs = (await definitions(dog + 'Dog("Rex")\n')).defs;
      expect(
        same(initDefs["Dog.__init__"]?.parameters, ["name", "age"]),
        `a checked dataclass's own parameters: ${JSON.stringify(initDefs["Dog.__init__"])}`,
      );
      const unionDefs = (await definitions("class A:\n    pass\nclass B:\n    pass\nAB = A | B\nAB()\n")).defs;
      expect(same(unionDefs.AB, { kind: "union", members: ["A", "B"] }), `a union: ${JSON.stringify(unionDefs)}`);
      expect(
        (await definitions("x = 1\nx[0]\n")).defs.int?.students === false,
        "and Python's own classes are not theirs",
      );
      // Where a name on the line was set, and the parameters of the function.
      const sorted = await definitions("def f(xs):\n    r = xs.sort()\n    return r.total\n\nf([1])\n");
      expect(
        same(sorted.result.error_facts?.assigned?.r, { call: "xs.sort", line: 2 }),
        `what a name was set from: ${JSON.stringify(sorted.result.error_facts?.assigned)}`,
      );
      expect(
        same(sorted.result.error_frames.at(-1)?.parameters, ["xs"]),
        `a frame's parameters: ${JSON.stringify(sorted.result.error_frames.at(-1))}`,
      );
      const twice = await definitions(
        "def make(xs):\n    return xs\n\ndef f(xs):\n    r = make(xs)\n    r = xs.sort()\n    return r.total\n\nf([1])\n",
      );
      expect(
        same(twice.result.error_facts?.assigned?.r, { call: "xs.sort", line: 6 }),
        `the last time it was set: ${JSON.stringify(twice.result.error_facts?.assigned)}`,
      );
      // Set only after the line, by a loop that has gone round once.
      const looped = await definitions(
        "def find(i):\n    return None\n\nfor i in range(2):\n    if i:\n        print(x.total)\n    x = find(i)\n",
      );
      expect(
        same(looped.result.error_facts?.assigned?.x, { call: "find", line: 7 }),
        `or after it, in a loop: ${JSON.stringify(looped.result.error_facts?.assigned)}`,
      );

      // A function from an earlier prompt line is read from that line's own
      // input, not the line that called it.
      const prompt = (code) => send({ type: "replEval", code, sessionKey: "earlier-prompt", level: "advanced" });
      await prompt("def get(xs):\n    return xs[5]\n");
      await prompt("nums = [1, 2]");
      const later = (await prompt("print(get(nums))")).result;
      expect(
        later.error_frames.at(-1)?.text === "    return xs[5]" && later.error_frames.at(-1)?.column === 11,
        `its line and caret: ${JSON.stringify(later.error_frames.at(-1))}`,
      );
      expect(
        later.error_facts?.sequence === "xs" && later.error_facts?.length === 2,
        `and what is learned from it: ${JSON.stringify(later.error_facts)}`,
      );

      // Several lines submitted at once are judged as one input.
      const complete = async (code, whole) => (await send({ type: "checkSyntax", code, whole })).result.status;
      const fn = "def f():\n    x = 1\n\n    return x";
      expect(await complete(fn, true) === "complete", "a function with a blank line in it is whole");
      expect(await complete("x = 1\ny = 2", true) === "complete", "statements one after another are one input");
      expect(await complete("for x in [1]:", true) === "incomplete", "an unfinished block waits for more");
      expect(await complete("def f():\n    x = 1", false) === "incomplete", "a shell line still waits for a blank line");

      // A file another imports is held to its own level: a grader at `raw`
      // importing a student's beginner file gets the student's checks.
      const graded = async (grader, student, name = "student.py") => {
        await send({
          type: "mountWorkspace",
          files: [{ name: "grader.py", contents: grader }, { name, contents: student }],
        });
        return run(grader, { fileName: "grader.py", level: "raw" });
      };
      const refused = await graded("import student\n", "#level beginner\ntotal = 0\ntotal = 1\n");
      const checks = refused.error_facts?.checks;
      expect(refused.error_type === "ChecksFailed", `refused at the import: ${refused.error_type}`);
      expect(
        checks?.file === "student.py" && checks?.level === "beginner" &&
          checks.findings.map((f) => f.id).join() === "reassignment" && checks.header_problem === null,
        `with what its checks found: ${JSON.stringify(checks)}`,
      );
      const header = await graded("import student\n", "#level begginer\nx = 1\n");
      expect(
        header.error_type === "ChecksFailed" && header.error_facts?.checks?.header_problem?.line === 1,
        `a broken #level line refuses it too: ${JSON.stringify(header.error_facts?.checks)}`,
      );
      const student = "#level beginner\ndef count(n: int) -> int:\n    return n\n\ndef dot() -> Image:\n    return circle(5, \"solid\", \"red\")\n";
      const strict = await graded("from student import count\nprint(count(True))\n", student);
      expect(
        strict.error_type === "TypeCheckError" && strict.error_frames.at(-1)?.file === "student.py",
        `checked at its level, in its file: ${strict.error_type} ${JSON.stringify(strict.error_frames.at(-1))}`,
      );
      expect(strict.error_facts?.check?.level === "beginner", `the check says whose level: ${JSON.stringify(strict.error_facts?.check)}`);
      const strictFinding = findRuntimeFinding("from student import count\nprint(count(True))\n", "grader.py", "raw", pythonErrorFrom(strict));
      expect(
        strictFinding.howToFix.some((l) => /not accepted as numbers/.test(l)),
        `explained at the student's level, not the grader's: ${JSON.stringify(strictFinding.howToFix)}`,
      );
      // A warning is said when the file runs, and does not stop an import.
      const warned = await graded("import student\nprint(student.f())\n",
        '#level beginner\ndef f() -> int:\n    print("a".upper)\n    return 1\n');
      expect(warned.ok && /1\n$/.test(warned.stdout), `a warning does not refuse it: ${warned.error_message ?? warned.stdout}`);
      const drawn = await graded("from student import dot\nprint(dot() is not None)\n", student);
      expect(drawn.ok && drawn.stdout === "True\n", `with the names a run starts with: ${drawn.error_message ?? drawn.stdout}`);
      // Its level, not the importer's: an advanced helper takes a bool.
      const lenient = await graded("#level beginner\nfrom student import count\nprint(count(True))\n",
        "#level advanced\ndef count(n: int) -> int:\n    return n\n");
      expect(lenient.ok && lenient.stdout === "True\n", `an advanced file is advanced: ${lenient.error_message ?? lenient.stdout}`);
      // And a file with no header is plain Python.
      const plain = await graded("import student\nprint(student.f(\"x\"))\n", "def f(n: int) -> int:\n    return n\n\nf = f\n");
      expect(plain.ok && plain.stdout === "x\n", `raw is unchecked: ${plain.error_message ?? plain.stdout}`);
      await send({ type: "mountWorkspace", files: [] });
      await send({ type: "mountWorkspace", files: [] });
      console.log("    names, frames, columns, facts and messages, each from the exception itself");
    }
    console.log("\n[26] the libraries' errors, explained as the student wrote them");
    {
      const explain = async (code, level = "beginner", fileName = "lib.py") => {
        const result = await run(code, { level, fileName });
        const finding = findRuntimeFinding(code, fileName, level, pythonErrorFrom(result));
        return { result, finding, text: finding ? [finding.headline, ...finding.howToFix].join("\n") : "" };
      };
      const cases = [
        // A collection's item, not its container.
        ["def names() -> list[int]:\n    return [\"a\", \"b\"]\n\nnames()\n",
          ['says it returns `list[int]`, with every item in it a whole number (`int`), but item 0 is the string "a".',
            "change the annotation from `list[int]` to `list[str]`"]],
        ["def prices() -> dict[str, int]:\n    return {\"tea\": \"two\"}\n\nprices()\n",
          ['but the value for key "tea" is the string "two"', "from `dict[str, int]` to `dict[str, str]`"]],
        ['def pair() -> tuple[Image, Image]:\n    return (circle(5, "solid", "red"), 3)\n\npair()\n',
          ["says it returns `tuple[Image, Image]`", "item 1 is the number 3"]],
        // PLL's own classes are `Image` to a student.
        ['def t() -> Table:\n    return circle(5, "solid", "red")\n\nt()\n', ["this line returns `Image`"]],
        // A `-` where a name has `_`, and a method called as a function.
        ['load-table("cars.csv")\n', ["Python reads `load-table` as `load` minus `table`", "Write `load_table`"]],
        ['image-width(circle(5, "solid", "red"))\n', ["Write `image_width`"]],
        ['people = table(["age"], [[1]])\norder_by(people, "age")\n', ["`order_by` is a method of a table", 'Write `people.order_by("age")`']],
        ['people = table(["age"], [[1]])\nsum(people, "age")\n', ["is Python's own `sum`", 'A table does this itself: `people.sum("age")`']],
        ['people = table(["age"], [[1]])\nmax(people, "age")\n', ['A table does this itself: `people.max("age")`']],
        // A method without its brackets.
        ['people = table(["age"], [[1]])\nfor p in people.rows:\n    print(p)\n', ["`people.rows` is the method itself", "`for ... in people.rows():`"]],
        ['people = table(["age"], [[1]])\npeople.rows[0]\n', ["Call it first: `people.rows()[0]`"]],
        ['people = table(["age"], [[1]])\npeople.row[0]\n', ["Write `people.row(0)`"]],
        // The student's own function, raising inside transform_column, is explained with what it was given.
        ['def doubled(r):\n    return r["age"] * 2\n\npeople = table(["age"], [[1]])\npeople.transform_column("age", doubled)\n',
          ["one *value* from the column, not a row"]],
        // A package Pyodide has not got, and a file that is not there.
        ["import flask\n", ["There is no module called `flask` here.", "Pyodide, which has many packages"]],
        ['import importlib\nimportlib.import_module("micro" + "pip")\n', ["`micropip` was not loaded, because PLL did not see it imported.", "Add `import micropip`"]],
      ];
      for (const [code, needles] of cases) {
        const { text } = await explain(`#level beginner\n${code}`);
        for (const needle of needles) {
          expect(text.includes(needle), `${JSON.stringify(code.split("\n").at(-2))}: wanted "${needle}" in:\n${text}`);
        }
      }
      console.log(`    ${cases.length} library mistakes, each explained`);
    }

    console.log("\n[27] PLL's own names are not in the student's namespace");
    {
      const code = [
        "#level beginner",
        "def f(x: int) -> int:",
        "    return x",
        "y: int = 3",
        'print([n for n in dir() if n.startswith("_pll") or n in ("TypeCheckMemo", "check_argument_types_internal", "check_return_type_internal")])',
        "_pll_show_top_level = 0",
        "f(3)",
      ].join("\n");
      const result = await run(code, { level: "beginner", fileName: "ns.py" });
      expect(result.ok === true && result.stdout === "[]\n3\n", `nothing of PLL's or typeguard's, and values still shown: ${JSON.stringify(result.stdout)} ${result.error_message ?? ""}`);
      const checked = await run('#level beginner\ndef f(x: int) -> int:\n    return x\nf("a")\n', { level: "beginner", fileName: "ns2.py" });
      expect(checked.error_type === "TypeCheckError", `and the checks still run: ${checked.error_type}`);
      console.log("    dir() is the student's, and the checks still happen");
    }

  } finally {
    await worker.terminate();
  }

  console.log(`\nsmoke-typecheck: ${passed() ? "ok" : "FAILED"}`);
  if (!passed()) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
