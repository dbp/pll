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


  console.log("\n[14] load_image reads a picture and it composes like any other");
  {
    const SVG_FIXTURE =
      '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"/>';
    // The PNG is built in Python rather than checked in: the point is that
    // the loader reads real bytes and finds the size in the header, and a
    // fixture would only add a binary file to maintain.
    const png = [
      "import struct, zlib",
      "def png(w, h):",
      '    ihdr = struct.pack(">II", w, h) + bytes([8, 6, 0, 0, 0])',
      '    chunk = struct.pack(">I", len(ihdr)) + b"IHDR" + ihdr',
      '    chunk += struct.pack(">I", zlib.crc32(b"IHDR" + ihdr))',
      '    return b"\\x89PNG\\r\\n\\x1a\\n" + chunk',
      'with open("pic.png", "wb") as f:',
      "    f.write(png(40, 25))",
    ].join("\n");
    const code = [
      png,
      'pic = load_image("pic.png")',
      "print(image_width(pic), image_height(pic))",
      "print(image_width(scale(2, pic)), image_height(scale(2, pic)))",
      'print(image_width(beside(pic, square(10, "solid", "red"))))',
      'print("data:image/png;base64," in pic.to_svg())',
      // An SVG is read from its attributes rather than a binary header.
      'with open("v.svg", "w") as f:',
      `    f.write(${JSON.stringify(SVG_FIXTURE)})`,
      'print(image_width(load_image("v.svg")), image_height(load_image("v.svg")))',
    ].join("\n");
    const result = py(callRunFile, [code, "loadimg.py", SK]);
    expect(result.ok === true, `ran: ${result.error_message ?? ""}`);
    const lines = (result.stdout ?? "").trim().split("\n");
    expect(lines[0] === "40 25", `png size from the header: ${lines[0]}`);
    expect(lines[1] === "80 50", `scales like a drawn shape: ${lines[1]}`);
    expect(lines[2] === "50", `composes with the combinators: ${lines[2]}`);
    // Embedded, not linked: a saved .svg has to keep working on its own.
    expect(lines[3] === "True", "the bytes travel inside the svg");
    // `image_width` reports whole pixels, as it does for a drawn shape.
    expect(lines[4] === "80 60", `svg size from its attributes: ${lines[4]}`);
    console.log("    png read, scaled, composed; svg read from attributes");
  }

  console.log("\n[15] load_image says what it cannot read");
  {
    for (const [code, kind, needle] of [
      ['load_image("nope.png")', "FileNotFoundError", "no file called"],
      ['load_image("gopher://h/a.png")', "ValueError", "not a gopher:// one"],
      ["load_image(7)", "TypeError", "as a string"],
      [
        ['with open("t.txt", "w") as f:', '    f.write("not a picture")', 'load_image("t.txt")'].join("\n"),
        "ValueError",
        "PNG, JPEG, GIF",
      ],
      [
        ['with open("z.png", "wb") as f:', "    f.write(b\"\")", 'load_image("z.png")'].join("\n"),
        "ValueError",
        "is empty",
      ],
    ]) {
      const result = py(callRunFile, [code, "liderr.py", SK]);
      expect(
        result.ok === false && result.error_type === kind &&
          (result.error_message ?? "").includes(needle),
        `${kind}/${needle}, got ${result.error_type}: ${result.error_message}`,
      );
    }
    console.log("    five bad inputs, each named precisely");
  }

  console.log("\n[16] a non-colour or a misspelled mode is refused, not drawn");
  {
    // SVG ignores a paint value it cannot parse, so these used to draw an
    // invisible shape and say nothing.
    for (const [code, needle] of [
      ['rectangle(30, 40, "solid", 50)', "is not a colour"],
      ['rectangle(30, 40, "solid", "50")', "is not a colour"],
      ['circle(10, "solid", None)', "is not a colour"],
      ['text("hi", 12, 7)', "is not a colour"],
      ["line(5, 5, {})", "is not a colour"],
      ['circle(10, "solid", ("r", 0, 0))', "have to be numbers"],
      ['circle(10, "solid", (300, 0, 0))', "runs from 0 to 255"],
      ['circle(10, "sloid", "red")', 'expected "solid" or "outline"'],
      ['regular_polygon(10, 5, "filled", "red")', 'expected "solid" or "outline"'],
    ]) {
      const result = py(callRunFile, [code, "color.py", SK]);
      expect(
        result.ok === false && result.error_type === "ValueError" &&
          (result.error_message ?? "").includes(needle),
        `${code} -> ${needle}, got ${result.error_type}: ${result.error_message}`,
      );
      // The message has to name the function the student called, not an
      // internal helper.
      expect(
        (result.error_message ?? "").startsWith(code.split("(")[0] + ":"),
        `${code} should be blamed on its own call: ${result.error_message}`,
      );
    }
    console.log("    nine bad colours and modes, each blamed on its own call");

    // And every documented form still works.
    const good = [
      '"red"', '"#ff0000"', '"#f00"', '"rgb(1, 2, 3)"',
      "(10, 20, 30)", "(10, 20, 30, 0.5)", "(10, 20, 30, 255)",
    ];
    const result = py(callRunFile, [
      good.map((c) => `circle(5, "solid", ${c})`).join("\n") + "\nempty_image\n",
      "goodcolor.py",
      SK,
    ]);
    expect(result.ok === true, `documented colours still work: ${result.error_message ?? ""}`);
    expect(imagesOf(result).length === good.length + 1,
      `expected ${good.length + 1} images, got ${imagesOf(result).length}`);
    console.log(`    ${good.length} colour spellings still accepted`);
  }

  console.log("\n[17] regular_polygon sits on a side, and its box is its real size");
  {
    // `regular_polygon(40, 4, ...)` was a 57x57 diamond: a vertex at the top
    // puts one at the bottom too when the side count is even. The box also
    // has to be the shape's extent, not the circle it was cut from.
    const sizes = py(callRunFile, [
      [
        "for n in (3, 4, 6, 8):",
        '    p = regular_polygon(40, n, "solid", "red")',
        '    print(n, image_width(p), image_height(p))',
      ].join("\n"),
      "poly.py",
      SK,
    ]);
    expect(sizes.ok === true, `ran: ${sizes.error_message ?? ""}`);
    const got = sizes.stdout.trim().split("\n");
    // 3: 40 wide, 40*sqrt(3)/2 tall. 4: a square. 6: 2R across,
    // 2R*sqrt(3)/2 tall. 8: 40*(1+sqrt(2)) each way.
    expect(got[0] === "3 40 35", `triangle: ${got[0]}`);
    expect(got[1] === "4 40 40", `square, not a diamond: ${got[1]}`);
    expect(got[2] === "6 80 70", `hexagon: ${got[2]}`);
    expect(got[3] === "8 97 97", `octagon: ${got[3]}`);

    // 80.00000000000001 from the cosines used to ceil to 81, leaving a
    // blank column down one side of every such shape.
    const zero = py(callRunFile, [
      [
        "print(image_width(empty_image), image_height(empty_image))",
        'print(image_width(rectangle(0.4, 3, "solid", "red")))',
      ].join("\n"),
      "zero.py",
      SK,
    ]);
    // Rounding must not turn an empty image into a 1x1 one: `beside` and
    // friends do arithmetic with that zero.
    expect(zero.stdout.trim().split("\n")[0] === "0 0", `empty_image stays 0x0: ${zero.stdout}`);
    expect(zero.stdout.trim().split("\n")[1] === "1", `a fractional size still rounds up: ${zero.stdout}`);
    console.log("    flat-bottomed, measured exactly, and still zero when empty");
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
