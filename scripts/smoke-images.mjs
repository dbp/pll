#!/usr/bin/env node
/**
 * Smoke test for the image library + top-level auto-display.
 *
 * Boots Pyodide in Node, loads the bootstrap, image library, and install
 * snippet, then exercises both code paths (run-file and repl-eval) and
 * checks the SVG output looks sensible.
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

let ok = true;
function expect(cond, msg) {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    ok = false;
  }
}

async function main() {
  const indexURL = resolve(ROOT, "node_modules", "pyodide");
  const pyodide = await loadPyodide({ indexURL });

  pyodide.runPython(readPy("src/common/pyodideBootstrap.py"));
  pyodide.runPython(readPy("src/common/bonnieImageLib.py"));

  // Re-derive PYODIDE_INSTALL_PY rather than parsing the TS file.
  pyodide.runPython(`
import sys as _sys, types as _types
_bonnie_module = _types.ModuleType("bonnie")
_bonnie_image_module = _types.ModuleType("bonnie.image")
for _name in BONNIE_IMAGE_EXPORTS:
    setattr(_bonnie_image_module, _name, globals()[_name])
_bonnie_module.image = _bonnie_image_module
_sys.modules["bonnie"] = _bonnie_module
_sys.modules["bonnie.image"] = _bonnie_image_module
for _name in BONNIE_IMAGE_EXPORTS:
    _bonnie_user_globals[_name] = globals()[_name]
del _name
_bonnie_capture_initial_globals()
`);

  const callRunFile = pyodide.globals.get("_bonnie_run_file");
  const callReplEval = pyodide.globals.get("_bonnie_repl_eval");
  const py = (fn, args) => {
    const proxy = fn(...args);
    const obj = proxy.toJs({ dict_converter: Object.fromEntries });
    proxy.destroy?.();
    return obj;
  };

  console.log("\n[1] run-file: samples/images.py - expect 6 images, no error");
  {
    const result = py(callRunFile, [readPy("samples/images.py"), "images.py"]);
    console.log(`    ok=${result.ok}, images=${result.images.length}`);
    if (result.error_type) {
      console.log(`    error: ${result.error_type}: ${result.error_message}`);
    }
    expect(result.ok, "samples/images.py should run cleanly");
    expect(result.images.length === 6, `expected 6 images, got ${result.images.length}`);
    if (result.images.length >= 1) {
      const first = result.images[0];
      expect(first.type === "svg", "image type is svg");
      expect(typeof first.data === "string" && first.data.startsWith("<svg "),
        "first image data starts with <svg");
      expect(first.data.includes("<circle"), "first image (circle) includes <circle>");
      expect(first.width === 100 && first.height === 100,
        `circle(50) should be 100x100, got ${first.width}x${first.height}`);
    }
  }

  console.log("\n[2] repl-eval: a top-level image expression");
  {
    const result = py(callReplEval, [`circle(20, "solid", "blue")`]);
    console.log(`    ok=${result.ok}, images=${result.images.length}, repr=${result.result_repr}`);
    expect(result.ok, "repl-eval should succeed");
    expect(result.images.length === 1, "one image emitted");
    expect(result.result_repr == null, "image takes the place of result_repr");
  }

  console.log("\n[3] repl-eval: non-image expression still uses result_repr");
  {
    const result = py(callReplEval, [`1 + 2`]);
    console.log(`    repr=${result.result_repr}, images=${result.images.length}`);
    expect(result.result_repr === "3", "1 + 2 -> '3'");
    expect(result.images.length === 0, "no images for plain expressions");
  }

  console.log("\n[4] run-file: top-level docstring isn't displayed");
  {
    const code = `"""A docstring at module top."""\nx = 1\n`;
    const result = py(callRunFile, [code, "doc.py"]);
    expect(result.ok, "docstring file runs");
    expect(result.images.length === 0, "docstring should not be auto-displayed as repr");
    expect(result.stdout === "", `expected no stdout for docstring, got ${JSON.stringify(result.stdout)}`);
  }

  console.log("\n[5] run-file: bare 1+2 prints 3 (HtDP-style)");
  {
    const result = py(callRunFile, [`1 + 2\n`, "expr.py"]);
    expect(result.ok, "bare expression file runs");
    expect(result.stdout.trim() === "3", `expected stdout '3', got ${JSON.stringify(result.stdout)}`);
  }

  console.log("\n[6] beside + above produce composed bounding boxes");
  {
    const code = `beside(circle(10, "solid", "red"), square(50, "solid", "blue"))`;
    const result = py(callReplEval, [code]);
    expect(result.images.length === 1, "one image");
    if (result.images[0]) {
      const img = result.images[0];
      // beside: width = sum (20 + 50 = 70), height = max(20, 50) = 50
      expect(img.width === 70, `beside width should be 70, got ${img.width}`);
      expect(img.height === 50, `beside height should be 50, got ${img.height}`);
      expect(img.data.includes("<circle"), "contains circle");
      expect(img.data.includes("<rect"), "contains square (rect)");
    }
  }

  console.log("\n[7] run-file resets globals between runs but REPL keeps file defs");
  {
    // First file defines `x` and `bonnie_special`.
    const r1 = py(callRunFile, [`x = 5\nbonnie_special = 42\n`, "a.py"]);
    expect(r1.ok, "first run ok");

    // REPL can still see `x` (REPL inherits the file's globals).
    const r1Repl = py(callReplEval, [`x`]);
    expect(r1Repl.ok && r1Repl.result_repr === "5", `REPL sees x=5, got ${r1Repl.result_repr}`);

    // Image primitives must still be available after a file run.
    const r1Img = py(callReplEval, [`circle(10, "solid", "red")`]);
    expect(r1Img.ok && r1Img.images.length === 1, "image primitives survive run-file");

    // Run a second file that does NOT define `x`. The previous run's `x`
    // and `bonnie_special` must be wiped.
    const r2 = py(callRunFile, [`y = 7\n`, "b.py"]);
    expect(r2.ok, "second run ok");

    const r2X = py(callReplEval, [`x`]);
    expect(
      !r2X.ok && r2X.error_type === "NameError",
      `expected NameError for x after reset, got ok=${r2X.ok} type=${r2X.error_type}`,
    );

    const r2Special = py(callReplEval, [`bonnie_special`]);
    expect(
      !r2Special.ok && r2Special.error_type === "NameError",
      "expected NameError for bonnie_special after reset",
    );

    // Image primitives must still be available after the reset.
    const r2Img = py(callReplEval, [`square(20, "solid", "green")`]);
    expect(r2Img.ok && r2Img.images.length === 1, "image primitives survive reset");

    // The current file's defs are present.
    const r2Y = py(callReplEval, [`y`]);
    expect(r2Y.ok && r2Y.result_repr === "7", "REPL sees y=7 from second file");
  }

  console.log("\n[8] static analyzer still works after image lib loaded");
  {
    const fn = pyodide.globals.get("_bonnie_static_analyze");
    const proxy = fn(`#beginner\nx = 1\nx = 2\n`, "beginner", "t.py");
    const findings = proxy.toJs({ dict_converter: Object.fromEntries });
    proxy.destroy?.();
    fn.destroy?.();
    expect(findings.length === 1 && findings[0].id === "reassignment",
      "static analyzer still produces reassignment finding");
  }

  callRunFile.destroy?.();
  callReplEval.destroy?.();

  if (!ok) {
    console.log("\nFAILED");
    process.exit(1);
  }
  console.log("\nALL IMAGE SMOKE TESTS PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
