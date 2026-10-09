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

const { enrichStaticFindings, LEVEL_NAMES } = await importSource(`
import { enrichStaticFindings as explainFindings } from "./src/common/analyzers/static/registry";
import { staticFindingsFrom } from "./src/common/fromPython";
/** Findings as Python sends them, through the runtime's translation. */
export const enrichStaticFindings = (raw, level, fileName) => explainFindings(staticFindingsFrom(raw), level, fileName);
export { LEVEL_NAMES } from "./src/common/level";
`);
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
        `      [${f.id}] line ${f.line_number}: ${f.error_type} ${f.name_token ?? ""} (keyword=${f.keyword})`,
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
        "from dataclasses import dataclass",
        "",
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
      ["assert on a tuple", "def test_add():\n    assert(1 + 1, 2)\n", "assert-tuple", 2],
      [
        "a method named but not called",
        'def report(t):\n    print(t.mean)\n',
        "method-not-called",
        2,
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
        "from dataclasses import dataclass\n\n\n@dataclass\nclass Song:\n    count: int\n\n\ndef show(s: Song):\n    print(s.count)\n",
      ],
      // A class of their own called `Number` is a type.
      [
        "an annotation naming their own class",
        "from dataclasses import dataclass\n\n\n@dataclass\nclass Number:\n    value: int\n\n\ndef twice(n: Number) -> Number:\n    return n\n",
      ],
      // `type(a) == Boa` is a real check, however unidiomatic.
      [
        "a type() comparison",
        "from dataclasses import dataclass\n\n\n@dataclass\nclass Boa:\n    name: str\n\n\ndef f(a):\n    return type(a) == Boa\n",
      ],
    ]) {
      const findings = analyze(code, "beginner", "quiet.py");
      expect(findings.length === 0, `${label} should stay silent, got ${JSON.stringify(findings)}`);
    }
    console.log("    and correct code stays silent");

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
      "from dataclasses import dataclass\n\n\n@dataclass\nclass Boa:\n    name: str\n    year = int\n    length\n",
      "beginner",
      "dc.py",
    );
    expect(
      fields.some((f) => f.id === "field-assigned-type" && f.line_number === 7),
      `\`year = int\` is flagged: ${JSON.stringify(fields)}`,
    );
    expect(
      fields.some((f) => f.id === "field-assigned-type" && f.written_type === "int"),
      `with the type written carried through: ${JSON.stringify(fields)}`,
    );
    const asStr = analyze(
      "from dataclasses import dataclass\n\n\n@dataclass\nclass Song:\n    name = str\n",
      "beginner",
      "dc2.py",
    );
    expect(
      asStr.some((f) => f.id === "field-assigned-type" && f.written_type === "str"),
      `\`name = str\` carries \`str\`, not \`int\`: ${JSON.stringify(asStr)}`,
    );
    expect(
      fields.some((f) => f.id === "field-no-type" && f.line_number === 8),
      `a field with no type is flagged: ${JSON.stringify(fields)}`,
    );

    // A function written above the class it compares against is ordinary,
    // so the class names are collected before anything else is looked at.
    const above = analyze(
      "from dataclasses import dataclass\n\n\ndef f(a):\n    return a == Boa\n\n\n@dataclass\nclass Boa:\n    name: str\n",
      "beginner",
      "order.py",
    );
    expect(
      above.some((f) => f.id === "compared-with-class" && f.line_number === 5),
      `a comparison above the class is still seen: ${JSON.stringify(above)}`,
    );

    // `if a == Boa:` is always False, and runs without complaint.
    const compared = analyze(
      "from dataclasses import dataclass\n\n\n@dataclass\nclass Boa:\n    name: str\n\n\ndef f(a):\n    return a == Boa\n",
      "beginner",
      "cmp.py",
    );
    expect(
      compared.some((f) => f.id === "compared-with-class" && f.line_number === 10),
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
    // the host's wording is built from. (That wording is checked in
    // smoke-explainers, which bundles the explainer.)
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
      const [finding] = enrichStaticFindings(raw, "beginner", "ann.py");
      const type = /^Write `([^`]+)` instead\.$/.exec(finding?.howToFix?.[0] ?? "")?.[1];
      expect(type !== undefined, `\`${written}\` gets a replacement: ${JSON.stringify(finding?.howToFix)}`);
      if (type === undefined) continue;
      const result = evaluate(type, `types-${written}`, "raw").toJs({ dict_converter: Object.fromEntries });
      expect(result.ok && !result.error_type, `\`${written}\` -> \`${type}\`, which a program has: ${result.error_type ?? "ok"}`);
      suggested.push(`${written}->${type}`);
    }
    evaluate.destroy?.();
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
      enrichStaticFindings(analyze(code, "beginner", "bind.py"), "beginner", "bind.py").map((f) =>
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
    const [finding] = enrichStaticFindings(analyze("x = 60.5\nassert x is 60.5\n", "beginner", "is.py"), "beginner", "is.py");
    expect(finding?.howToFix?.[0] === "To compare with `60.5`, write `==` instead.", `the fix: ${JSON.stringify(finding)}`);
    expect(analyze("x = 1\nprint(x is 1)\n", "advanced", "is.py").length === 0, "advanced is Python");
    console.log("    `is 60.5` and `is not \"Ada\"`, and never `is None`");
  }

  fn.destroy?.();

  console.log(passed() ? "\nALL SMOKE TESTS PASSED" : "\nFAILED");
  if (!passed()) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
