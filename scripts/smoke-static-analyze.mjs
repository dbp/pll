#!/usr/bin/env node
/**
 * Smoke test for the language-level static analyzer.
 *
 * Boots Pyodide in Node with PLL installed the way the worker installs it,
 * and runs `_pll_static_analyze` against each sample file. Asserts a sensible set
 * of findings is produced (or none, for the OK sample).
 *
 * Usage: node scripts/smoke-static-analyze.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { bootPll } from "./lib/pyodide.mjs";
import { expect, passed } from "./lib/check.mjs";
import { importSource } from "./lib/bundle.mjs";

const { LEVEL_NAMES } = await importSource('export { LEVEL_NAMES } from "./src/core/level";');
import { ROOT } from "./lib/bundle.mjs";

function readPy(rel) {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

async function main() {
  const pyodide = await bootPll();

  const fn = pyodide.globals.get("_pll_static_analyze");
  const analyze = (code, level, fileName, sessionKey = null) => {
    const proxy = fn(code, level, fileName, sessionKey);
    const obj = proxy.toJs({ dict_converter: Object.fromEntries });
    proxy.destroy?.();
    return obj;
  };
  const pllCall = pyodide.globals.get("_pll_call");
  /**
   * The findings as the student reads them: Python's wording of each.
   * (`toJs` made each `None` undefined; it goes back as `null`.)
   */
  const wordStatic = (raw, level, fileName) =>
    raw.map((finding) =>
      JSON.parse(pllCall("_pll_word_static", JSON.stringify([finding, level, fileName], (_, v) => v ?? null))),
    );

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
      console.log(`      [${f.id}] line ${f.line_number}: ${f.error_type} ${f.name_token ?? ""}${outer}`);
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
      console.log(`      [${f.id}] line ${f.line_number}: ${f.error_type} ${f.name_token ?? ""}`);
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
      console.log(`      [${f.id}] line ${f.line_number}: ${f.error_type} ${f.name_token ?? ""}`);
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
      console.log(`      [${f.id}] line ${f.line_number}: ${f.error_type} ${f.name_token ?? ""}`);
    }
    const ids = findings.map((f) => f.id);
    expect(ids.includes("shadowing"), "intermediate must still flag shadowing");
    expect(
      ids.includes("shadowing-builtin"),
      "intermediate must still flag shadowing of built-ins",
    );
  }

  console.log(
    "\n[9] intermediate_keyword.py - expect 'disallowed-keyword' findings (global + nonlocal), and `del`",
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
        `      [${f.id}] line ${f.line_number}: ${f.error_type} ${f.name_token ?? ""} (keyword=${f.keyword})`,
      );
    }
    const kw = findings.filter((f) => f.id === "disallowed-keyword");
    const keywords = new Set(kw.map((f) => f.keyword));
    expect(kw.length >= 2, "expected at least one finding per keyword");
    expect(keywords.has("global"), "missing 'global' finding");
    expect(keywords.has("nonlocal"), "missing 'nonlocal' finding");
    expect(findings.some((f) => f.id === "unbinding"), "missing the `del` of a name");
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

  console.log(
    "\n[14] library shadowing: redefining a library name is a finding",
  );
  {
    // The image / table / reactor names are bound in every session before
    // the student writes anything, so redefining one is shadowing exactly
    // like a built-in - but reported as `shadowing-library` with the
    // library the name comes from.
    const simple = analyze("circle = 5\n", "beginner", "t.py");
    expect(simple.length === 1, "circle = 5 is one finding");
    expect(
      simple[0].id === "shadowing-library" && simple[0].name_token === "circle",
      "circle = 5 is shadowing-library",
    );
    expect(
      simple[0].library === "image" && simple[0].line_number === 1,
      "circle is attributed to the image library on line 1",
    );

    const fnDef = analyze("def rectangle(w, h):\n    return w * h\n", "beginner", "t.py");
    expect(
      fnDef.length === 1 && fnDef[0].id === "shadowing-library" && fnDef[0].library === "image",
      "def rectangle(...) is shadowing-library (image)",
    );

    const cls = analyze("class Image:\n    pass\n", "beginner", "t.py");
    expect(
      cls.length === 1 && cls[0].id === "shadowing-library",
      "class Image is shadowing-library",
    );

    const tableLib = analyze("table = 5\n", "beginner", "t.py");
    expect(
      tableLib.length === 1 && tableLib[0].library === "table",
      "table is attributed to the table library",
    );

    const reactorLib = analyze("animate = 5\n", "beginner", "t.py");
    expect(
      reactorLib.length === 1 && reactorLib[0].library === "reactor",
      "animate is attributed to the reactor library",
    );

    // Inner scopes and parameter names, matching how builtins are treated.
    const inner = analyze("def f():\n    circle = 1\n", "beginner", "t.py");
    expect(
      inner.length === 1 &&
        inner[0].id === "shadowing-library" &&
        inner[0].line_number === 2,
      "function-scope circle is flagged on its own line",
    );

    const param = analyze("def f(rotate):\n    return rotate\n", "beginner", "t.py");
    expect(
      param.length === 1 && param[0].id === "shadowing-library",
      "a parameter named like a library function is flagged",
    );

    const loop = analyze("for star in [1, 2]:\n    print(star)\n", "beginner", "t.py");
    expect(
      loop.length === 1 && loop[0].id === "shadowing-library",
      "a for-loop target named like a library function is flagged",
    );

    // Intermediate flags shadowing just like beginner; raw and advanced
    // run plain Python.
    const inter = analyze("def f():\n    text = 1\n", "intermediate", "t.py");
    expect(
      inter.length === 1 && inter[0].id === "shadowing-library",
      "intermediate still flags library shadowing",
    );
    expect(
      analyze("circle = 5\n", "raw", "t.py").length === 0,
      "raw does not flag library shadowing",
    );
    expect(
      analyze("circle = 5\n", "advanced", "t.py").length === 0,
      "advanced does not flag library shadowing",
    );

    // Using the library is, of course, fine.
    expect(
      analyze("c = circle(5, 'solid', 'red')\n", "beginner", "t.py").length === 0,
      "calling circle(...) is not a finding",
    );
    expect(
      analyze("s = beside(square(10, 'solid', 'red'), circle(10, 'solid', 'blue'))\n", "beginner", "t.py").length === 0,
      "composing library calls is not a finding",
    );

    // A name both imported from a pll module and assigned: the import just
    // re-binds the library's own value (not a finding), the assignment is.
    const imported = analyze("from pll.image import circle\n", "beginner", "t.py");
    expect(imported.length === 0, "importing a library name is not a finding");
    const importedThenAssigned = analyze(
      "from pll.image import circle\ncircle = 5\n",
      "beginner",
      "t.py",
    );
    expect(
      importedThenAssigned.length === 1 &&
        importedThenAssigned[0].id === "shadowing-library" &&
        importedThenAssigned[0].line_number === 2,
      "assigning after a pll import is flagged on the assignment line",
    );

    // The student's own outer binding wins over the library label: the
    // finding must point at their line, not blame the library.
    const ownOuter = analyze(
      "def area(r):\n    return 3.14 * r * r\n\ndef helper():\n    def area(r):\n        return r\n",
      "beginner",
      "t.py",
    );
    expect(
      ownOuter.length === 1 &&
        ownOuter[0].id === "shadowing" &&
        ownOuter[0].outer_line_number === 1,
      "shadowing an outer user binding stays a plain shadowing finding",
    );

    // A library name shadowing a user's outer binding: the enclosing scope
    // is more specific than the library, so the inner binding is a plain
    // shadowing finding pointing at the user's own definition.
    const libInner = analyze(
      "def circle(r):\n    return r\n\ndef helper():\n    circle = 1\n",
      "beginner",
      "t.py",
    );
    expect(
      libInner.length === 2 &&
        libInner.some(
          (f) => f.id === "shadowing-library" && f.line_number === 1,
        ) &&
        libInner.some(
          (f) =>
            f.id === "shadowing" &&
            f.line_number === 5 &&
            f.outer_line_number === 1,
        ),
      "def circle is shadowing-library; inner circle=1 shadows the user's def",
    );
  }

  console.log(
    "\n[15] library shadowing at the REPL prompt (session bindings)",
  );
  {
    pyodide.runPython(`
_g = _pll_get_session("smoke-lib")
`);
    const blocked = analyze("circle = 5", "beginner", "<repl>", "smoke-lib");
    expect(
      blocked.length === 1 && blocked[0].id === "shadowing-library",
      "circle = 5 at the prompt is shadowing-library",
    );
    const fine = analyze("c = circle(5, 'solid', 'red')", "beginner", "<repl>", "smoke-lib");
    expect(fine.length === 0, "using circle at the prompt is not a finding");
    const nested = analyze(
      "def f():\n    rectangle = 1\n",
      "beginner",
      "<repl>",
      "smoke-lib",
    );
    expect(
      nested.length === 1 && nested[0].id === "shadowing-library",
      "nested library shadowing at the prompt is flagged",
    );
  }

  console.log(
    "\n[16] a name bound in a class body is a field, not a shadowed variable",
  );
  {
    // `id: int` in a dataclass declares a field. `id` everywhere else still
    // finds the built-in, so there is nothing shadowed, and a finding would
    // tell students to rename a perfectly good field.
    const fields = analyze(
      [
        "@dataclass",
        "class Dog:",
        "    id: int",
        "    list: str",
        "    name: str",
        "",
      ].join("\n"),
      "beginner",
      "t.py",
    );
    expect(fields.length === 0, `class fields must be clean, got ${JSON.stringify(fields)}`);

    // A plain assignment in a class body is an attribute too.
    const attr = analyze("class Box:\n    sum = 0\n", "beginner", "t.py");
    expect(attr.length === 0, `class attributes must be clean, got ${JSON.stringify(attr)}`);

    // The class's own name is bound in the enclosing scope, and is still
    // checked there.
    const named = analyze("class list:\n    pass\n", "beginner", "t.py");
    expect(
      named.length === 1 && named[0].id === "shadowing-builtin",
      `a class named after a built-in is still caught, got ${JSON.stringify(named)}`,
    );

    // And a module-level `id = 5` is still shadowing.
    const module = analyze("id = 5\n", "beginner", "t.py");
    expect(
      module.length === 1 && module[0].id === "shadowing-builtin",
      `a real rebinding is still caught, got ${JSON.stringify(module)}`,
    );
    console.log("    fields and attributes clean; class names and rebindings still caught");
  }

  console.log("\n[17] mistakes that would otherwise run without a word");
  {
    // Every one of these is valid Python that does nothing, or something
    // other than what was meant, so there is no error to go on: the only
    // evidence a student has is a program that seems to work.
    for (const [label, code, id, line] of [
      [
        "a test written without assert",
        'def pen_cost(n, m):\n    return n * 2\n\n\ndef test_pen_cost():\n    pen_cost(0, "huskies") == 1\n',
        "unused-comparison",
        6,
      ],
      [
        "a value computed and dropped",
        "def deposit(balance, amt):\n    balance + amt\n    return balance\n",
        "unused-value",
        2,
      ],
      ["a number on a line of its own, as Pyret's answer", "def ten():\n    10\n", "unused-value", 2],
      ["a comparison as the answer", "def is_five(x):\n    x == 5\n", "unused-comparison", 2],
      ["assert on a tuple", "def test_add():\n    assert(1 + 1, 2)\n", "assert-tuple", 2],
      [
        "a method named but not called",
        'def report(t):\n    print(t.mean)\n',
        "method-not-called",
        2,
      ],
      ["a new list thrown away", "def tidy(xs: list[int]) -> list[int]:\n    sorted(xs)\n    return xs\n", "unused-value", 2],
      ["a string method's answer thrown away", "def shout(name: str) -> str:\n    name.upper()\n    return name\n", "unused-value", 2],
      [
        "replace's answer thrown away",
        "from dataclasses import replace\n\n\n@dataclass\nclass P:\n    age: int\n\n\ndef older(p: P) -> P:\n    replace(p, age=p.age + 1)\n    return p\n",
        "unused-value",
        10,
      ],
      ["a table made and thrown away", 'def with_total(t):\n    t.add_column("total", [1])\n    return t\n', "unused-value", 2],
      ["a picture made and thrown away", 'def dot():\n    circle(5, "solid", "red")\n    return 1\n', "unused-value", 2],
      ["math's answer thrown away", "import math\n\n\ndef root(x: float) -> float:\n    math.sqrt(x)\n    return x\n", "unused-value", 5],
      [
        "an imported function's answer thrown away, under a name of its own",
        "from random import sample as pick\n\n\ndef few(xs: list[int]) -> list[int]:\n    pick(xs, 2)\n    return xs\n",
        "unused-value",
        5,
      ],
      [
        "a method of their own named but not called",
        "class Shelf:\n    def items(self):\n        return []\n\n\ndef show(s):\n    print(s.items)\n",
        "method-not-called",
        7,
      ],
      [
        "an annotation that is a function",
        'def summarise(t: table) -> str:\n    return "x"\n',
        "annotation-not-a-type",
        1,
      ],
      [
        "an annotation that is a misspelling",
        "def shout(word: string) -> str:\n    return word\n",
        "annotation-not-a-type",
        1,
      ],
      [
        "an annotation naming something that is not a function either",
        "def shrink(pic: image) -> str:\n    return \"x\"\n",
        "annotation-not-a-type",
        1,
      ],
      [
        "a helper with an assert that nothing runs",
        'def check_total():\n    assert 1 == 1\n\n\nprint("hi")\n',
        "test-not-named",
        1,
      ],
    ]) {
      const findings = analyze(code, "beginner", "silence.py");
      const found = findings.find((f) => f.id === id);
      expect(found !== undefined, `${label}: expected a ${id}, got ${JSON.stringify(findings)}`);
      if (found !== undefined) {
        expect(
          found.line_number === line,
          `${label}: expected line ${line}, got ${found.line_number}`,
        );
      }
    }
    console.log("    eight silent mistakes now reported");

    // And the shapes that are correct have to stay silent, or every file
    // in the course lights up.
    for (const [label, code] of [
      ["a top-level expression, which is displayed", '1 + 2\n"a string"\n'],
      ["a helper that is called", "def check():\n    assert 1 == 1\n\n\ncheck()\n"],
      ["a real test", "def test_ok():\n    assert 1 == 1\n"],
      ["a proper annotation", "def shout(word: str) -> str:\n    return word\n"],
      ["a method that is called", "def report(t):\n    print(t.mean())\n"],
      ["a docstring", 'def f(x):\n    """What it does."""\n    return x\n'],
      ["a call for its effect", "def f(xs):\n    xs.append(1)\n    return xs\n"],
      // A function that takes a function is given one on purpose.
      ["a method passed as a function", "def f(xs):\n    return sorted(xs, key=str.lower)\n"],
      // A class that writes its own `__init__` is not a dataclass.
      [
        "a class with its own __init__",
        "class Counter:\n    count: int\n\n    def __init__(self):\n        self.count = 0\n",
      ],
      // A dataclass field whose name happens to match a method: `s.count`
      // is exactly right, and `count` is a very ordinary field name.
      [
        "a field named like a method",
        "@dataclass\nclass Song:\n    count: int\n\n\ndef show(s: Song):\n    print(s.count)\n",
      ],
      // A call that may be there for what it does: a function or a method
      // of their own (whatever it is called), a library function that
      // changes something, and a function handed in.
      ["a function of their own, called for what it does", "def show(x: int) -> None:\n    print(x)\n\n\ndef f(x: int) -> int:\n    show(x)\n    return x\n"],
      ["a method of their own named like a string's", 'class Pen:\n    def split(self):\n        print("split")\n\n\ndef f(p):\n    p.split()\n    return p\n'],
      ["a library function that does something", "import random\n\n\ndef f(xs):\n    random.seed(1)\n    return xs\n"],
      ["a function handed in", "def apply(f, x):\n    f(x)\n    return x\n"],
      // So is an attribute a class sets for itself, a class attribute, and
      // a property: each is data, read without a call.
      [
        "an attribute set in __init__, named like a method",
        "class Shelf:\n    def __init__(self):\n        self.items = []\n\n\ndef show(s):\n    print(s.items)\n",
      ],
      ["a class attribute named like a method", "class Config:\n    count = 3\n\n\ndef show(c):\n    print(c.count)\n"],
      [
        "a property named like a method",
        "class Box:\n    @property\n    def count(self):\n        return 1\n\n\ndef show(b):\n    print(b.count)\n",
      ],
      // A class of their own called `Number` is a type.
      [
        "an annotation naming their own class",
        "@dataclass\nclass Number:\n    value: int\n\n\ndef twice(n: Number) -> Number:\n    return n\n",
      ],
      // `type(a) == Boa` is a real check, however unidiomatic.
      [
        "a type() comparison",
        "@dataclass\nclass Boa:\n    name: str\n\n\ndef f(a):\n    return type(a) == Boa\n",
      ],
    ]) {
      const findings = analyze(code, "beginner", "quiet.py");
      expect(findings.length === 0, `${label} should stay silent, got ${JSON.stringify(findings)}`);
    }
    console.log("    and correct code stays silent");

    // What a call that only gives back a new value leaves as it was: its
    // first argument, or what it is called on - or nothing in particular.
    for (const [code, unchanged] of [
      ["def tidy(xs: list[int]) -> list[int]:\n    sorted(xs)\n    return xs\n", "xs"],
      ["def shout(name: str) -> str:\n    name.upper()\n    return name\n", "name"],
      ['def dot():\n    circle(5, "solid", "red")\n    return 1\n', undefined],
    ]) {
      const found = analyze(code, "beginner", "silence.py").find((f) => f.id === "unused-value");
      expect(found?.unchanged === unchanged, `what stays as it was: ${JSON.stringify(found)}`);
    }
    console.log("    a call that only gives back a new value, thrown away, says what stays as it was");

    // Only at the levels that have static checks.
    const raw = analyze("def test_x():\n    assert(1, 2)\n", "raw", "silence.py");
    expect(raw.length === 0, `raw has no static checks, got ${JSON.stringify(raw)}`);
    console.log("    none of them at #level raw");
  }

  console.log("\n[18] advice that points the right way");
  {
    // A duplicated `def` is not a reassigned variable: the Reassignment
    // advice is about accumulators and running totals, and the fix here is
    // to rename one of them.
    const twice = analyze(
      "def test_add():\n    assert 1 == 1\n\n\ndef test_add():\n    assert 2 == 2\n",
      "beginner",
      "dup.py",
    );
    const duplicate = twice.find((f) => f.id === "duplicate-definition");
    expect(duplicate !== undefined, `expected a duplicate-definition, got ${JSON.stringify(twice)}`);
    expect(
      twice.every((f) => f.id !== "reassignment"),
      `and no reassignment finding: ${JSON.stringify(twice)}`,
    );
    if (duplicate !== undefined) {
      expect(duplicate.first_line_number === 1, `the first one is named: ${duplicate.first_line_number}`);
      expect(duplicate.definition_kind === "function", `as a function: ${duplicate.definition_kind}`);
    }

    // `global x` at intermediate produced its own finding *and* a
    // Shadowing for the same name, which reads as two separate mistakes.
    const globals_ = analyze(
      "total = 0\n\n\ndef add(n):\n    global total\n    total = total + n\n",
      "intermediate",
      "g.py",
    );
    expect(
      globals_.length === 1 && globals_[0].id === "disallowed-keyword",
      `only the keyword finding: ${JSON.stringify(globals_)}`,
    );

    // A dataclass field written the wrong way, which otherwise goes wrong
    // somewhere else entirely - as a NameError, or in an argument count.
    const fields = analyze(
      "@dataclass\nclass Boa:\n    name: str\n    year = int\n    length\n",
      "beginner",
      "dc.py",
    );
    expect(
      fields.some((f) => f.id === "field-assigned-type" && f.line_number === 4),
      `\`year = int\` is flagged: ${JSON.stringify(fields)}`,
    );
    expect(
      fields.some((f) => f.id === "field-assigned-type" && f.written_type === "int"),
      `with the type written carried through: ${JSON.stringify(fields)}`,
    );
    const asStr = analyze(
      "@dataclass\nclass Song:\n    name = str\n",
      "beginner",
      "dc2.py",
    );
    expect(
      asStr.some((f) => f.id === "field-assigned-type" && f.written_type === "str"),
      `\`name = str\` carries \`str\`, not \`int\`: ${JSON.stringify(asStr)}`,
    );
    expect(
      fields.some((f) => f.id === "field-no-type" && f.line_number === 5),
      `a field with no type is flagged: ${JSON.stringify(fields)}`,
    );

    // A function written above the class it compares against is ordinary,
    // so the class names are collected before anything else is looked at.
    const above = analyze(
      "def f(a):\n    return a == Boa\n\n\n@dataclass\nclass Boa:\n    name: str\n",
      "beginner",
      "order.py",
    );
    expect(
      above.some((f) => f.id === "compared-with-class" && f.line_number === 2),
      `a comparison above the class is still seen: ${JSON.stringify(above)}`,
    );

    // `if a == Boa:` is always False, and runs without complaint.
    const compared = analyze(
      "@dataclass\nclass Boa:\n    name: str\n\n\ndef f(a):\n    return a == Boa\n",
      "beginner",
      "cmp.py",
    );
    expect(
      compared.some((f) => f.id === "compared-with-class" && f.line_number === 7),
      `comparing with a class is flagged: ${JSON.stringify(compared)}`,
    );
    // Comparing with an ordinary value is not.
    const fine = analyze(
      "def f(a, b):\n    return a == b\n",
      "beginner",
      "cmp2.py",
    );
    expect(fine.length === 0, `an ordinary comparison stays silent: ${JSON.stringify(fine)}`);
    // Every wrong annotation carries the name as written, which is what
    // its wording is built from.
    for (const written of ["table", "reactor", "image", "row", "string"]) {
      const code = `def f(x: ${written}) -> str:\n    return "x"\n`;
      const found = analyze(code, "beginner", "ann.py").find(
        (f) => f.id === "annotation-not-a-type",
      );
      expect(found !== undefined, `\`${written}\` should be flagged`);
      if (found !== undefined) {
        expect(found.name_token === written, `the name is carried: ${found.name_token}`);
      }
    }
    console.log("    five wrong annotations, each carrying the name as written");
    console.log("    duplicated defs, `global`, field shapes and `== Class`");
  }

  console.log("\n[19] each finding carries what its explanation reads, and nothing false");
  {
    // `scope_kind` only from the checks that walk scopes, which know it; a
    // constant on the others would say "function" even for a `global` at
    // the top of a file.
    const IN_SCOPE = new Set([
      "shadowing", "shadowing-builtin", "shadowing-library", "reassignment", "duplicate-definition",
    ]);
    const code = [
      "global g",
      "list = 1",
      "x = 1",
      "x = 2",
      "def f(n: string):",
      "    n == 1",
      "    assert (n, 1)",
      "def helper():",
      "    assert True",
      "class P:",
      "    a: int",
      "    b",
      "",
    ].join("\n");
    const findings = analyze(code, "beginner", "shapes.py");
    const ids = new Set(findings.map((f) => f.id));
    for (const id of ["disallowed-keyword", "shadowing-builtin", "reassignment", "annotation-not-a-type",
      "unused-comparison", "assert-tuple", "test-not-named", "class-needs-dataclass", "field-no-type"]) {
      expect(ids.has(id), `${id} is found: ${[...ids].join(", ")}`);
    }
    for (const f of findings) {
      expect(!("message" in f), `${f.id} has no message: nothing reads one`);
      expect(typeof f.error_type === "string" && f.error_type !== "", `${f.id} has an error type`);
      expect(("scope_kind" in f) === IN_SCOPE.has(f.id),
        `${f.id} ${IN_SCOPE.has(f.id) ? "carries" : "does not carry"} a scope kind: ${f.scope_kind}`);
    }
    const keyword = findings.find((f) => f.id === "disallowed-keyword");
    expect(keyword?.keyword === "global" && keyword?.names?.join() === "g", `the keyword and its names: ${JSON.stringify(keyword)}`);
    const unused = findings.find((f) => f.id === "unused-comparison");
    expect(unused?.expression === "n == 1", `the expression as written: ${unused?.expression}`);
    // Whether it is in a test decides the advice; a placeholder is none.
    const where = (code) => analyze(code, "beginner", "where.py").filter((f) => f.id.startsWith("unused-"));
    const [inTest] = where("def test_a():\n    1 == 1\n");
    const [inFunction] = where("def a():\n    1 == 1\n");
    expect(inTest?.in_test === true && inFunction?.in_test === false, `in a test, or not: ${inTest?.in_test} ${inFunction?.in_test}`);
    const [number] = where("def a():\n    10\n");
    expect(number?.constant === true, `a value written out: ${JSON.stringify(number)}`);
    expect(
      where('def a():\n    """What it does."""\n    ...\n    None\n    "a note"\n').length === 0,
      "a docstring, `...`, `None` and a string are not values thrown away",
    );
    // The type written after `=`, so the fix quotes it back: not always int.
    const typed = analyze("@dataclass\nclass Song:\n    title = str\n", "beginner", "typed.py")
      .find((f) => f.id === "field-assigned-type");
    expect(typed?.written_type === "str" && typed?.name_token === "title",
      `the field and the type written: ${JSON.stringify(typed)}`);
    // A helper with an `assert` in it is fine once something calls it.
    const helpers = analyze(
      "def check(x):\n    assert x > 0\n\ndef test_it():\n    check(1)\n\ndef lonely():\n    assert True\n",
      "beginner",
      "helpers.py",
    ).filter((f) => f.id === "test-not-named").map((f) => f.name_token);
    expect(helpers.join() === "lonely", `only the helper nothing calls: ${helpers.join()}`);
    console.log(`    ${findings.map((f) => f.id + ("scope_kind" in f ? `(${f.scope_kind})` : "")).join(" ")}`);
  }

  console.log("\n[20] every type the advice names is one a student's program has");
  {
    // `t: row` was told to write `Row`, which no program has: following the
    // advice gave a NameError. Each name Python reports, through the host's
    // wording, to the name it suggests - which has to evaluate in a session.
    const names = pyodide.runPython("sorted(_PLL_NOT_A_TYPE)").toJs();
    const evaluate = pyodide.globals.get("_pll_repl_eval");
    const suggested = [];
    for (const written of names) {
      const raw = analyze(`def f(x: ${written}) -> int:\n    return 1\n`, "beginner", "ann.py")
        .filter((f) => f.id === "annotation-not-a-type");
      const [finding] = wordStatic(raw, "beginner", "ann.py");
      const type = /^Write `([^`]+)` instead\.$/.exec(finding?.howToFix?.[0] ?? "")?.[1];
      expect(type !== undefined, `\`${written}\` gets a replacement: ${JSON.stringify(finding?.howToFix)}`);
      if (type === undefined) continue;
      const result = evaluate(type, `types-${written}`, "raw").toJs({ dict_converter: Object.fromEntries });
      expect(result.ok && !result.error_type, `\`${written}\` -> \`${type}\`, which a program has: ${result.error_type ?? "ok"}`);
      suggested.push(`${written}->${type}`);
    }
    evaluate.destroy?.();
    // The course's word for a row's type, not the class PLL makes rows with.
    expect(suggested.includes("row->dict"), `a row is a dict: ${suggested.join(" ")}`);
    console.log(`    ${suggested.join(" ")}`);
  }

  console.log("\n[21] Python names the same levels as the host");
  {
    const python = pyodide
      .runPython("[_PLL_LEVEL_RAW, _PLL_LEVEL_BEGINNER, _PLL_LEVEL_INTERMEDIATE, _PLL_LEVEL_ADVANCED]")
      .toJs();
    expect(python.join() === LEVEL_NAMES.join(), `level.ts ${LEVEL_NAMES.join()} vs Python ${python.join()}`);
    const teaching = pyodide.runPython("list(_PLL_TEACHING_LEVELS)").toJs();
    expect(teaching.join() === "beginner,intermediate", `the teaching levels: ${teaching.join()}`);
  }

  console.log("\n[22] correct programs are not stopped, and warnings stay warnings");
  {
    const ids = (code) => analyze(code, "beginner", "ok.py").map((f) => `${f.id}:${f.severity}`);
    const clean = [
      // An alias of their own is a type an annotation can name.
      ["an alias", "Number = int | float\n\ndef double(n: Number) -> Number:\n    return n * 2\n"],
      // A NamedTuple declares fields with annotations, and needs no @dataclass.
      ["a NamedTuple", "from typing import NamedTuple\n\nclass Point(NamedTuple):\n    x: int\n    y: int\n"],
      // A class compared with a class.
      ["a class with a class", "class Boa:\n    pass\n\ndef same(kind: type) -> bool:\n    return kind == Boa\n"],
      ["a value's class", "class Boa:\n    pass\n\ndef same(a: Boa) -> bool:\n    return a.__class__ == Boa\n"],
      // A method with an assert that is called through its object.
      ["a called method", "class A:\n    def check(self) -> None:\n        assert True\n\nA().check()\n"],
      // A method read off a type is the function, on purpose.
      ["str.upper", 't = table(["n"], [["a"]])\nprint(t.transform_column("n", str.upper))\n'],
      // The same capture in two cases is bound once, by whichever runs.
      ["a capture in two cases", "def f(a: int) -> int:\n    match a:\n        case 1 as n:\n            return n\n        case n:\n            return n\n"],
      ["two handlers' names", "def f() -> int:\n    try:\n        return 1\n    except ValueError as e:\n        return 2\n    except KeyError as e:\n        return 3\n"],
      // A property's setter is the property.
      ["a setter", "class Box:\n    @property\n    def w(self) -> int:\n        return 1\n\n    @w.setter\n    def w(self, v: int) -> None:\n        pass\n"],
    ];
    for (const [label, code] of clean) {
      const found = ids(code);
      expect(found.length === 0, `${label}: nothing found, got ${found.join(" ")}`);
    }
    // What is still found.
    expect(ids("class Song:\n    title: str\n").join() === "class-needs-dataclass:error", "a plain class with fields still needs @dataclass");
    expect(ids("class Boa:\n    pass\n\ndef f(a: Boa) -> bool:\n    return a == Boa\n").join() === "compared-with-class:error", "a value with its class is still always False");
    expect(ids("def f(x: string) -> int:\n    return 1\n").join() === "annotation-not-a-type:error", "a name that is not theirs is still not a type");
    expect(ids("def f(n: int) -> int:\n    match n:\n        case len:\n            return len\n").join() === "shadowing-builtin:error", "a capture that shadows a built-in is found");
    expect(ids("def f(n: int) -> int:\n    x = 1\n    match n:\n        case x:\n            return x\n").join() === "reassignment:error", "a capture rebinding a variable is a reassignment");
    expect(
      ids('print(table(["n"], [["a"]]).mean)\ndef helper() -> None:\n    assert True\n').join(" ") === "method-not-called:warning test-not-named:warning",
      `the two warnings are warnings: ${ids('print(table(["n"], [["a"]]).mean)\ndef helper() -> None:\n    assert True\n').join(" ")}`,
    );
    if (passed()) console.log(`    ${clean.length} correct programs found clean`);
  }

  console.log("\n[23] the library-name and shadowing messages fit how the name is bound");
  {
    const explained = (code) =>
      wordStatic(analyze(code, "beginner", "bind.py"), "beginner", "bind.py").map((f) =>
        [f.headline, ...f.howToFix].join("\n"),
      );
    // An import: the fix is `as`, not a rename of their own definition.
    const imported = explained("from PIL import Image\n");
    expect(
      imported.length === 1 && /this import replaces it/.test(imported[0]) && imported[0].includes("`from PIL import Image as PILImage`"),
      `an import: ${imported}`,
    );
    // A parameter hides the name inside its function, and is renamed.
    const parameter = explained("def wrap(package: int) -> int:\n    return package\n");
    expect(
      parameter.length === 1 && /this parameter hides it/.test(parameter[0]) && /Give the parameter another name/.test(parameter[0]) &&
        !/defining a new/.test(parameter[0]),
      `a parameter: ${parameter}`,
    );
    // A loop variable further down was not "already" there.
    const later = explained("def show(t: int) -> int:\n    return t\n\nfor t in [1, 2]:\n    print(show(t))\n");
    expect(
      later.length === 1 && /`t` names two things: this parameter, and a loop variable in the file, on line 4\./.test(later[0]) &&
        !/already defined/.test(later[0]),
      `a later loop variable: ${later}`,
    );
    // One that is there first still is.
    const earlier = explained("t = 3\n\ndef show(t: int) -> int:\n    return t\n");
    expect(earlier.length === 1 && /`t` is already defined \(first defined on line 1, in the file\)/.test(earlier[0]) &&
      /Rename this parameter/.test(earlier[0]), `an earlier one: ${earlier}`);
    // A definition of their own keeps the advice about definitions.
    const defined = explained('def circle(r: int) -> int:\n    return r\n');
    expect(defined.length === 1 && /Pick a different name for your definition/.test(defined[0]), `a def: ${defined}`);
    console.log("    import, parameter, later loop variable, earlier variable, def");
  }

  console.log("\n[24] `is` with a number or a string is a finding at the teaching levels");
  {
    for (const level of ["beginner", "intermediate"]) {
      const found = analyze('x = 60.5\nassert x is 60.5\nname = "Ada"\nprint(name is not "Ada")\nprint(x is None)\n', level, "is.py");
      const isLiteral = found.filter((f) => f.id === "is-literal");
      expect(
        isLiteral.length === 2 && isLiteral[0].operator === "is" && isLiteral[0].literal === "60.5" &&
          isLiteral[1].operator === "is not" && isLiteral[1].severity === "error",
        `${level}: two, not \`is None\`: ${JSON.stringify(isLiteral)}`,
      );
    }
    const [finding] = wordStatic(analyze("x = 60.5\nassert x is 60.5\n", "beginner", "is.py"), "beginner", "is.py");
    expect(finding?.howToFix?.[0] === "To compare with `60.5`, write `==` instead.", `the fix: ${JSON.stringify(finding)}`);
    expect(analyze("x = 1\nprint(x is 1)\n", "advanced", "is.py").length === 0, "advanced is Python");
    console.log("    `is 60.5` and `is not \"Ada\"`, and never `is None`");
  }

  console.log("\n[25] every kind of finding the checks make has its wording");
  {
    // Read from the checks' source: each `_pll_finding("kind", ...)`, and
    // both kinds of one that chooses between two.
    const source = readPy("src/python/bootstrap/staticAnalysis.py");
    const kinds = new Set();
    for (const m of source.matchAll(/_pll_finding\(\s*"([a-z-]+)"(?:\s+if [^"\n]*else\s+"([a-z-]+)")?/g)) {
      kinds.add(m[1]);
      if (m[2]) kinds.add(m[2]);
    }
    const worded = new Set(pyodide.runPython("sorted(_PLL_STATIC_WORDING)").toJs());
    const unworded = [...kinds].filter((kind) => !worded.has(kind));
    expect(kinds.size >= 17 && unworded.length === 0, `${kinds.size} kinds, without wording: ${unworded.join(", ")}`);
    console.log(`    ${kinds.size} kinds, each worded`);
  }

  console.log("\n[26] a `case` pattern's class: one nothing defines, and one the subject never is");
  {
    const CLASSES = [
      "@dataclass",
      "class Pet:\n    name: str",
      "@dataclass",
      "class Boa(Pet):\n    length: float",
      "@dataclass",
      "class Armadillo(Pet):\n    alive: bool",
      "@dataclass",
      "class Rock:\n    weight: float",
      "Animal = Boa | Armadillo",
      "",
    ].join("\n");
    const matching = (annotation, ...cases) =>
      `${CLASSES}\ndef f(a${annotation}) -> str:\n    match a:\n${cases.map((c) => `        case ${c}:\n            return "x"\n`).join("")}    return ""\n`;
    const found = (code, level = "beginner") => {
      const raw = analyze(code, level, "pets.py");
      return raw.map((f, i) => ({ ...f, said: wordStatic([f], level, "pets.py")[0] }));
    };
    // Your example: the variants from the parameter's annotation, the alias set at the top.
    const [unknown] = found(matching(": Animal", "Aardvark(b)", "Boa(n, l)", "Armadillo(n, l)"));
    expect(
      unknown?.id === "unknown-pattern-class" && unknown.severity === "error" && unknown.name_token === "Aardvark" &&
        unknown.said.headline === "There is no class `Aardvark`: an `Animal` is a `Boa` or an `Armadillo`." &&
        unknown.said.howToFix.join("|") ===
          "Match one of them: `case Boa(...)` or `case Armadillo(...)`.|If an `Aardvark` is a new kind of `Animal`, define `class Aardvark` and add it: `Animal = Boa | Armadillo | Aardvark`.",
      `a class nothing defines, said with the subject's variants: ${JSON.stringify(unknown)}`,
    );
    // Every way an annotation writes the union, and a misspelling.
    for (const [annotation, headline] of [
      [": Boa | Armadillo", "There is no class `Aardvark`: `a` is a `Boa` or an `Armadillo`."],
      [': "Animal"', "There is no class `Aardvark`: an `Animal` is a `Boa` or an `Armadillo`."],
      [": Union[Boa, Armadillo]", "There is no class `Aardvark`: `a` is a `Boa` or an `Armadillo`."],
      [": Optional[Boa]", "There is no class `Aardvark`: `a` is a `Boa` or `None`."],
      ["", "There is no class `Aardvark` for this `case` to match."],
    ]) {
      const [f] = found(`from typing import Optional, Union\n${matching(annotation, "Aardvark()")}`);
      expect(f?.said.headline === headline, `a${annotation}: ${f?.said.headline}`);
    }
    const [typo] = found(matching(": Animal", "Armadilo()"));
    expect(typo?.said.howToFix.join("|") === "Did you mean `Armadillo`?", `a misspelling, just that: ${JSON.stringify(typo?.said.howToFix)}`);
    const [none] = found(matching("", "Lizard()"));
    expect(none?.said.howToFix[0] === "The classes this program has are `Armadillo`, `Boa`, `Pet` and `Rock`.", `no annotation, the classes there are: ${JSON.stringify(none?.said.howToFix)}`);
    // A class that exists but that the subject never is: a warning, since it runs.
    const [never] = found(matching(": Animal", "Rock()", "Boa(n, l)"));
    expect(
      never?.id === "pattern-never-matches" && never.severity === "warning" &&
        never.said.headline === "This `case` never matches: an `Animal` is a `Boa` or an `Armadillo`, never a `Rock`.",
      `a case that never matches: ${JSON.stringify(never)}`,
    );
    // Not found: a base of a variant, a built-in, an import, a star import,
    // a dotted class, a name the session has, and anything at advanced.
    for (const [label, code, session] of [
      ["a base of the variants", matching(": Animal", "Pet(name=n)")],
      ["built-ins", matching(": Animal", "int() | str()")],
      ["an import", `from shapes import Circle\n${matching(": Animal", "Circle()")}`],
      ["a star import", `from shapes import *\n${matching(": Animal", "Circle()")}`],
      ["a dotted class", `import shapes\n${matching(": Animal", "shapes.Circle()")}`],
      ["a library's class", matching("", "Table()")],
    ]) {
      const ids = found(code).map((f) => f.id);
      expect(ids.length === 0, `${label}: nothing, got ${ids.join(" ")}`);
    }
    // At `advanced` a class nothing defines is still a NameError, and said
    // the same way; that a `case` never matches is a teaching check only.
    const advanced = found(matching(": Animal", "Aardvark()"), "advanced");
    expect(
      advanced.map((f) => f.id).join() === "unknown-pattern-class" &&
        advanced[0].said.headline === "There is no class `Aardvark`: an `Animal` is a `Boa` or an `Armadillo`.",
      `advanced finds the NameError, as the others word it: ${JSON.stringify(advanced.map((f) => [f.id, f.said?.headline]))}`,
    );
    expect(found(matching(": Animal", "Rock()"), "advanced").length === 0, "but not a case that never matches");
    // At the prompt, a class an earlier line defined is one.
    pyodide.runPython("_pll_sessions.setdefault('pets:repl', __import__('types').ModuleType('__main__')).__dict__['Lizard'] = type('Lizard', (), {})");
    const prompt = analyze("match 3:\n    case Lizard():\n        pass\n", "beginner", "<repl>", "pets:repl");
    expect(prompt.length === 0, `the session's own class: ${JSON.stringify(prompt.map((f) => f.id))}`);
    const top = analyze("match 3:\n    case Gecko():\n        pass\n", "beginner", "<repl>", "pets:repl");
    expect(top.map((f) => f.id).join() === "unknown-pattern-class", `and one it does not have: ${JSON.stringify(top.map((f) => f.id))}`);
    pyodide.runPython("_pll_sessions.pop('pets:repl', None)");
    console.log("    the class nothing defines, with the variants; the case that never matches; nothing else");
  }

  console.log("\n[27] `del` of a name is refused at the teaching levels; `del` of an item is not");
  {
    const found = (code, level = "beginner") => analyze(code, level, "del.py").filter((f) => f.id === "unbinding");
    const one = found("total = 0\ndel total\n");
    expect(one.length === 1, `one finding: ${JSON.stringify(one)}`);
    expect(
      one[0]?.name_token === "total" && one[0]?.line_number === 2 && one[0]?.column === 4,
      `at the name: ${JSON.stringify(one[0])}`,
    );
    expect(one[0]?.error_type === "Unbinding" && one[0]?.severity === "error", `an error: ${one[0]?.severity}`);
    expect(found("x = 1\ndel x\n", "intermediate").length === 1, "intermediate refuses it too");
    for (const level of ["advanced", "raw"]) {
      const all = analyze("x = 1\ndel x\n", level, "del.py");
      expect(all.length === 0, `${level} has no checks: ${JSON.stringify(all.map((f) => f.id))}`);
    }

    // One finding a statement, naming every name in it, through brackets,
    // and only the names when items are removed beside them.
    const many = found("a = 1\nb = 2\nc = 3\ndel a, (b, c)\n");
    expect(many.length === 1 && many[0].names?.join() === "a,b,c", `every name: ${JSON.stringify(many)}`);
    const mixed = found('d = {"k": 1}\nx = 1\ndel d["k"], x\n');
    expect(
      mixed.length === 1 && mixed[0].names?.join() === "x" && mixed[0].column === 12,
      `only the name, at the name: ${JSON.stringify(mixed)}`,
    );

    // Items, slices and attributes are parts of a value, not names.
    for (const [label, code] of [
      ["a key", 'd = {"k": 1}\ndel d["k"]\n'],
      ["an item", "xs = [1, 2]\ndel xs[0]\n"],
      ["a slice", "xs = [1, 2, 3]\ndel xs[1:]\n"],
      ["an attribute", "class P:\n    pass\n\np = P()\np.x = 1\ndel p.x\n"],
    ]) {
      const all = analyze(code, "beginner", "del.py");
      expect(all.length === 0, `${label}: nothing, got ${JSON.stringify(all.map((f) => f.id))}`);
    }

    // A loop's own name, where taking the item out was meant.
    const loop = found("def f(xs: list) -> list:\n    for n in xs:\n        if n < 0:\n            del n\n    return xs\n");
    expect(loop[0]?.loop_variable === true && loop[0]?.scope_kind === "function", `a loop's name: ${JSON.stringify(loop)}`);
    const plain = found("def f(xs: list) -> int:\n    total = sum(xs)\n    del total\n    return 0\n");
    expect(plain[0]?.loop_variable === false, `any other: ${JSON.stringify(plain)}`);

    // At the prompt, as in a file.
    const prompt = analyze("del total\n", "beginner", "<repl>", null).map((f) => f.id);
    expect(prompt.join() === "unbinding", `at the prompt: ${prompt.join()}`);
    console.log("    names refused at both levels, one finding a statement; items, slices and attributes allowed");
  }

  console.log("\n[28] names read where they have no value: found before the run, as the run would raise them");
  {
    // [what, level, code, the findings ("Error name@line"), and what a run
    // does: "raises" the first of them there, "clean" with no NameError, or
    // "later" - a function never called, reported though the run is fine].
    // `parity`: the run's explanation reads exactly as the static one.
    const CASES = [
      ["a typo in a function never called", "beginner", "def f(x: int) -> int:\n    return totl + x\n", ["NameError totl@2"], "later"],
      ["a call above its def", "beginner", "print(double(2))\ndef double(x: int) -> int:\n    return 2 * x\n", ["NameError double@1"], "raises", "parity"],
      ["a call below its def", "beginner", "def double(x: int) -> int:\n    return 2 * x\nprint(double(2))\n", [], "clean"],
      ["recursion", "beginner", "def fact(n: int) -> int:\n    return 1 if n == 0 else n * fact(n - 1)\nprint(fact(3))\n", [], "clean"],
      ["mutual recursion", "beginner", "def even(n: int) -> bool:\n    return n == 0 or odd(n - 1)\ndef odd(n: int) -> bool:\n    return n != 0 and even(n - 1)\nprint(even(4))\n", [], "clean"],
      ["a missing import", "beginner", "print(math.pi)\n", ["NameError math@1"], "raises", "parity"],
      ["a misspelling, with Python's suggestion", "beginner", "total = 3\nprint(totl)\n", ["NameError totl@2"], "raises", "parity"],
      ["a decorator never imported", "beginner", "@total_ordering\nclass P:\n    x: int\n", ["NameError total_ordering@1"], "raises", "parity"],
      ["the decorator every file has", "beginner", "@dataclass\nclass P:\n    x: int\n", [], "clean"],
      ["an unbound local", "advanced", "total = 0\ndef add(n):\n    total = total + n\n    return total\nadd(1)\n", ["UnboundLocalError total@3"], "raises", "parity"],
      ["`+=` on an outer name", "advanced", "count = 0\ndef bump():\n    count += 1\nbump()\n", ["UnboundLocalError count@3"], "raises", "parity"],
      ["`global`", "advanced", "count = 0\ndef bump():\n    global count\n    count += 1\nbump()\nprint(count)\n", [], "clean"],
      ["a name a call gives with `global`", "advanced", "def setup():\n    global config\n    config = 1\nsetup()\nprint(config)\n", [], "clean"],
      ["`nonlocal`", "advanced", "def outer():\n    n = 0\n    def inner():\n        nonlocal n\n        n += 1\n    inner()\n    return n\nprint(outer())\n", [], "clean"],
      ["a name `nonlocal` gives before it is set", "advanced", "def outer():\n    def inner():\n        nonlocal x\n        x = 1\n    inner()\n    print(x)\n    x = 0\nouter()\n", [], "clean"],
      ["a read after `del`", "advanced", "x = 1\ndel x\nprint(x)\n", ["NameError x@3"], "raises"],
      ["`del` and then a new value", "advanced", "x = 1\ndel x\nx = 2\nprint(x)\n", [], "clean"],
      ["`del` of a name never set", "advanced", "del y\n", ["NameError y@1"], "raises"],
      ["a local read after `del`", "advanced", "def f():\n    x = 1\n    del x\n    return x\nf()\n", ["UnboundLocalError x@4"], "raises"],
      ["an `except` name after its block", "advanced", "try:\n    1 / 0\nexcept ZeroDivisionError as e:\n    pass\nprint(e)\n", ["NameError e@5"], "raises"],
      ["an `except` name in its block", "beginner", "try:\n    1 / 0\nexcept ZeroDivisionError as e:\n    print(e)\n", [], "clean"],
      ["a read a handler catches", "beginner", "try:\n    print(undefined_thing)\nexcept NameError:\n    print('none')\n", [], "clean"],
      ["a loop's name after the loop", "beginner", "for i in range(3):\n    pass\nprint(i)\n", [], "clean"],
      ["a name set on an earlier pass", "advanced", "for i in range(3):\n    if i > 0:\n        print(prev)\n    prev = i\n", [], "clean"],
      ["`while` and its `else`", "advanced", "n = 0\nwhile n < 3:\n    n += 1\nelse:\n    done = True\nprint(done)\n", [], "clean"],
      ["`while True` left by `break`", "advanced", "while True:\n    found = 1\n    break\nprint(found)\n", [], "clean"],
      ["a comprehension's own name, after it", "beginner", "squares = [x * x for x in range(3)]\nprint(x)\n", ["NameError x@2"], "raises", "parity"],
      ["a comprehension", "beginner", "xs = [1, 2]\nprint([x + 1 for x in xs])\n", [], "clean"],
      ["a generator's name nothing defines", "beginner", "def f(xs: list) -> int:\n    return sum(x * k for x in xs)\n", ["NameError k@2"], "later"],
      ["a class's name inside a method", "advanced", "class C:\n    size = 3\n    def area(self):\n        return size * size\nC().area()\n", ["NameError size@4"], "raises", "parity"],
      ["an attribute without `self.`", "advanced", "class C:\n    def __init__(self):\n        self.width = 2\n    def area(self):\n        return width * 2\nC().area()\n", ["NameError width@5"], "raises", "parity"],
      ["a class's own name in a method's annotation", "advanced", "class Node:\n    def child(self) -> Node:\n        return self\n", ["NameError Node@2"], "raises"],
      ["a dataclass naming itself", "beginner", "@dataclass\nclass Link:\n    rest: Link | None\n", ["NameError Link@3"], "raises"],
      ["a dataclass naming itself, as a string", "beginner", "@dataclass\nclass Link:\n    rest: 'Link | None'\n", [], "clean"],
      ["type parameters", "beginner", "@dataclass\nclass Leaf[T]:\n    value: T\n    def get(self) -> T:\n        return self.value\nprint(Leaf(1).get())\n", [], "clean"],
      ["`match` captures", "beginner", "def f(lst: list) -> int:\n    match lst:\n        case []:\n            return 0\n        case [first, *rest]:\n            return first + f(rest)\n    return -1\nprint(f([1, 2]))\n", [], "clean"],
      ["`from m import *`", "advanced", "from math import *\nprint(pi)\n", [], "clean"],
      ["`exec`", "advanced", "exec('z = 1')\nprint(z)\n", [], "clean"],
      ["`enum.global_enum`", "advanced", "import enum\n@enum.global_enum\nclass Color(enum.Enum):\n    RED = 1\nprint(RED)\n", [], "clean"],
      ["`:=`", "beginner", "xs = [1, 2, 3]\nif (n := len(xs)) > 2:\n    print(n)\n", [], "clean"],
      ["`:=` in a comprehension", "advanced", "ys = [y := 5, y + 1]\nprint(y)\n", [], "clean"],
      ["annotations read later", "advanced", "from __future__ import annotations\ndef f(n: Node) -> int:\n    return 1\nclass Node:\n    pass\nprint(f(Node()))\n", [], "clean"],
      ["an annotation above its class", "beginner", "def f(n: Node) -> int:\n    return 1\nclass Node:\n    pass\n", ["NameError Node@1"], "raises", "parity"],
      ["a `__main__` guard", "beginner", "def main():\n    print('hi')\nif __name__ == '__main__':\n    main()\n", [], "clean"],
      ["an import that may fail", "advanced", "try:\n    import numpy as np\nexcept ImportError:\n    np = None\nprint(np is None or np.pi > 3)\n", [], "clean"],
      ["`with ... as`", "beginner", "with open(__file__) as fh:\n    text = fh.read()\nprint(len(text) > 0)\n", [], "clean"],
      ["a lambda reading a name set after it", "beginner", "double = lambda n: n * factor\nfactor = 2\nprint(double(3))\n", [], "clean"],
      ["PLL's own names", "beginner", "print(circle(10, 'solid', 'red'))\n", [], "clean"],
      ["an exception class misspelt", "beginner", "try:\n    int('x')\nexcept ValueEror:\n    pass\n", ["NameError ValueEror@3"], "raises", "parity"],
      ["at raw, nothing", "raw", "print(nothing_here)\n", [], null],
      ["at intermediate", "intermediate", "print(nothing_here)\n", ["NameError nothing_here@1"], "raises", "parity"],
      ["at advanced", "advanced", "print(nothing_here)\n", ["NameError nothing_here@1"], "raises", "parity"],
      ["a built-in, replaced later", "advanced", "print(list((1, 2)))\nlist = 3\n", [], "clean"],
      ["a class body calling what is defined below it", "advanced", "class A:\n    x = helper()\ndef helper():\n    return 1\n", ["NameError helper@2"], "raises", "parity"],
      ["a class in a function, reading its local", "advanced", "def f():\n    k = 1\n    class A:\n        y = k\n    return A.y\nprint(f())\n", [], "clean"],
      ["a comprehension in a class body", "advanced", "class A:\n    xs = [1, 2]\n    k = 2\n    ys = [x * k for x in xs]\n", ["NameError k@4"], "raises", "parity"],
      ["code after `return`", "advanced", "def f():\n    return 1\n    print(nothing)\nf()\n", [], "clean"],
      ["`if False:`", "advanced", "if False:\n    print(nothing)\n", [], "clean"],
      ["`super()` and `__class__`", "advanced", "class A:\n    def f(self):\n        return 1\nclass B(A):\n    def f(self):\n        return super().f() + len(__class__.__name__)\nprint(B().f())\n", [], "clean"],
      ["a handler reading what its body set", "advanced", "try:\n    n = 1\n    int('x')\nexcept ValueError:\n    print(n)\n", [], "clean"],
      ["`try` / `finally`", "advanced", "try:\n    x = 1\nfinally:\n    print('done')\nprint(x)\n", [], "clean"],
      ["a default reading a later name", "advanced", "def f(n=limit):\n    return n\nlimit = 3\n", ["NameError limit@1"], "raises", "parity"],
      ["a type by another language's name", "advanced", "def stand(cups: string) -> int:\n    return 1\n", ["NameError string@1"], "raises", "parity"],
      ["a call before a name its function reads", "beginner", "def show() -> None:\n    print(title)\nshow()\ntitle = 'x'\n", ["NameError title@2"], "raises"],
      ["a call after it", "beginner", "def show() -> None:\n    print(title)\ntitle = 'x'\nshow()\n", [], "clean"],
      ["a nested function called before its outer name", "advanced", "def outer():\n    def inner():\n        return title\n    r = inner()\n    title = 'x'\n    return r\nouter()\n", ["NameError title@3"], "raises"],
      ["a nested function called after it", "advanced", "def outer():\n    title = 'x'\n    def inner():\n        return title\n    return inner()\nprint(outer())\n", [], "clean"],
      ["a call reaching a name through another function", "intermediate", "def area(r: float) -> float:\n    return PI * r * r\ndef report() -> None:\n    print(area(2))\nreport()\nPI = 3.14\n", ["NameError PI@2"], "raises"],
      ["a call of a function calling one defined below", "beginner", "def main() -> None:\n    helper()\nmain()\ndef helper() -> None:\n    pass\n", ["NameError helper@2"], "raises"],
      ["a call in a default", "advanced", "def f():\n    return limit\ndef g(n=f()):\n    return n\nlimit = 3\n", ["NameError limit@2"], "raises"],
      ["a call in a loop", "advanced", "def f():\n    return k\nfor i in range(2):\n    f()\nk = 1\n", ["NameError k@2"], "raises"],
      ["a call whose read is in a branch", "advanced", "def f(flag):\n    if flag:\n        return later\n    return 0\nprint(f(False))\nlater = 1\n", [], "clean"],
      ["a call whose read is after `or`", "advanced", "def f(flag):\n    return flag or later\nprint(f(True))\nlater = 1\n", [], "clean"],
      ["a generator function called early", "advanced", "def gen():\n    yield later\ng = gen()\nlater = 1\nprint(list(g))\n", [], "clean"],
      ["an `async def` called early", "advanced", "async def f():\n    return later\nc = f()\nlater = 1\nc.close()\n", [], "clean"],
      ["a decorated function called early", "advanced", "def replace(fn):\n    return lambda: 'ok'\n@replace\ndef f():\n    return later\nprint(f())\nlater = 1\n", [], "clean"],
      ["a local helper named like a file's function", "advanced", "def helper():\n    return later\ndef a():\n    def helper():\n        return 1\n    return helper()\nprint(a())\nlater = 1\n", [], "clean"],
      ["a function a `global` replaces", "advanced", "def f():\n    return later\ndef swap():\n    global f\n    f = lambda: 1\nswap()\nprint(f())\nlater = 1\n", [], "clean"],
      ["a function giving the name with `global`", "advanced", "def f():\n    global later\n    later = 1\n    return later\nf()\nprint(later)\n", [], "clean"],
      ["a comprehension's name, called", "advanced", "def f():\n    return later\nprint([f() for f in [lambda: 1]])\nlater = 1\n", [], "clean"],
      ["a call in a lambda", "advanced", "def f():\n    return later\ng = lambda: f()\nlater = 1\nprint(g())\n", [], "clean"],
      ["a call a handler guards", "advanced", "def f():\n    return later\ntry:\n    f()\nexcept NameError:\n    print('not yet')\nlater = 1\n", [], "clean"],
      ["a built-in a call reads, replaced later", "advanced", "def f():\n    return len('ab')\nprint(f())\nlen = 3\n", [], "clean"],
      ["a call above its def, reading a later name", "advanced", "print(f())\ndef f():\n    return later\nlater = 1\n", ["NameError f@1"], "raises"],
      ["a name another function gives with `global`", "advanced", "def f():\n    return later\ndef setup():\n    global later\n    later = 1\nsetup()\nprint(f())\nlater = 2\n", [], "clean"],
      ["a name another function gives with `nonlocal`", "advanced", "def outer():\n    def setup():\n        nonlocal x\n        x = 1\n    def show():\n        return x\n    setup()\n    r = show()\n    x = 2\n    return r\nprint(outer())\n", [], "clean"],
      ["a call's argument giving the name", "advanced", "def show(_):\n    return title\nprint(show(title := 'x'))\n", [], "clean"],
      ["a `type` alias", "advanced", "type Pair = tuple[int, Later]\nclass Later:\n    pass\nprint(Pair)\n", [], "clean"],
      ["one finding a name", "beginner", "print(missing)\nprint(missing)\n", ["NameError missing@1"], "raises", "parity"],
    ];
    const worded = (code, level) =>
      JSON.parse(pllCall("_pll_static_findings", JSON.stringify([code, level, "names.py", null]))).filter(
        (f) => f.id === "undefined-name",
      );
    let runs = 0;
    const ran = (code, level) => {
      runs += 1;
      return JSON.parse(pllCall("_pll_run_file", JSON.stringify([code, "names.py", `names-${runs}`, level, false])));
    };
    const NAMES = /^(NameError|UnboundLocalError)$/;
    let parities = 0;
    for (const [label, level, code, want, runs_, parity] of CASES) {
      const found = worded(code, level);
      const got = found.map((f) => `${f.errorType} ${f.nameToken}@${f.lineNumber}`);
      expect(got.join("|") === want.join("|"), `${label}: ${JSON.stringify(got)}, not ${JSON.stringify(want)}`);
      if (runs_ === null) continue;
      const error = ran(code, level).error;
      const finding = error?.finding ?? null;
      if (runs_ === "raises") {
        const [kind, rest] = want[0].split(" ");
        const line = Number(rest.split("@")[1]);
        expect(
          finding?.errorType === kind && finding?.lineNumber === line,
          `${label}: the run raises ${want[0]}, but got ${finding?.errorType} at ${finding?.lineNumber}`,
        );
        if (parity && found[0]) {
          parities += 1;
          expect(
            finding?.headline === found[0].headline && JSON.stringify(finding?.howToFix) === JSON.stringify(found[0].howToFix),
            `${label}: worded as the run words it:\n  ${found[0].headline} ${JSON.stringify(found[0].howToFix)}\n  ${finding?.headline} ${JSON.stringify(finding?.howToFix)}`,
          );
        }
      } else {
        expect(!NAMES.test(finding?.errorType ?? ""), `${label}: the run has no NameError: ${finding?.errorType} ${finding?.headline}`);
      }
    }

    // What each scope's own names are, against Python's compiler.
    const agree = pyodide.runPython(`
import ast, json, symtable
def compare(code):
    scopes = _PllNameScopes(ast.parse(code))
    tables = {}
    def walk(table):
        if table.get_type() == symtable.SymbolTableType.FUNCTION:
            tables[(table.get_name(), table.get_lineno())] = {s.get_name() for s in table.get_symbols() if s.is_local()}
        for child in table.get_children():
            walk(child)
    walk(symtable.symtable(code, "names.py", "exec"))
    differ = []
    compared = 0
    for node, scope in scopes.of.items():
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            theirs = tables[(node.name, node.lineno)]
            compared += 1
            if theirs != scope.local:
                differ.append("%s line %d: ours %s, Python's %s" % (node.name, node.lineno, sorted(scope.local), sorted(theirs)))
    return compared, differ
results = [compare(code) for code in json.loads(${JSON.stringify(JSON.stringify(CASES.map((c) => c[2])))})]
json.dumps([sum(n for n, _ in results), [d for _, ds in results for d in ds]])
`);
    const [compared, differ] = JSON.parse(agree);
    expect(compared >= 30 && differ.length === 0, `each function's own names, as Python's compiler sees them (${compared}): ${differ.join("; ")}`);

    // A call made too early is about the call: its line, the way from it to
    // the read, and the line that sets the name, when one does.
    const CALLS = [
      [
        "intermediate",
        "def area(r: float) -> float:\n    return PI * r * r\ndef report() -> None:\n    print(area(2))\nreport()\nPI = 3.14\n",
        "Line 5 calls `report` before `PI` has a value, and `report` calls `area`, which uses it here.",
        ["`PI` gets its value on line 6, after the call.", "Move the call below line 6, or move the line that sets `PI` above line 5."],
      ],
      [
        "advanced",
        "def show():\n    return title\ntitle = 1\ndel title\nshow()\n",
        "Line 5 calls `show` before `title` has a value, and `show` uses it here.",
        ["Give `title` a value before line 5, where `show` is called."],
      ],
    ];
    for (const [level, code, headline, howToFix] of CALLS) {
      const [f] = worded(code, level);
      expect(
        f?.headline === headline && JSON.stringify(f?.howToFix) === JSON.stringify(howToFix),
        `a call made too early: ${f?.headline} ${JSON.stringify(f?.howToFix)}`,
      );
    }

    // A prompt line: what earlier lines gave the session counts.
    pyodide.runPython("_pll_sessions.setdefault('names:repl', __import__('types').ModuleType('__main__')).__dict__['earlier'] = 1");
    const prompt = (code) =>
      JSON.parse(pllCall("_pll_static_findings", JSON.stringify([code, "beginner", "<repl>", "names:repl"]))).map((f) => f.nameToken);
    expect(prompt("print(earlier)\n").length === 0, "a name an earlier line set");
    expect(prompt("print(never)\n").join() === "never", "and one no line did");
    pyodide.runPython("_pll_sessions.pop('names:repl', None)");

    // A file with an `#examplar` line calls functions its bundle provides.
    const examplar = "#examplar https://example.test/hw.json\ndef test_shout():\n    assert shout('a') == 'A!'\n";
    expect(worded(examplar, "beginner").length === 0, "the functions an Examplar bundle provides");
    expect(worded("#examplar https://example.test/hw.json\nprint(shout('a'))\n", "beginner").length === 1, "but not at the top level");

    console.log(`    ${CASES.length} programs, each run as well; ${parities} worded exactly as the run words them; ${compared} functions' scopes as Python's compiler has them`);
  }

  console.log("\n[29] a `type` statement defines its name, as `class` and `=` do");
  {
    // [what, level, code, the finding ("kind@line:column"), and words its
    // wording has - each a regular expression - or none at all].
    const CASES = [
      ["a built-in", "beginner", "type list = int\nprint(list)\n", "shadowing-builtin@1:5",
        [/`list` is the name of a Python built-in\./, /Give the type a name of its own/, /capitalized, like `Shape`/]],
      ["a library's type", "beginner", "type Table = list[dict]\n", "shadowing-library@1:5",
        [/`Table` is already defined by the table library\./, /use it as it is: it is already a type/]],
      ["a library's function", "beginner", "type circle = int\n", "shadowing-library@1:5", [/Give your type a name of its own/]],
      ["two `type`s", "beginner", "type Shape = int\ntype Shape = str\n", "duplicate-definition@2:5",
        [/There are two types named `Shape` \(lines 1 and 2\)/, /the first is never used/]],
      ["a `class` and a `type`", "beginner", "class Shape:\n    pass\ntype Shape = int\n", "duplicate-definition@3:5",
        [/two types named `Shape`/]],
      ["a variable, then a `type`", "beginner", "Shape = int\ntype Shape = str\n", "reassignment@2:5",
        [/`Shape` is already assigned \(first assigned on line 1\)/, /A type keeps one meaning/]],
      ["a `type`, then a variable", "intermediate", "type Shape = int\nShape = 3\n", "reassignment@2:0", [/A type keeps one meaning/]],
      ["a function's `type` hiding the file's name", "beginner", "Pair = 1\ndef f() -> None:\n    type Pair = int\n", "shadowing@3:9",
        [/Rename this type/, /without making a new type/]],
      ["a parameter hiding a `type`", "beginner", "type Shape = int\ndef f(Shape: int) -> int:\n    return Shape\n", "shadowing@2:6",
        [/Rename this parameter/]],
      ["the course's generic tree", "beginner",
        "@dataclass\nclass Leaf[T]:\n    value: T\n@dataclass\nclass Node[T]:\n    left: 'BinTree[T]'\n" +
          "    right: 'BinTree[T]'\ntype BinTree[T] = Leaf[T] | Node[T]\ndef size(t: BinTree[int]) -> int:\n    return 1\nprint(size(Leaf(1)))\n",
        null, []],
      ["at intermediate, a built-in", "intermediate", "type list = int\n", "shadowing-builtin@1:5", []],
      ["at intermediate, two in a function", "intermediate", "def f() -> None:\n    type A = int\n    type A = str\n", null, []],
      ["at advanced, nothing", "advanced", "type list = int\ntype list = str\n", null, []],
    ];
    for (const [label, level, code, want, words] of CASES) {
      const found = wordStatic(analyze(code, level, "alias.py"), level, "alias.py");
      const got = found.map((f) => `${f.id}@${f.lineNumber}:${f.column}`);
      expect(got.join("|") === (want ?? ""), `${label}: ${JSON.stringify(got)}, not ${want}`);
      const text = found.map((f) => [f.headline, ...f.howToFix].join("\n")).join("\n");
      for (const word of words) expect(word.test(text), `${label}: says ${word}: ${text}`);
    }
    console.log(`    ${CASES.length} programs: built-ins, the libraries' names, two definitions, a reassignment, scopes, levels`);
  }

  console.log("\n[30] a name that shadows another and is then reassigned is both, said at each line");
  {
    const CASES = [
      ["a parameter, given a new value", "beginner", "x = 10\n\ndef f(x: int) -> None:\n    x = 20\n", ["shadowing@3", "reassignment@4"]],
      ["a local, assigned twice", "beginner", "count = 0\n\ndef f() -> None:\n    count = 1\n    count = 2\n", ["shadowing@4", "reassignment@5"]],
      ["a built-in, assigned twice", "beginner", "list = [1]\nlist = [2]\n", ["shadowing-builtin@1", "reassignment@2"]],
      ["at intermediate, a function may change it", "intermediate", "x = 10\n\ndef f(x: int) -> None:\n    x = 20\n", ["shadowing@3"]],
      ["a pll import and one assignment: the library's, once", "beginner", "from pll.image import circle\ncircle = 5\n", ["shadowing-library@2"]],
      ["a pll import and two assignments", "beginner", "from pll.image import circle\ncircle = 5\ncircle = 6\n", ["shadowing-library@2", "reassignment@3"]],
    ];
    for (const [label, level, code, want] of CASES) {
      const got = analyze(code, level, "both.py")
        .filter((f) => /^(shadowing|reassignment)/.test(f.id))
        .map((f) => `${f.id}@${f.line_number}`);
      expect(got.join(" ") === want.join(" "), `${label}: ${got.join(" ")}, not ${want.join(" ")}`);
    }
    console.log(`    ${CASES.length} programs`);
  }

  console.log("\n[31] a function annotated to return something, with no `return` in it");
  {
    const CASES = [
      ["a value worked out and kept", "def area(r: float) -> float:\n    a = 3.14 * r * r\n", ["missing-return@1"]],
      ["printed instead of returned", "def area(r: float) -> float:\n    print(3.14 * r * r)\n", ["missing-return@1"]],
      ["a method", "class C:\n    def size(self) -> int:\n        self.n = 1\n", ["missing-return@2"]],
      ["a loop with no answer after it", "def total(xs: list[int]) -> int:\n    t = 0\n    for x in xs:\n        print(x)\n", ["missing-return@1"]],
      ["an annotation that is a union", "def first(xs: list[int]) -> int | None:\n    print(xs)\n", ["missing-return@1"]],
      // Left alone: one that gives back nothing, by its annotation or by
      // never finishing; one not written yet; and one that returns anywhere.
      ["`-> None`", "def show(x: int) -> None:\n    print(x)\n", []],
      ["`-> 'None'`", "def show(x: int) -> 'None':\n    print(x)\n", []],
      ["`-> NoReturn`", "from typing import NoReturn\ndef stop() -> NoReturn:\n    raise SystemExit(1)\n", []],
      ["no annotation", "def show(x):\n    print(x)\n", []],
      ["a `return` in one branch", "def k(x: int) -> int:\n    if x > 0:\n        return x\n", []],
      ["a generator", "def gen() -> list[int]:\n    yield 1\n", []],
      ["`pass`, under a docstring", 'def todo() -> int:\n    """Not yet."""\n    pass\n', []],
      ["`...`", "def todo() -> int:\n    ...\n", []],
      ["`raise NotImplementedError`", "def todo() -> int:\n    raise NotImplementedError\n", []],
      ["one that ends by raising", "def fail(m: str) -> int:\n    print(m)\n    raise ValueError(m)\n", []],
      ["an abstract method", "from abc import abstractmethod\nclass S:\n    @abstractmethod\n    def area(self) -> float:\n        print('x')\n", []],
      ["a test", "def test_a() -> None:\n    assert 1 == 1\n", []],
      // A `return` of an inner function's is not the outer one's.
      ["a `return` only inside an inner function", "def outer() -> int:\n    def inner() -> int:\n        return 1\n    inner()\n", ["missing-return@1"]],
      // A value thrown away on the last line is told to be returned already.
      ["a last line that is a value thrown away", "def add_one(x: int) -> int:\n    x + 1\n", ["unused-value@2"]],
      ["a last line that is a new value thrown away", "def shout(word: str) -> str:\n    word.upper()\n", ["unused-value@2"]],
      ["a last line that is a comparison", "def is_five(x: int) -> bool:\n    x == 5\n", ["unused-comparison@2"]],
      // A course's template, every case still `pass`, is not written yet.
      ["a template's cases, all `pass`", "def my_count(lst: list) -> int:\n    match lst:\n        case []:\n            pass  # YOUR CODE HERE\n        case [f, *r]:\n            pass\n", []],
      // Pyret's answers on their own lines: each told to `return`, once.
      ["each case's answer thrown away", "def my_count(lst: list) -> int:\n    match lst:\n        case []:\n            0\n        case [f, *r]:\n            1 + my_count(r)\n", ["unused-value@4", "unused-value@6"]],
      ["one case written, the other not", "def my_count(lst: list) -> int:\n    match lst:\n        case []:\n            pass\n        case [f, *r]:\n            n = 1 + my_count(r)\n", ["missing-return@1"]],
      ["an `if` without an `else`, its answer thrown away", "def sign(x: int) -> int:\n    if x > 0:\n        1\n", ["missing-return@1", "unused-value@3"]],
    ];
    for (const [label, code, want] of CASES) {
      const got = analyze(code, "beginner", "ret.py")
        .filter((f) => ["missing-return", "unused-value", "unused-comparison"].includes(f.id))
        .map((f) => `${f.id}@${f.line_number}`);
      expect(got.join(" ") === want.join(" "), `${label}: ${got.join(" ")}, not ${want.join(" ")}`);
    }
    const words = (code) => wordStatic(analyze(code, "beginner", "ret.py").filter((f) => f.id === "missing-return"), "beginner", "ret.py")[0];
    const printed = words("def area(r: float) -> float:\n    print(3.14 * r * r)\n");
    expect(
      printed?.headline === "`area` should return a number (`float`), but it has no `return`, so it always gives back `None`." &&
        printed.howToFix[0] === "Line 2 ends it with `print`: did you mean `return 3.14 * r * r`?",
      `printed: ${JSON.stringify(printed)}`,
    );
    const plain = words("def say(word: str) -> None:\n    print(word)\n\n\ndef shout(word: str) -> str:\n    say(word)\n");
    expect(
      JSON.stringify(plain?.howToFix) ===
        JSON.stringify(["End it with `return` and the value it works out.", "Or annotate the return type as `None` if `shout` is not meant to return anything."]),
      `a call, which may give back nothing: ${JSON.stringify(plain?.howToFix)}`,
    );
    const union = words("def first(xs: list[int]) -> int | None:\n    print(xs)\n");
    expect(/should return `int \| None`/.test(union?.headline ?? ""), `an annotation as written: ${union?.headline}`);
    expect(analyze("def area(r: float) -> float:\n    a = r\n", "intermediate", "ret.py").some((f) => f.id === "missing-return"), "at intermediate too");
    expect(!analyze("def area(r: float) -> float:\n    a = r\n", "advanced", "ret.py").some((f) => f.id === "missing-return"), "and not at advanced");
    console.log(`    ${CASES.length} functions`);
  }

  console.log("\n[32] `Callable` is given at the student levels, so it needs no import");
  {
    const USE = "def apply(f: Callable[[int], int]) -> int:\n    return f(1)\n";
    for (const level of ["beginner", "intermediate", "advanced"]) {
      const found = analyze(USE, level, "cal.py");
      expect(!found.some((f) => f.id === "undefined-name"), `${level}: used without an import: ${JSON.stringify(found.map((f) => f.id))}`);
    }
    // Importing it anyway rebinds a name PLL gives, and is said as such.
    for (const imported of ["from collections.abc import Callable", "from typing import Callable"]) {
      const [said] = wordStatic(analyze(`${imported}\n${USE}`, "beginner", "cal.py").filter((f) => f.id === "shadowing-library"), "beginner", "cal.py");
      expect(
        said?.headline === "`Callable` needs no import: PLL gives every file `Callable` at `#level beginner`." &&
          JSON.stringify(said.howToFix) === JSON.stringify(["Delete this import."]),
        `${imported}: ${JSON.stringify(said)}`,
      );
    }
    const [defined] = wordStatic(analyze("Callable = 5\n", "intermediate", "cal.py").filter((f) => f.id === "shadowing-library"), "intermediate", "cal.py");
    expect(/^`Callable` is already defined: PLL gives every file `Callable` at `#level intermediate`/.test(defined?.headline ?? ""), `defined: ${defined?.headline}`);
    // `advanced` makes none of the teaching checks, and `raw` gives no `Callable`.
    expect(analyze(`from collections.abc import Callable\n${USE}`, "advanced", "cal.py").length === 0, "the import is allowed at advanced");
    console.log("    no import needed; an import, or a definition, of it is said; advanced allows it");
  }

  console.log("\n[33] `dataclass` is given at the student levels too, so it needs no import");
  {
    const USE = "@dataclass\nclass Dog:\n    name: str\n";
    for (const level of ["beginner", "intermediate", "advanced"]) {
      const found = analyze(USE, level, "dc.py");
      expect(found.length === 0, `${level}: used without an import: ${JSON.stringify(found.map((f) => f.id))}`);
    }
    const [said] = wordStatic(analyze(`from dataclasses import dataclass\n${USE}`, "beginner", "dc.py").filter((f) => f.id === "shadowing-library"), "beginner", "dc.py");
    expect(
      said?.headline === "`dataclass` needs no import: PLL gives every file `dataclass` at `#level beginner`." &&
        JSON.stringify(said.howToFix) === JSON.stringify(["Delete this import."]),
      `the import: ${JSON.stringify(said)}`,
    );
    // An import of more than it: only `dataclass` comes out of it.
    for (const [imported, kept] of [
      ["from dataclasses import dataclass, replace", "from dataclasses import replace"],
      ["from dataclasses import field, dataclass, replace as r", "from dataclasses import field, replace as r"],
    ]) {
      const [mixed] = wordStatic(analyze(`${imported}\n${USE}`, "intermediate", "dc.py").filter((f) => f.id === "shadowing-library"), "intermediate", "dc.py");
      expect(
        JSON.stringify(mixed?.howToFix) === JSON.stringify([`Take \`dataclass\` out of this import: \`${kept}\`.`]),
        `${imported}: ${JSON.stringify(mixed?.howToFix)}`,
      );
    }
    const [defined] = wordStatic(analyze("def dataclass(x: int) -> int:\n    return x\n", "beginner", "dc.py").filter((f) => f.id === "shadowing-library"), "beginner", "dc.py");
    expect(
      defined?.headline === "`dataclass` is already defined: PLL gives every file `dataclass` at `#level beginner`, for `@dataclass` above a class.",
      `defined: ${defined?.headline}`,
    );
    expect(analyze(`from dataclasses import dataclass\n${USE}`, "advanced", "dc.py").length === 0, "the import is allowed at advanced");
    // A class with fields and no `@dataclass` is told to write it, and nothing about an import.
    const [bare] = wordStatic(analyze("class Song:\n    title: str\n", "beginner", "dc.py").filter((f) => f.id === "class-needs-dataclass"), "beginner", "dc.py");
    expect(JSON.stringify(bare?.howToFix) === JSON.stringify(["Write `@dataclass` on the line above `class Song`."]), `no @dataclass: ${JSON.stringify(bare?.howToFix)}`);
    console.log("    no import needed; an import of it is said, and one of more keeps the rest; advanced allows it");
  }

  fn.destroy?.();

  console.log(passed() ? "\nALL SMOKE TESTS PASSED" : "\nFAILED");
  if (!passed()) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
