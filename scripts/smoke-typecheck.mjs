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
import { build } from "esbuild";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const WORKER_PATH = resolve(ROOT, "dist", "desktop", "pyodideWorker.js");
const INDEX_URL = resolve(ROOT, "node_modules", "pyodide");

let ok = true;
function expect(cond, msg) {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    ok = false;
  }
}

function talk(worker) {
  let nextId = 1;
  const pending = new Map();
  worker.on("message", (msg) => {
    if (msg.type === "display" || msg.type === "stdinRequest") return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.type === "error") p.reject(new Error(msg.message));
    else p.resolve(msg);
  });
  worker.on("error", (err) => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  });
  return (payload) => {
    const id = nextId++;
    const promise = new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
    worker.postMessage({ id, ...payload });
    return promise;
  };
}

/** Bundle the host-side analyzer so the rewritten messages can be checked. */
async function loadAnalyzer() {
  const tmp = mkdtempSync(join(ROOT, ".smoke-"));
  writeFileSync(
    join(tmp, "entry.mjs"),
    `
export { findRuntimeFinding } from "../src/common/analyzers/registry";
export { parsePythonError } from "../src/common/errors/pythonErrorParser";
export { deliverTestResult } from "../src/common/deliverResult";
`,
  );
  await build({
    entryPoints: [join(tmp, "entry.mjs")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: join(tmp, "out.mjs"),
    loader: { ".py": "text", ".whl": "base64" },
    external: ["vscode"],
    absWorkingDir: ROOT,
  });
  const mod = await import(pathToFileURL(join(tmp, "out.mjs")).href);
  rmSync(tmp, { recursive: true, force: true });
  return mod;
}

async function main() {
  if (!existsSync(WORKER_PATH)) {
    console.error(`Missing ${WORKER_PATH}. Run \`pnpm run build\` first.`);
    process.exit(1);
  }
  const { findRuntimeFinding, parsePythonError, deliverTestResult } = await loadAnalyzer();
  const worker = new Worker(WORKER_PATH);
  const send = talk(worker);
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
        type: "runTests",
        code,
        fileName: "tests.py",
        level: "advanced",
      });
      const r = reply.result;
      console.log(`    passed=${r.passed} failed=${r.failed} errors=${r.errors}`);
      const names = (r.tests || []).map((t) => `${t.name}:${t.outcome}`);
      console.log(`    ${names.join(" ")}`);
      expect(r.internal_error !== true, "assert rewriting + instrumentation should coexist");
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
        type: "runTests",
        code,
        fileName: "tests.py",
        level: "advanced",
      });
      const r = reply.result;
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
        const traceback = r.traceback || `${r.error_type}: ${r.error_message}`;
        const parsed = parsePythonError(traceback);
        if (parsed.lineNumber === null && r.line_number !== null) {
          parsed.lineNumber = r.line_number;
        }
        return findRuntimeFinding(code, "hello.py", level, parsed);
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
      expect(/item 2 is not/.test(item.headline), "should name the index: " + item.headline);

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
      // `rest: "NumList"` is the shape of every recursive data definition,
      // and it used to take the whole test phase down with
      // `AttributeError: 'NoneType' object has no attribute '__dict__'` -
      // `dataclasses` resolves a string annotation through
      // `sys.modules[cls.__module__]`, and nothing was registered there.
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
        type: "runTests",
        code: recursive,
        fileName: "rec.py",
        sessionKey: "tc-rec",
        level: "beginner",
      }).then((r) => r.result);
      expect(
        tested.internal_error !== true,
        `the test phase must not crash: ${tested.error_type}: ${tested.error_message}`,
      );
      expect(tested.passed === 1, `expected 1 passing test, got ${tested.passed}`);
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
        type: "runTests",
        code,
        fileName: "tw.py",
        sessionKey: "tc-tw",
        level: "beginner",
      }).then((r) => r.result);
      // The *worker* result still carries typeguard's own text; the
      // rewriting happens where the result becomes events, so that both the
      // editor's card and the command line get it. Check it there.
      const raw = (result.tests ?? [])[0];
      expect(raw !== undefined, "a test case should be reported");
      expect(
        (raw.message ?? "").includes("is not an instance of"),
        `the worker reports typeguard's text: ${raw.message}`,
      );

      let report = null;
      deliverTestResult(result, (event) => {
        if (event.kind === "testReport") report = event;
      }, "tw.py", "beginner");
      expect(report !== null, "a testReport event should be emitted");
      const test = report.tests[0];
      expect(
        !(test.message ?? "").includes("is not an instance of"),
        `typeguard's wording must not reach the report: ${test.message}`,
      );
      expect(
        (test.message ?? "").includes("should return"),
        `expected PLL's wording, got ${test.message}`,
      );
      // `stdout` is on the case already - the command line just was not
      // printing it.
      expect((test.stdout ?? "").includes("checking"), `the test's output is carried: ${test.stdout}`);
      console.log(`    report message: ${JSON.stringify((test.message ?? "").split("\n")[0])}`);
    }

  } finally {
    await worker.terminate();
  }

  console.log(`\nsmoke-typecheck: ${ok ? "ok" : "FAILED"}`);
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
