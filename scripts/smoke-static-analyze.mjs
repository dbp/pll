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

  // Load the libraries + install step exactly like the extension does, so
  // the analyzer sees the library names (`circle`, `table`, `animate`, ...)
  // a real session starts with. Re-derived here rather than parsing the TS
  // (same convention as smoke-images.mjs); includes the reactor library so
  // its names are labeled too.
  pyodide.runPython(readPy("src/common/imageLib.py"));
  pyodide.runPython(readPy("src/common/tableLib.py"));
  pyodide.runPython(readPy("src/common/reactorLib.py"));
  pyodide.runPython(`
import sys as _sys, types as _types
_pll_module = _types.ModuleType("pll")
_pll_image_module = _types.ModuleType("pll.image")
_pll_table_module = _types.ModuleType("pll.table")
_pll_reactor_module = _types.ModuleType("pll.reactor")
for _name in PLL_IMAGE_EXPORTS:
    setattr(_pll_image_module, _name, globals()[_name])
for _name in PLL_TABLE_EXPORTS:
    setattr(_pll_table_module, _name, globals()[_name])
for _name in PLL_REACTOR_EXPORTS:
    setattr(_pll_reactor_module, _name, globals()[_name])
_pll_module.image = _pll_image_module
_pll_module.table = _pll_table_module
_pll_module.reactor = _pll_reactor_module
_sys.modules["pll"] = _pll_module
_sys.modules["pll.image"] = _pll_image_module
_sys.modules["pll.table"] = _pll_table_module
_sys.modules["pll.reactor"] = _pll_reactor_module
for _name in PLL_IMAGE_EXPORTS:
    _pll_initial_globals[_name] = globals()[_name]
for _name in PLL_TABLE_EXPORTS:
    _pll_initial_globals[_name] = globals()[_name]
for _name in PLL_REACTOR_EXPORTS:
    _pll_initial_globals[_name] = globals()[_name]
del _name
`);

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
    // finds the built-in, so there is nothing shadowed - but it was being
    // reported, telling students to rename a perfectly good field.
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
