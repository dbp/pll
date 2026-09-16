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
  pyodide.runPython(readPy("src/common/imageLib.py"));
  pyodide.runPython(readPy("src/common/tableLib.py"));

  // Re-derive PYODIDE_INSTALL_PY rather than parsing the TS file.
  pyodide.runPython(`
import sys as _sys, types as _types
_pll_module = _types.ModuleType("pll")
_pll_image_module = _types.ModuleType("pll.image")
_pll_table_module = _types.ModuleType("pll.table")
for _name in PLL_IMAGE_EXPORTS:
    setattr(_pll_image_module, _name, globals()[_name])
for _name in PLL_TABLE_EXPORTS:
    setattr(_pll_table_module, _name, globals()[_name])
_pll_module.image = _pll_image_module
_pll_module.table = _pll_table_module
_sys.modules["pll"] = _pll_module
_sys.modules["pll.image"] = _pll_image_module
_sys.modules["pll.table"] = _pll_table_module
for _name in PLL_IMAGE_EXPORTS:
    _pll_initial_globals[_name] = globals()[_name]
for _name in PLL_TABLE_EXPORTS:
    _pll_initial_globals[_name] = globals()[_name]
del _name
`);

  const callRunFile = pyodide.globals.get("_pll_run_file");
  const callReplEval = pyodide.globals.get("_pll_repl_eval");
  const py = (fn, args) => {
    const proxy = fn(...args);
    const obj = proxy.toJs({ dict_converter: Object.fromEntries });
    proxy.destroy?.();
    return obj;
  };

  // Default session key used by tests that don't care about session isolation.
  const SK = "test:default";

  // Helper: extract the image-typed entries from a result.
  const imagesOf = (result) =>
    Array.isArray(result.displays)
      ? result.displays.filter((d) => d.type === "image")
      : [];

  console.log("\n[1] run-file: samples/images.py - expect 6 images, no error");
  {
    const result = py(callRunFile, [readPy("samples/images.py"), "images.py", SK]);
    const images = imagesOf(result);
    console.log(`    ok=${result.ok}, images=${images.length}`);
    if (result.error_type) {
      console.log(`    error: ${result.error_type}: ${result.error_message}`);
    }
    expect(result.ok, "samples/images.py should run cleanly");
    expect(images.length === 6, `expected 6 images, got ${images.length}`);
    if (images.length >= 1) {
      const first = images[0];
      expect(first.type === "image", "display.type === 'image'");
      expect(first.format === "svg", "display.format === 'svg'");
      expect(typeof first.data === "string" && first.data.startsWith("<svg "),
        "first image data starts with <svg");
      expect(first.data.includes("<circle"), "first image (circle) includes <circle>");
      expect(first.width === 100 && first.height === 100,
        `circle(50) should be 100x100, got ${first.width}x${first.height}`);
    }
  }

  console.log("\n[2] repl-eval: a top-level image expression");
  {
    const result = py(callReplEval, [`circle(20, "solid", "blue")`, SK]);
    const images = imagesOf(result);
    console.log(`    ok=${result.ok}, images=${images.length}, repr=${result.result_repr}`);
    expect(result.ok, "repl-eval should succeed");
    expect(images.length === 1, "one image emitted");
    expect(result.result_repr == null, "image takes the place of result_repr");
  }

  console.log("\n[3] repl-eval: non-image expression still uses result_repr");
  {
    const result = py(callReplEval, [`1 + 2`, SK]);
    const images = imagesOf(result);
    console.log(`    repr=${result.result_repr}, images=${images.length}`);
    expect(result.result_repr === "3", "1 + 2 -> '3'");
    expect(images.length === 0, "no images for plain expressions");
  }

  console.log("\n[4] run-file: top-level docstring isn't displayed");
  {
    const code = `"""A docstring at module top."""\nx = 1\n`;
    const result = py(callRunFile, [code, "doc.py", SK]);
    expect(result.ok, "docstring file runs");
    expect(imagesOf(result).length === 0, "docstring should not be auto-displayed as repr");
    expect(result.stdout === "", `expected no stdout for docstring, got ${JSON.stringify(result.stdout)}`);
  }

  console.log("\n[5] run-file: bare 1+2 prints 3 (HtDP-style)");
  {
    const result = py(callRunFile, [`1 + 2\n`, "expr.py", SK]);
    expect(result.ok, "bare expression file runs");
    expect(result.stdout.trim() === "3", `expected stdout '3', got ${JSON.stringify(result.stdout)}`);
  }

  console.log("\n[6] beside + above produce composed bounding boxes");
  {
    const code = `beside(circle(10, "solid", "red"), square(50, "solid", "blue"))`;
    const result = py(callReplEval, [code, SK]);
    const images = imagesOf(result);
    expect(images.length === 1, "one image");
    if (images[0]) {
      const img = images[0];
      // beside: width = sum (20 + 50 = 70), height = max(20, 50) = 50
      expect(img.width === 70, `beside width should be 70, got ${img.width}`);
      expect(img.height === 50, `beside height should be 50, got ${img.height}`);
      expect(img.data.includes("<circle"), "contains circle");
      expect(img.data.includes("<rect"), "contains square (rect)");
    }
  }

  console.log("\n[7] run-file resets globals between runs of the same session");
  {
    // First file defines `x` and `pll_special`.
    const r1 = py(callRunFile, [`x = 5\npll_special = 42\n`, "a.py", SK]);
    expect(r1.ok, "first run ok");

    // REPL can still see `x` (REPL inherits the file's globals).
    const r1Repl = py(callReplEval, [`x`, SK]);
    expect(r1Repl.ok && r1Repl.result_repr === "5", `REPL sees x=5, got ${r1Repl.result_repr}`);

    // Image primitives must still be available after a file run.
    const r1Img = py(callReplEval, [`circle(10, "solid", "red")`, SK]);
    expect(r1Img.ok && imagesOf(r1Img).length === 1, "image primitives survive run-file");

    // Run a second file (same session) that does NOT define `x`. The
    // previous run's `x` and `pll_special` must be wiped.
    const r2 = py(callRunFile, [`y = 7\n`, "b.py", SK]);
    expect(r2.ok, "second run ok");

    const r2X = py(callReplEval, [`x`, SK]);
    expect(
      !r2X.ok && r2X.error_type === "NameError",
      `expected NameError for x after reset, got ok=${r2X.ok} type=${r2X.error_type}`,
    );

    const r2Special = py(callReplEval, [`pll_special`, SK]);
    expect(
      !r2Special.ok && r2Special.error_type === "NameError",
      "expected NameError for pll_special after reset",
    );

    // Image primitives must still be available after the reset.
    const r2Img = py(callReplEval, [`square(20, "solid", "green")`, SK]);
    expect(r2Img.ok && imagesOf(r2Img).length === 1, "image primitives survive reset");

    // The current file's defs are present.
    const r2Y = py(callReplEval, [`y`, SK]);
    expect(r2Y.ok && r2Y.result_repr === "7", "REPL sees y=7 from second file");
  }

  console.log("\n[8] sessions are isolated: file A's defs don't leak into file B");
  {
    const SK_A = "test:fileA";
    const SK_B = "test:fileB";

    // Run file A in session A.
    const ra = py(callRunFile, [`alpha = 'from-A'\n`, "fileA.py", SK_A]);
    expect(ra.ok, "fileA runs");

    // REPL in session A sees alpha.
    const rar = py(callReplEval, [`alpha`, SK_A]);
    expect(rar.result_repr === "'from-A'", "session A sees alpha");

    // Run file B in session B (different session). It defines `beta` and
    // does not mention alpha at all.
    const rb = py(callRunFile, [`beta = 'from-B'\n`, "fileB.py", SK_B]);
    expect(rb.ok, "fileB runs");

    // REPL in session B sees beta but NOT alpha.
    const rbr = py(callReplEval, [`beta`, SK_B]);
    expect(rbr.result_repr === "'from-B'", "session B sees beta");
    const rbAlpha = py(callReplEval, [`alpha`, SK_B]);
    expect(
      !rbAlpha.ok && rbAlpha.error_type === "NameError",
      "session B does NOT see alpha (per-file isolation)",
    );

    // Switching back to A, alpha is still defined and beta is not.
    const raAlpha = py(callReplEval, [`alpha`, SK_A]);
    expect(raAlpha.result_repr === "'from-A'", "session A still has alpha");
    const raBeta = py(callReplEval, [`beta`, SK_A]);
    expect(
      !raBeta.ok && raBeta.error_type === "NameError",
      "session A does NOT see beta (per-file isolation)",
    );

    // Image primitives are present in both sessions.
    const aImg = py(callReplEval, [`circle(5, "solid", "red")`, SK_A]);
    const bImg = py(callReplEval, [`circle(5, "solid", "red")`, SK_B]);
    expect(imagesOf(aImg).length === 1 && imagesOf(bImg).length === 1,
      "image primitives are present in both sessions");
  }

  console.log("\n[9] static analyzer still works after image lib loaded");
  {
    const fn = pyodide.globals.get("_pll_static_analyze");
    const proxy = fn(`#level beginner\nx = 1\nx = 2\n`, "beginner", "t.py");
    const findings = proxy.toJs({ dict_converter: Object.fromEntries });
    proxy.destroy?.();
    fn.destroy?.();
    expect(findings.length === 1 && findings[0].id === "reassignment",
      "static analyzer still produces reassignment finding");
  }

  console.log("\n[10] the HtDP combinators reach user globals and compose");
  {
    // One image per expression, so `images[i]` lines up with `cases[i]`.
    const cases = [
      // overlay_xy: dx/dy move image2, and negative offsets grow the box
      // rather than clipping anything.
      [`overlay_xy(square(50, "solid", "red"), 10, 10, square(30, "solid", "blue"))`, 50, 50],
      [`overlay_xy(square(50, "solid", "red"), 40, 0, square(30, "solid", "blue"))`, 70, 50],
      [`overlay_xy(square(50, "solid", "red"), -20, -20, square(30, "solid", "blue"))`, 70, 70],
      [`underlay_xy(square(50, "solid", "red"), -20, -20, square(30, "solid", "blue"))`, 70, 70],
      // align variants keep the same bounding box as their plain forms.
      [`beside_align("top", rectangle(20, 60, "solid", "red"), square(20, "solid", "blue"))`, 40, 60],
      [`above_align("left", rectangle(60, 20, "solid", "red"), square(20, "solid", "blue"))`, 60, 40],
      [`overlay_align("left", "top", rectangle(60, 20, "solid", "red"), square(20, "solid", "blue"))`, 60, 20],
      [`underlay_align("right", "bottom", rectangle(60, 20, "solid", "red"), square(20, "solid", "blue"))`, 60, 20],
      // scene-shaped operations report the scene / requested size.
      [`empty_scene(100, 80)`, 100, 80],
      [`place_image(square(30, "solid", "blue"), 50, 40, empty_scene(100, 80))`, 100, 80],
      [`crop(10, 10, 25, 25, square(50, "solid", "red"))`, 25, 25],
      [`frame(square(50, "solid", "red"))`, 50, 50],
    ];
    for (const [code, w, h] of cases) {
      const images = imagesOf(py(callReplEval, [code, SK]));
      const label = code.length > 52 ? code.slice(0, 52) + "..." : code;
      if (images.length !== 1) {
        expect(false, `expected one image from ${label}, got ${images.length}`);
        continue;
      }
      const img = images[0];
      expect(
        img.width === w && img.height === h,
        `${label}: expected ${w}x${h}, got ${img.width}x${img.height}`,
      );
    }
    console.log(`    ${cases.length} combinators produced the expected bounding boxes`);
  }

  console.log("\n[11] negative offsets never render outside the viewBox");
  {
    const code = `overlay_xy(square(50, "solid", "red"), -20, -20, square(30, "solid", "blue"))`;
    const img = imagesOf(py(callReplEval, [code, SK]))[0];
    // The blue square sits at the new origin and the red one is shifted in.
    expect(/<rect x="0" y="0"[^>]*fill="blue"/.test(img.data), "image2 should land at the origin");
    expect(/<rect x="20" y="20"[^>]*fill="red"/.test(img.data), "image1 should be shifted in by 20");
    // Painting order: the first argument ends up on top, so it is drawn last.
    expect(
      img.data.indexOf("blue") < img.data.indexOf("red"),
      "overlay_xy should paint image1 last so it is on top",
    );
  }

  console.log("\n[12] place_image and crop clip with distinct ids");
  {
    const code = `beside(crop(0, 0, 10, 10, square(50, "solid", "red")), place_image(square(30, "solid", "blue"), 5, 5, empty_scene(40, 40)))`;
    const img = imagesOf(py(callReplEval, [code, SK]))[0];
    const ids = [...new Set((img.data.match(/id="pllclip\d+"/g) || []))];
    expect(ids.length === 2, `two clip regions should get distinct ids, got ${ids.length}`);
    expect(img.data.includes("clip-path"), "clipping should be applied");
  }

  console.log("\n[13] a bad alignment name is a friendly ValueError");
  {
    const result = py(callReplEval, [`beside_align("sideways", square(10, "solid", "red"))`, SK]);
    expect(result.ok === false, "an invalid place should fail");
    expect(result.error_type === "ValueError", `expected ValueError, got ${result.error_type}`);
    expect(
      /beside_align/.test(result.error_message || ""),
      `the message should name the function, got ${result.error_message}`,
    );
    console.log(`    ${result.error_type}: ${result.error_message}`);
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
