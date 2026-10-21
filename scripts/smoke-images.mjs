#!/usr/bin/env node
/**
 * Smoke test for the image library + top-level auto-display.
 *
 * Boots Pyodide in Node with PLL installed the way the worker installs it,
 * then exercises both code paths (run-file and repl-eval) and
 * checks the SVG output looks sensible.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, passed } from "./lib/check.mjs";
import { bootPll } from "./lib/pyodide.mjs";
import { ROOT } from "./lib/bundle.mjs";

function readPy(rel) {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

async function main() {
  const pyodide = await bootPll();

  const runFileAt = pyodide.globals.get("_pll_run_file");
  // At a student level: `#level raw` is Python, which shows no top-level
  // value, and these are about what is shown. A level given is kept.
  const callRunFile = (code, fileName, session, level = "advanced", ...rest) =>
    runFileAt(code, fileName, session, level, ...rest);
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
      ? result.displays.filter((d) => d.kind === "image")
      : [];

  console.log("\n[1] run-file: samples/images.py - expect 6 images, no error");
  {
    const result = py(callRunFile, [readPy("samples/images.py"), "images.py", SK]);
    const images = imagesOf(result);
    console.log(`    ok=${result.ok}, images=${images.length}`);
    if (result.error?.errorType) {
      console.log(`    error: ${result.error?.errorType}: ${result.error?.message}`);
    }
    expect(result.ok, "samples/images.py should run cleanly");
    expect(images.length === 6, `expected 6 images, got ${images.length}`);
    if (images.length >= 1) {
      const first = images[0];
      expect(first.kind === "image", "display.type === 'image'");
      expect(typeof first.svg === "string" && first.svg.startsWith("<svg "),
        "first image data starts with <svg");
      expect(first.svg.includes("<circle"), "first image (circle) includes <circle>");
      expect(first.width === 100 && first.height === 100,
        `circle(50) should be 100x100, got ${first.width}x${first.height}`);
    }
  }

  console.log("\n[2] repl-eval: a top-level image expression");
  {
    const result = py(callReplEval, [`circle(20, "solid", "blue")`, SK]);
    const images = imagesOf(result);
    console.log(`    ok=${result.ok}, images=${images.length}, repr=${result.resultRepr}`);
    expect(result.ok, "repl-eval should succeed");
    expect(images.length === 1, "one image emitted");
    expect(result.resultRepr == null, "image takes the place of result_repr");
  }

  console.log("\n[3] repl-eval: non-image expression still uses result_repr");
  {
    const result = py(callReplEval, [`1 + 2`, SK]);
    const images = imagesOf(result);
    console.log(`    repr=${result.resultRepr}, images=${images.length}`);
    expect(result.resultRepr === "3", "1 + 2 -> '3'");
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

  console.log("\n[5] run-file: bare 1+2 prints 3 (HtDP-style) - but not at #level raw");
  {
    const result = py(callRunFile, [`1 + 2\n`, "expr.py", SK]);
    expect(result.ok, "bare expression file runs");
    expect(result.stdout.trim() === "3", `expected stdout '3', got ${JSON.stringify(result.stdout)}`);
    const raw = py(callRunFile, [`1 + 2\ncircle(5, "solid", "red")\n`, "expr.py", SK, "raw"]);
    expect(
      raw.ok && raw.stdout === "" && imagesOf(raw).length === 0,
      `at raw, as in Python, nothing: ${JSON.stringify(raw.stdout)} ${imagesOf(raw).length} images`,
    );
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
      expect(img.svg.includes("<circle"), "contains circle");
      expect(img.svg.includes("<rect"), "contains square (rect)");
    }
  }

  console.log("\n[7] run-file resets globals between runs of the same session");
  {
    // First file defines `x` and `pll_special`.
    const r1 = py(callRunFile, [`x = 5\npll_special = 42\n`, "a.py", SK]);
    expect(r1.ok, "first run ok");

    // REPL can still see `x` (REPL inherits the file's globals).
    const r1Repl = py(callReplEval, [`x`, SK]);
    expect(r1Repl.ok && r1Repl.resultRepr === "5", `REPL sees x=5, got ${r1Repl.resultRepr}`);

    // Image primitives must still be available after a file run.
    const r1Img = py(callReplEval, [`circle(10, "solid", "red")`, SK]);
    expect(r1Img.ok && imagesOf(r1Img).length === 1, "image primitives survive run-file");

    // Run a second file (same session) that does NOT define `x`. The
    // previous run's `x` and `pll_special` must be wiped.
    const r2 = py(callRunFile, [`y = 7\n`, "b.py", SK]);
    expect(r2.ok, "second run ok");

    const r2X = py(callReplEval, [`x`, SK]);
    expect(
      !r2X.ok && r2X.error?.errorType === "NameError",
      `expected NameError for x after reset, got ok=${r2X.ok} type=${r2X.error?.errorType}`,
    );

    const r2Special = py(callReplEval, [`pll_special`, SK]);
    expect(
      !r2Special.ok && r2Special.error?.errorType === "NameError",
      "expected NameError for pll_special after reset",
    );

    // Image primitives must still be available after the reset.
    const r2Img = py(callReplEval, [`square(20, "solid", "green")`, SK]);
    expect(r2Img.ok && imagesOf(r2Img).length === 1, "image primitives survive reset");

    // The current file's defs are present.
    const r2Y = py(callReplEval, [`y`, SK]);
    expect(r2Y.ok && r2Y.resultRepr === "7", "REPL sees y=7 from second file");
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
    expect(rar.resultRepr === "'from-A'", "session A sees alpha");

    // Run file B in session B (different session). It defines `beta` and
    // does not mention alpha at all.
    const rb = py(callRunFile, [`beta = 'from-B'\n`, "fileB.py", SK_B]);
    expect(rb.ok, "fileB runs");

    // REPL in session B sees beta but NOT alpha.
    const rbr = py(callReplEval, [`beta`, SK_B]);
    expect(rbr.resultRepr === "'from-B'", "session B sees beta");
    const rbAlpha = py(callReplEval, [`alpha`, SK_B]);
    expect(
      !rbAlpha.ok && rbAlpha.error?.errorType === "NameError",
      "session B does NOT see alpha (per-file isolation)",
    );

    // Switching back to A, alpha is still defined and beta is not.
    const raAlpha = py(callReplEval, [`alpha`, SK_A]);
    expect(raAlpha.resultRepr === "'from-A'", "session A still has alpha");
    const raBeta = py(callReplEval, [`beta`, SK_A]);
    expect(
      !raBeta.ok && raBeta.error?.errorType === "NameError",
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
    expect(/<rect x="0" y="0"[^>]*fill="blue"/.test(img.svg), "image2 should land at the origin");
    expect(/<rect x="20" y="20"[^>]*fill="red"/.test(img.svg), "image1 should be shifted in by 20");
    // Painting order: the first argument ends up on top, so it is drawn last.
    expect(
      img.svg.indexOf("blue") < img.svg.indexOf("red"),
      "overlay_xy should paint image1 last so it is on top",
    );
  }

  console.log("\n[11b] the aligned combinators line up by the edge they are given");
  {
    const RED_TALL = 'rectangle(20, 60, "solid", "red")';
    const RED_WIDE = 'rectangle(60, 20, "solid", "red")';
    const BLUE = 'square(20, "solid", "blue")';
    for (const [code, blue] of [
      [`beside_align("top", ${RED_TALL}, ${BLUE})`, 'x="20" y="0"'],
      [`beside_align("bottom", ${RED_TALL}, ${BLUE})`, 'x="20" y="40"'],
      [`beside(${RED_TALL}, ${BLUE})`, 'x="20" y="20"'],
      [`above_align("right", ${RED_WIDE}, ${BLUE})`, 'x="40" y="20"'],
      [`above_align("left", ${RED_WIDE}, ${BLUE})`, 'x="0" y="20"'],
      [`overlay_align("right", "bottom", ${RED_WIDE}, ${BLUE})`, 'x="40" y="0"'],
    ]) {
      const svg = imagesOf(py(callReplEval, [code, SK]))[0]?.svg ?? "";
      expect(svg.includes(`<rect ${blue} width="20" height="20" fill="blue"/>`), `${code}: the square at ${blue}: ${svg}`);
    }
    // An outline of a polygon is its pen just inside it: the corners moved in.
    const outline = imagesOf(py(callReplEval, ['triangle(40, "outline", "red")', SK]))[0]?.svg ?? "";
    expect(/<polygon points="20,1 39\.13,34\.14 0\.87,34\.14" fill="none" stroke="red"/.test(outline), `the pen inside the triangle: ${outline}`);
    console.log("    top, bottom, centre, left and right, and an outline inside its polygon");
  }

  console.log("\n[12] place_image and crop clip with distinct ids");
  {
    const code = `beside(crop(0, 0, 10, 10, square(50, "solid", "red")), place_image(square(30, "solid", "blue"), 5, 5, empty_scene(40, 40)))`;
    const img = imagesOf(py(callReplEval, [code, SK]))[0];
    const ids = [...new Set((img.svg.match(/id="pll[0-9a-f]+c\d+"/g) || []))];
    expect(ids.length === 2, `two clip regions should get distinct ids, got ${ids.length}`);
    expect(img.svg.includes("clip-path"), "clipping should be applied");
    // A crop of a crop is clipped to where the two overlap, and only there.
    const nested = imagesOf(py(callReplEval, ['crop(10, 10, 20, 20, crop(0, 0, 25, 25, circle(20, "solid", "red")))', SK]))[0];
    expect(/<clipPath id="[^"]+"><polygon points="0,15 0,0 15,0 15,15"\/><\/clipPath>/.test(nested?.svg ?? ""), `the overlap of two crops: ${nested?.svg}`);
  }

  console.log("\n[13] a bad alignment name is a friendly ValueError");
  {
    const result = py(callReplEval, [`beside_align("sideways", square(10, "solid", "red"))`, SK]);
    expect(result.ok === false, "an invalid place should fail");
    expect(result.error?.errorType === "ValueError", `expected ValueError, got ${result.error?.errorType}`);
    expect(
      /beside_align/.test(result.error?.message || ""),
      `the message should name the function, got ${result.error?.message}`,
    );
    console.log(`    ${result.error?.errorType}: ${result.error?.message}`);
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
    expect(result.ok === true, `ran: ${result.error?.message ?? ""}`);
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
      ['load_image("gopher://h/a.png")', "FileNotFoundError", 'no file called "gopher://h/a.png"'],
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
        result.ok === false && result.error?.errorType === kind &&
          (result.error?.message ?? "").includes(needle),
        `${kind}/${needle}, got ${result.error?.errorType}: ${result.error?.message}`,
      );
    }
    console.log("    five bad inputs, each named precisely");
  }

  console.log("\n[16] a non-colour or a misspelled mode is refused, not drawn");
  {
    // SVG ignores a paint value it cannot parse, so drawn, these would be
    // an invisible shape and no word said.
    for (const [code, needle] of [
      ['rectangle(30, 40, "solid", 50)', "`color` (the 4th argument) is the number 50, which is not a color"],
      ['rectangle(30, 40, "solid", "50")', 'the string "50", which is not a color'],
      ['circle(10, "solid", None)', "`color` (the 3rd argument) is None, which is not a color"],
      ['text("hi", 12, 7)', "`color` (the 3rd argument) is the number 7, which is not a color"],
      ["line(5, 5, {})", "is a dictionary, which is not a color"],
      ['circle(10, "solid", ("r", 0, 0))', "is ('r', 0, 0), which is not a color. Use a name"],
      ['circle(10, "solid", (300, 0, 0))', "is (300, 0, 0), which is not a color. Use a name"],
      ['circle(10, "solid", "rgb(300, 0, 0)")', 'is the string "rgb(300, 0, 0)", which is not a color'],
      ['circle(10, "solid", "hsl(0, 100, 50)")', 'is the string "hsl(0, 100, 50)", which is not a color'],
      ['circle(10, "sloid", "red")', '`mode` (the 2nd argument) should be "solid" or "outline"'],
      [
        'regular_polygon(10, 5, "filled", "red")',
        '`mode` (the 3rd argument) should be "solid" or "outline"',
      ],
    ]) {
      const result = py(callRunFile, [code, "color.py", SK]);
      expect(
        result.ok === false && result.error?.errorType === "ValueError" &&
          (result.error?.message ?? "").includes(needle),
        `${code} -> ${needle}, got ${result.error?.errorType}: ${result.error?.message}`,
      );
      // The message has to name the function the student called, not an
      // internal helper.
      expect(
        (result.error?.message ?? "").startsWith(code.split("(")[0] + "'s "),
        `${code} should be blamed on its own call: ${result.error?.message}`,
      );
    }
    console.log("    eleven bad colours and modes, each named by argument and position");

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
    expect(result.ok === true, `documented colours still work: ${result.error?.message ?? ""}`);
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
    expect(sizes.ok === true, `ran: ${sizes.error?.message ?? ""}`);
    const got = sizes.stdout.trim().split("\n");
    // 3: 40 wide, 40*sqrt(3)/2 tall. 4: a square. 6: 2R across,
    // 2R*sqrt(3)/2 tall. 8: 40*(1+sqrt(2)) each way.
    expect(got[0] === "3 40 35", `triangle: ${got[0]}`);
    expect(got[1] === "4 40 40", `square, not a diamond: ${got[1]}`);
    expect(got[2] === "6 80 70", `hexagon: ${got[2]}`);
    expect(got[3] === "8 97 97", `octagon: ${got[3]}`);

    // 80.00000000000001 from the cosines must not ceil to 81, which would
    // leave a blank column down one side of every such shape.
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

  console.log("\n[18] every argument is checked when the function is called");
  {
    // Before this, a wrong argument was accepted and only failed later,
    // inside the rendering code, as "'str' object has no attribute
    // 'width'" - after the broken picture had already been displayed.
    const RED = 'circle(5, "solid", "red")';
    for (const [code, kind, needle] of [
      // A value that is not an image, named by position.
      [`beside(${RED}, "austria")`, "TypeError", `beside's 2nd argument is the string "austria", not an image`],
      [`above(${RED}, 3)`, "TypeError", "above's 2nd argument is the number 3, not an image"],
      [`overlay(${RED}, None)`, "TypeError", "overlay's 2nd argument is None, not an image"],
      // The images in one list rather than one by one.
      [`beside([${RED}, ${RED}])`, "TypeError", "beside takes the images themselves, not a list of them"],
      // An aligned combiner counts past the alignment argument.
      [`beside_align("top", ${RED}, "x")`, "TypeError", "beside_align's 3rd argument is the string"],
      [`place_image(${RED}, 1, 2, "scene")`, "TypeError", "place_image's 4th argument is the string"],
      [`image_width("nope")`, "TypeError", "image_width's 1st argument is the string"],
      // Sizes.
      ['rectangle("20", 20, "solid", "red")', "TypeError", "rectangle's `width` (the 1st argument) must be a number"],
      ['rectangle(-20, 20, "solid", "red")', "ValueError", "rectangle's `width` (the 1st argument) cannot be negative, but it is -20"],
      [`scale(0, ${RED})`, "ValueError", "scale's `factor` (the 1st argument) has to be more than 0"],
      ['text(5, 20, "red")', "TypeError", "text's `value` (the 1st argument) must be a string"],
      ['regular_polygon(40, 2, "solid", "red")', "ValueError", "`sides` (the 2nd argument) cannot be less than 3"],
      // Arguments the other way round, which Python reports from deep
      // inside the arithmetic.
      [`rotate(${RED}, 45)`, "TypeError", "rotate takes the `angle` first, then the image: write rotate(45, image)"],
      [`scale(${RED}, 2)`, "TypeError", "scale takes the `factor` first, then the image: write scale(2, image)"],
      // `+` between images, which looks plausible and is not a thing.
      [`${RED} + ${RED}`, "TypeError", "Images cannot be joined with `+`"],
      // An image where a number, a mode or a colour belongs. These are the
      // messages that *describe* an image, and so the ones where an
      // internal class name would show.
      [`rectangle(${RED}, 20, "solid", "red")`, "TypeError", "`width` (the 1st argument) must be a number, but it is an image"],
      [`circle(5, ${RED}, "red")`, "ValueError", '`mode` (the 2nd argument) should be "solid" or "outline", but it is an image'],
      [`circle(5, "solid", ${RED})`, "ValueError", "`color` (the 3rd argument) is an image, which is not a color"],
    ]) {
      const result = py(callRunFile, [code, "args.py", SK]);
      const message = result.error?.message ?? "";
      expect(
        result.ok === false && result.error?.errorType === kind && message.includes(needle),
        `${code} -> ${kind} "${needle}", got ${result.error?.errorType}: ${message}`,
      );
      // An internal class name sends a student looking for code they did
      // not write.
      expect(
        !/_Rectangle|_Circle|_Frame|_Beside|_Above|_Overlay|_Scale|_Rotate|_Text|_Line|_Crop|_Flip|_PlaceImage|_LayeredXY/.test(message),
        `${code} must not name an internal class: ${message}`,
      );
    }
    console.log("    eighteen wrong arguments caught at the call, none naming an internal class");

    // And the shapes that are legitimately odd still work.
    for (const code of [
      'print(image_width(rectangle(0, 0, "solid", "red")))',
      'print(image_width(line(-5, -5, "red")))',
      `print(image_width(rotate(45, ${RED})))`,
      `print(image_width(overlay_xy(${RED}, -3, -3, ${RED})))`,
      `print(image_width(beside()))`,
    ]) {
      const result = py(callRunFile, [code, "fine.py", SK]);
      expect(result.ok === true, `${code} should still work: ${result.error?.message ?? ""}`);
    }
    console.log("    zero sizes, negative offsets and no arguments at all still fine");
  }

  console.log("\n[19] a reactor that is never started says so");
  {
    // A reactor is a value. One that is built and never started does
    // nothing at all, and said nothing at all about why - which looks
    // exactly like a program that is broken somewhere else.
    const draw = 'def draw(n):\n    return circle(5, "solid", "red")\n\n\n';
    const idle = py(callRunFile, [`${draw}r = reactor(init=0, to_draw=draw)\nprint("built")\n`, "rx.py", SK]);
    expect(idle.ok === true, `the program itself is fine: ${idle.error?.message ?? ""}`);
    expect(idle.stdout === "built\n", `and runs to the end: ${JSON.stringify(idle.stdout)}`);
    expect(
      /note: a reactor was made but never started/.test(idle.stderr ?? ""),
      `the note should say what is missing: ${JSON.stringify(idle.stderr)}`,
    );
    expect(
      /\.interact\(\)/.test(idle.stderr ?? ""),
      `and name the fix: ${JSON.stringify(idle.stderr)}`,
    );

    // Started, so nothing to say.
    const started = py(callRunFile, [`${draw}reactor(init=0, to_draw=draw).interact()\n`, "rx2.py", SK]);
    expect(started.ok === true, `a started reactor runs: ${started.error?.message ?? ""}`);
    expect(
      !/never started/.test(started.stderr ?? ""),
      `and gets no note: ${JSON.stringify(started.stderr)}`,
    );

    // And the note is about this run only, not every reactor ever built.
    const again = py(callRunFile, [`${draw}reactor(init=0, to_draw=draw).interact()\n`, "rx3.py", SK]);
    expect(
      !/never started/.test(again.stderr ?? ""),
      `the last run's reactors are forgotten: ${JSON.stringify(again.stderr)}`,
    );
    // Used without being shown: tested with simulate_trace, or by the file's tests.
    const traced = py(callRunFile, [`${draw}r = reactor(init=0, to_draw=draw, on_tick=lambda n: n + 1)\nprint(r.simulate_trace(3).get_trace())\n`, "rx4.py", SK]);
    expect(traced.stdout === "[0, 1, 2, 3]\n", `its trace, oldest first: ${JSON.stringify(traced.stdout)}`);
    expect(!/never started/.test(traced.stderr ?? ""), `a reactor tested is used: ${JSON.stringify(traced.stderr)}`);
    const tested = py(callRunFile, [
      `${draw}r = reactor(init=0, to_draw=draw, on_tick=lambda n: n + 1)\n\ndef test_ticks():\n    assert r.tick().get_value() == 1\n`,
      "rx5.py", SK, "raw", true,
    ]);
    expect(tested.tests?.passed === 1, `its test runs: ${JSON.stringify(tested.tests)}`);
    expect(!/never started/.test(tested.stderr ?? ""), `and is what used it: ${JSON.stringify(tested.stderr)}`);
    // A rate the clock cannot keep, which JSON could not carry to the host either.
    for (const rate of ['float("nan")', 'float("inf")', "0"]) {
      const bad = py(callRunFile, [`${draw}reactor(init=0, to_draw=draw, tick_rate=${rate}).interact()\n`, "rate.py", SK]);
      expect(
        bad.ok === false && /`tick_rate` must be a number of seconds above 0/.test(bad.error?.message ?? ""),
        `tick_rate=${rate} is refused: ${bad.error?.message}`,
      );
    }
    // And a NaN that reached a result anyway is refused before it crosses.
    pyodide.runPython("_pll_nan_result = lambda: {'tick_rate': float('nan')}");
    let crossed = null;
    try {
      crossed = pyodide.runPython('_pll_call("_pll_nan_result", "[]")');
    } catch (err) {
      crossed = String(err.message);
    }
    pyodide.runPython("del _pll_nan_result");
    expect(/Out of range float values are not JSON compliant/.test(crossed), `a NaN does not cross: ${crossed}`);
    console.log("    noted when idle, silent when started or tested, and reset each run");
  }

  console.log("\n[19b] a stopped world takes no more events, and a step that cannot send changes nothing");
  {
    const step = pyodide.globals.get("_pll_reactor_step");
    const seek = pyodide.globals.get("_pll_reactor_seek");
    const idOf = (result) => result.displays.find((d) => d.kind === "reactor")?.id;
    const draw = 'def draw(n):\n    return circle(5, "solid", "red")\n\n\n';
    const stops = py(callRunFile, [
      `${draw}reactor(init=0, to_draw=draw, on_tick=lambda n: n + 1, on_receive=lambda n, m: n + 100, stop_when=lambda n: n >= 1).interact()\n`,
      "stops.py", SK,
    ]);
    const sid = idOf(stops);
    const first = py(step, [sid, '{"kind": "tick"}']);
    expect(first.stopped === true && first.valueRepr === "1", `it stops at 1: ${JSON.stringify(first)}`);
    for (const event of ['{"kind": "tick"}', '{"kind": "receive", "message": 5}']) {
      const after = py(step, [sid, event]);
      expect(after.valueRepr === "1" && after.length === first.length && after.messages.length === 0,
        `${event} changes nothing: ${JSON.stringify(after)}`);
    }

    // A message a handler sends comes back with the step that sent it.
    const sending = py(callRunFile, [
      `${draw}reactor(init=0, to_draw=draw, on_key=lambda n, k: package(n + 1, {"hi": k})).interact()\n`,
      "sending.py", SK,
    ]);
    const sent = py(step, [idOf(sending), '{"kind": "key", "key": "a"}']);
    expect(sent.kind === "frame" && JSON.stringify(sent.messages.map((m) => JSON.parse(m))) === '[{"hi":"a"}]',
      `the message goes with the step: ${JSON.stringify(sent.messages)}`);

    const sends = py(callRunFile, [
      `${draw}reactor(init=0, to_draw=draw, on_key=lambda n, k: package(n + 1, object())).interact()\n`,
      "sends.py", SK,
    ]);
    const kid = idOf(sends);
    const refused = py(step, [kid, '{"kind": "key", "key": "a"}']);
    expect(refused.kind === "raised" && refused.error?.errorType === "TypeError" && /package\(\.\.\.\) can only send/.test(refused.error?.message),
      `the message is refused: ${JSON.stringify(refused.error?.message)}`);
    const where = py(seek, [kid, 0]);
    expect(where.length === 1 && where.valueRepr === "0", `and the reactor is where it was: ${JSON.stringify(where)}`);
    step.destroy?.();
    seek.destroy?.();
    console.log("    a stopped world stays put; a message that cannot be sent leaves no frame");
  }

  console.log("\n[20] a misspelled colour is refused, with the name it meant");
  {
    // SVG ignores a paint value it cannot parse, so "bleu" drew an
    // invisible shape and said nothing. Names are checked against the CSS
    // colours, which are exactly the names SVG accepts.
    for (const [code, needle] of [
      ['circle(5, "solid", "bleu")', 'Did you mean "blue"?'],
      ['circle(5, "solid", "rd")', 'Did you mean "red"?'],
      ['circle(5, "solid", "purpel")', 'Did you mean "purple"?'],
      ['rectangle(5, 5, "solid", "yelow")', 'Did you mean "yellow"?'],
      // Nothing like a colour: no guess, just the forms that work.
      ['circle(5, "solid", "zzzzzzz")', 'Use a name like "red", a hex code'],
    ]) {
      const result = py(callRunFile, [code, "badcolor.py", SK]);
      expect(
        result.ok === false && result.error?.errorType === "ValueError" &&
          (result.error?.message ?? "").includes(needle),
        `${code} -> "${needle}", got ${result.error?.errorType}: ${result.error?.message}`,
      );
      // The list of names is PLL's: Python itself knows no colours at all.
      expect(
        (result.error?.message ?? "").includes("which is not a color name PLL knows."),
        `${code} should say whose names these are, got ${result.error?.message}`,
      );
    }

    // Every name in the list has to be accepted, or a colour that works
    // today stops working - which is worse than the typo this catches.
    // Read from the library's own globals rather than a session's: the
    // list is private, as it should be.
    const [count, rejected] = pyodide
      .runPython(
        [
          "bad = []",
          "for name in sorted(_PLL_CSS_COLORS):",
          "    try:",
          '        circle(1, "solid", name)',
          "    except Exception:",
          "        bad.append(name)",
          "[len(_PLL_CSS_COLORS), bad]",
        ].join("\n"),
      )
      .toJs();
    // 148 is the whole of CSS Color 4. Asserted so a name dropped from the
    // list fails here rather than refusing a colour a student used.
    expect(count === 148, `expected the whole CSS list, got ${count} names`);
    expect(rejected.length === 0, `these are in the list and refused: ${rejected.join(", ")}`);

    // Case does not matter in CSS, and the keywords are not names.
    const others = py(callRunFile, [
      [
        'circle(5, "solid", "Red")',
        'circle(5, "solid", "DARKSLATEGREY")',
        'circle(5, "solid", "transparent")',
        'circle(5, "solid", "rebeccapurple")',
      ].join("\n"),
      "casecolor.py",
      SK,
    ]);
    expect(others.ok === true, `case and keywords still work: ${others.error?.message ?? ""}`);
    console.log("    four misspellings named, all 148 CSS colours accepted");
  }

  console.log("\n[22] images are == when they draw alike");
  {
    const lines = [
      "from dataclasses import dataclass",
      "def dot(r):",
      '    return circle(r, "solid", "red")',
      "@dataclass",
      "class Badge:",
      "    pic: Image",
      "    n: int",
      "RED = square(10, 'solid', 'red')",
      "BLUE = square(10, 'solid', 'blue')",
      "checks = [",
      '    dot(3) == circle(3, "solid", "red"),',
      '    Badge(dot(3), 1) == Badge(circle(3, "solid", "red"), 1),',
      // The same picture built two ways: painting order counts only where shapes overlap.
      "    beside(RED, BLUE) == overlay_xy(BLUE, -10, 0, RED),",
      '    rotate(90, rectangle(10, 20, "solid", "red")) == rectangle(20, 10, "solid", "red"),',
      '    rotate(90, ellipse(10, 20, "solid", "red")) == ellipse(20, 10, "solid", "red"),',
      '    circle(5, "solid", "red") == circle(5, "solid", (255, 0, 0)) == circle(5, "solid", "#f00") == circle(5, "solid", "rgb(255, 0, 0)"),',
      '    place_image(RED, 20, 20, empty_scene(40, 40)) == overlay(RED, empty_scene(40, 40)),',
      "    scale(2, RED) == square(20, 'solid', 'red'),",
      "]",
      "differ = [",
      '    circle(5, "solid", "red") == circle(5, "outline", "red"),',
      '    circle(5, "solid", "red") == circle(6, "solid", "red"),',
      "    beside(RED, BLUE) == beside(BLUE, RED),",
      // Overlapping, so which is on top is part of what is drawn.
      "    overlay(RED, scale(2, BLUE)) == overlay(scale(2, BLUE), RED),",
      '    text("a", 10, "red") == text("b", 10, "red"),',
      "    RED == 3,",
      "]",
      'print(all(checks), [i for i, c in enumerate(checks) if not c])',
      'print(any(differ), [i for i, c in enumerate(differ) if c])',
      // Equal images hash alike, so they work in sets and as dictionary keys.
      'print(len({dot(3), circle(3, "solid", (255, 0, 0)), square(3, "solid", "red")}))',
    ];
    const result = py(callRunFile, [lines.join("\n"), "eq.py", SK]);
    expect(result.ok === true, `ran: ${result.error?.message ?? ""}`);
    const out = (result.stdout ?? "").trim().split("\n");
    expect(out[0] === "True []", `drawn alike, equal: ${out[0]}`);
    expect(out[1] === "False []", `drawn differently, not: ${out[1]}`);
    expect(out[2] === "2", `hashes agree with ==: ${out[2]}`);

    // And so a test of a function that draws passes.
    const tested = py(callRunFile, [
      'def dot(r: int) -> Image:\n    return circle(r, "solid", "red")\n\ndef test_dot():\n    assert dot(3) == circle(3, "solid", "red")\n',
      "eqtest.py", SK, "beginner", true,
    ]);
    expect(tested.tests?.passed === 1 && tested.tests?.failed === 0, `the test passes: ${JSON.stringify(tested.tests)}`);
    console.log("    alike is equal, whichever way it was built; different is not");
  }

  console.log("\n[23] a picture built in a long loop draws, quickly");
  {
    const code = [
      "import time",
      "start = time.time()",
      "row = empty_image",
      "for i in range(3000):",
      '    row = beside(row, circle(2, "solid", "blue"))',
      "scene = empty_scene(400, 400)",
      "for i in range(2000):",
      '    scene = place_image(circle(2, "solid", "blue"), (i * 7) % 400, (i * 13) % 400, scene)',
      "spun = triangle(40, 'solid', 'red')",
      "for i in range(36):",
      "    spun = rotate(10, spun)",
      "print(image_width(row), image_width(spun), image_height(spun))",
      "print(row.to_svg().count('<circle'), scene.to_svg().count('<circle'), '<g transform' in scene.to_svg())",
      "print(scene == scene, time.time() - start < 20)",
      // An image never changes, so a copy is the image - and no recursion.
      "import copy",
      "print(copy.deepcopy(row) is row)",
      "row",
    ].join("\n");
    const result = py(callRunFile, [code, "deep.py", SK]);
    expect(result.ok === true, `no RecursionError: ${result.error?.errorType}: ${result.error?.message ?? ""}`);
    const out = (result.stdout ?? "").trim().split("\n");
    // Thirty-six turns of ten degrees come back to where they started, at the same size.
    expect(out[0] === "12000 40 35", `sizes: ${out[0]}`);
    // Flat: one element per shape, nothing nested.
    expect(out[1] === "3000 2000 False", `every shape drawn, none nested: ${out[1]}`);
    expect(out[2] === "True True", `compared and in time: ${out[2]}`);
    expect(out[3] === "True", `copied as itself: ${out[3]}`);
    expect(imagesOf(result).length === 1, "and shown");

    // Freed a level at a time: freed the usual way, a picture this deep
    // ran out of stack, which ended Python itself.
    const freed = py(callRunFile, [
      [
        "row = empty_image",
        "for i in range(30000):",
        '    row = beside(row, circle(1, "solid", "blue"))',
        "scene = empty_scene(40, 40)",
        "for i in range(30000):",
        '    scene = place_image(circle(1, "solid", "red"), i % 40, i % 30, scene)',
        "del row, scene",
        'print("freed")',
      ].join("\n"),
      "freed.py", SK,
    ]);
    expect(freed.ok === true && freed.stdout === "freed\n", `a deep picture is freed: ${freed.error?.message ?? freed.stdout}`);
    console.log("    3000 besides, 2000 place_images and 36 nested rotations; 30000 freed");
  }

  console.log("\n[24] the geometry is 2htdp's");
  {
    const code = [
      "def size(i):",
      "    return (image_width(i), image_height(i))",
      // rotate's box is the turned shape's own.
      'print(size(rotate(45, circle(20, "solid", "red"))), size(rotate(45, square(20, "solid", "red"))))',
      'print(size(rotate(90, beside(circle(10, "solid", "red"), circle(10, "solid", "red")))))',
      // A crop's own edges turn with it, as 2htdp's do.
      'print(size(rotate(45, crop(0, 0, 10, 10, circle(100, "solid", "red")))))',
      // A 1-pixel pen inside the shape.
      'print(circle(20, "outline", "red").to_svg())',
      'print(square(20, "outline", "black").to_svg())',
      'print(line(30, 0, "red").to_svg())',
      // The right angle at the bottom left.
      'print(right_triangle(40, 30, "solid", "blue").to_svg())',
      // A true star: the inner points where the lines between every 2nd corner cross.
      "import re",
      'pts = [tuple(map(float, p.split(","))) for p in re.search(r\'points="([^"]+)"\', star(40, "solid", "gold").to_svg()).group(1).split()]',
      "import math",
      "centre = (pts[0][0], pts[0][1] + 40 / (2 * math.sin(math.pi / 5)))",
      "print(round(math.dist(pts[1], centre) / math.dist(pts[0], centre), 3))",
    ].join("\n");
    const result = py(callRunFile, [code, "geom.py", SK]);
    expect(result.ok === true, `ran: ${result.error?.message ?? ""}`);
    const out = (result.stdout ?? "").trim().split("\n");
    expect(out[0] === "(40, 40) (29, 29)", `a circle turned is as wide: ${out[0]}`);
    expect(out[1] === "(20, 40)", `two circles turned, measured by the circles: ${out[1]}`);
    expect(out[2] === "(15, 15)", `a crop's box turns with it: ${out[2]}`);
    expect(/<circle cx="20" cy="20" r="19.5" fill="none" stroke="red" stroke-width="1"/.test(out[3]), `circle outline inside: ${out[3]}`);
    expect(/<rect x="0.5" y="0.5" width="19" height="19" fill="none" stroke="black" stroke-width="1"/.test(out[4]), `square outline inside: ${out[4]}`);
    expect(/<line x1="0" y1="0.5" x2="30" y2="0.5" stroke="red" stroke-width="1"/.test(out[5]), `a line's pen is 1 pixel, in its box: ${out[5]}`);
    expect(/points="0,0 0,30 40,30"/.test(out[6]), `right angle bottom-left: ${out[6]}`);
    expect(out[7] === "0.382", `the pentagram's inner radius: ${out[7]}`);
    console.log("    rotate measures shapes, pens are 1 pixel inside, stars and right triangles are true");
  }

  console.log("\n[25] text is measured exactly, in a monospace font, spaces kept");
  {
    const code = [
      'for s in ("WWW", "iii", "a   b", ""):',
      '    t = text(s, 20, "black")',
      "    print(repr(s), t.width, t.height)",
      'print(text("a   b", 20, "black").to_svg())',
      // Wide characters take two cells.
      'print(text("日本", 10, "black").width)',
    ].join("\n");
    const result = py(callRunFile, [code, "text.py", SK]);
    expect(result.ok === true, `ran: ${result.error?.message ?? ""}`);
    const out = (result.stdout ?? "").trim().split("\n");
    expect(out[0] === "'WWW' 36.0 24.0" && out[1] === "'iii' 36.0 24.0", `every letter one width: ${out.slice(0, 2)}`);
    expect(out[2] === "'a   b' 60.0 24.0" && out[3] === "'' 0.0 24.0", `spaces count, nothing is nothing: ${out.slice(2, 4)}`);
    expect(
      /font-family="monospace"/.test(out[4]) && /textLength="60"/.test(out[4]) && /xml:space="preserve"/.test(out[4]) && />a {3}b</.test(out[4]),
      `monospace, held to its width, spaces kept: ${out[4]}`,
    );
    expect(out[5] === "24.0", `wide characters: ${out[5]}`);
    console.log("    every character one cell, spaces kept, wide ones two");
  }

  console.log("\n[26] a colour is read, never copied into the SVG");
  {
    const code = [
      'for c in ["red\\"/><script>alert(1)</script><x a=\\"", "rgb(banana)", "rgb(1,2,3);fill:url(x)", "red; } * { display: none"]:',
      "    try:",
      '        circle(5, "solid", c)',
      '        print("drawn", c)',
      "    except ValueError as e:",
      '        print("refused")',
      "import re",
      'svg = beside(circle(5, "solid", "rgba(10, 20, 30, 0.5)"), circle(5, "solid", "hsl(120, 100%, 25%)"), circle(5, "solid", (1, 2, 3, 0.25)), circle(5, "outline", "#ABC"), text("x", 9, "Navy")).to_svg()',
      'print(sorted(set(re.findall(r\'(?:fill|stroke)="([^"]*)"\', svg))))',
      "col = [255, 0, 0]",
      'pic = circle(5, "solid", col)',
      "col[0] = 0",
      'print(pic == circle(5, "solid", "red"))',
      // The fourth number: a whole number from 0 to 255, or a fraction.
      'print(circle(5, "solid", (255, 0, 0, 128)) == circle(5, "solid", (255, 0, 0, 128 / 255)), circle(5, "solid", (255, 0, 0, 1)) == circle(5, "solid", (255, 0, 0, 1.0)))',
      // In text, as in CSS, every opacity is a fraction.
      'print(circle(5, "solid", "rgba(255, 0, 0, 1)") == circle(5, "solid", "red"), circle(5, "solid", "hsla(0, 100%, 50%, 0.5)") == circle(5, "solid", (255, 0, 0, 0.5)))',
    ].join("\n");
    const result = py(callRunFile, [code, "paint.py", SK]);
    expect(result.ok === true, `ran: ${result.error?.message ?? ""}`);
    const out = (result.stdout ?? "").trim().split("\n");
    expect(out.slice(0, 4).every((l) => l === "refused"), `markup refused: ${out.slice(0, 4)}`);
    expect(
      out[4] === "['#008000', '#010203', '#0a141e', '#aabbcc', 'navy', 'none']",
      `only PLL's own spellings reach the SVG: ${out[4]}`,
    );
    expect(out[5] === "True", `a list changed later changes nothing drawn: ${out[5]}`);
    expect(out[6] === "True False", `1 is out of 255, 1.0 is solid: ${out[6]}`);
    expect(out[7] === "True True", `rgba() and hsla() take a fraction: ${out[7]}`);
    console.log("    markup refused, colours rewritten, lists copied, opacity by type");
  }

  console.log("\n[27] a number that cannot be drawn is refused in PLL's words");
  {
    await pyodide.loadPackage("numpy");
    for (const [code, kind, needle] of [
      ['circle(float("nan"), "solid", "red")', "ValueError", "circle's `radius` (the 1st argument) has to be a finite number, but it is nan"],
      ['rectangle(-float("inf"), 3, "solid", "red")', "ValueError", "rectangle's `width` (the 1st argument) has to be a finite number, but it is -inf"],
      ['circle(10**400, "solid", "red")', "ValueError", "`radius` (the 1st argument) has to be a finite number, but it is inf"],
      ['regular_polygon(20, 4.0, "solid", "red")', "TypeError", "`sides` (the 2nd argument) has to be a whole number, but it is 4.0: write 4"],
      ['star_polygon(20, 2, 1, "solid", "red")', "ValueError", "`points_count` (the 2nd argument) cannot be less than 3, but it is 2"],
      // Every 3rd corner makes a star only with 7 or more.
      ['star_polygon(20, 5, 3, "solid", "red")', "ValueError", "`points_count` (the 2nd argument) cannot be less than 7, but it is 5"],
      ['star_polygon(20, 7, 0, "solid", "red")', "ValueError", "`step` (the 3rd argument) cannot be less than 1, but it is 0"],
      ['star(20, "solidd", "red")', "ValueError", "star's `mode` (the 2nd argument)"],
      ['beside_align(circle(5, "solid", "red"), circle(5, "solid", "red"))', "ValueError", 'beside_align\'s `y_place` (the 1st argument) should be "top", "center" or "bottom", but it is an image'],
      ['beside_align("cener", circle(5, "solid", "red"))', "ValueError", "`y_place` (the 1st argument) should be \"top\", \"center\" or \"bottom\", but it is the string \"cener\". Did you mean \"center\"?"],
      ["underlay()", "TypeError", "underlay needs at least one image"],
      ['circle(5, "solid", "light blue")', "ValueError", 'Did you mean "lightblue"?'],
      ['right_triangle(10, 10, "solid", "bleu")', "ValueError", "right_triangle's `color` (the 4th argument)"],
      ["Image()", "TypeError", "Image is the type of pictures, not a way to make one"],
    ]) {
      const result = py(callRunFile, [code, "nums.py", SK]);
      const message = result.error?.message ?? "";
      expect(result.ok === false && result.error?.errorType === kind && message.includes(needle), `${code} -> ${kind} "${needle}", got ${result.error?.errorType}: ${message}`);
    }
    const numpy = py(callRunFile, [
      'import numpy as np\nprint(image_width(circle(np.int64(5), "solid", (np.int64(1), 2, 3))), image_width(rotate(np.float64(90), square(np.int32(4), "solid", "red"))))\nimport pydoc\nprint(pydoc.render_doc(circle).splitlines()[0])',
      "np.py", SK,
    ]);
    expect(numpy.stdout === "10 4\nPython Library Documentation: function circle in module pll.image\n", `numpy's numbers are numbers, and help names pll.image: ${JSON.stringify(numpy.stdout)} ${numpy.error?.message ?? ""}`);
    console.log("    NaN, infinity, huge, 4.0 sides, bad stars, alignment, names - all PLL's words");
  }

  console.log("\n[28] load_image measures an SVG by its own tag, and embeds a picture once");
  {
    const code = [
      "def write(name, text):",
      "    with open(name, 'w') as f:",
      "        f.write(text)",
      // A child's width, a stroke-width and a comment do not count; units do.
      "write('units.svg', '<?xml version=\"1.0\"?><!-- <svg width=\"999\" height=\"999\"> --><svg xmlns=\"http://www.w3.org/2000/svg\" stroke-width=\"7\" width=\"1in\" height=\"36pt\"><rect width=\"500\" height=\"500\"/></svg>')",
      "write('box.svg', '<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 30 20\"><rect width=\"300\"/></svg>')",
      "write('half.svg', '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"60\" viewBox=\"0 0 30 20\"/>')",
      "for name in ('units.svg', 'box.svg', 'half.svg'):",
      "    pic = load_image(name)",
      "    print(image_width(pic), image_height(pic))",
      "pic = load_image('box.svg')",
      "svg = beside(pic, pic, rotate(90, pic)).to_svg()",
      "print(svg.count('base64,'), svg.count('<use '))",
      "with open('big.png', 'wb') as f:",
      "    f.write(b'\\x89PNG\\r\\n\\x1a\\n' + bytes(3 * 1024 * 1024))",
      "try:",
      "    load_image('big.png')",
      "except ValueError as e:",
      "    print(e)",
    ].join("\n");
    const result = py(callRunFile, [code, "svgsize.py", SK]);
    expect(result.ok === true, `ran: ${result.error?.message ?? ""}`);
    const out = (result.stdout ?? "").trim().split("\n");
    expect(out[0] === "96 48", `width and height in units: ${out[0]}`);
    expect(out[1] === "30 20", `the viewBox: ${out[1]}`);
    expect(out[2] === "60 40", `one side, the other from the viewBox: ${out[2]}`);
    expect(out[3] === "1 3", `embedded once, drawn three times: ${out[3]}`);
    expect(out[4] === "load_image reads at most 2 MB, and 'big.png' is 3.0 MB.", `a size limit: ${out[4]}`);
    console.log("    sized by the root tag in pixels; one copy of the bytes; 2 MB");
  }

  console.log("\n[29] matplotlib draws with PLL's backend: plt.show() and a figure at top level are pictures");
  {
    await pyodide.loadPackage("matplotlib");
    const code = [
      "import matplotlib.pyplot as plt",
      "plt.plot([1, 2, 3], [4, 1, 9])",
      'plt.title("hello")',
      "plt.show()",
      "fig, ax = plt.subplots()",
      'ax.bar(["a", "b"], [3, 5])',
      "fig",
      'print("done")',
    ].join("\n");
    const result = py(callRunFile, [code, "plot.py", SK, "beginner"]);
    expect(result.ok === true, `ran: ${result.error?.errorType}: ${result.error?.message ?? ""}`);
    const images = imagesOf(result);
    // One for plt.show(), one for `fig`; plt's own return values are not printed.
    expect(images.length === 2, `two pictures: ${images.length}`);
    // A figure shown at top level is closed, so a show() after it does not repeat it.
    const once = py(callRunFile, ["import matplotlib.pyplot as plt\nfig = plt.figure()\nfig\nplt.show()\n", "once.py", SK, "beginner"]);
    expect(imagesOf(once).length === 1, `shown once: ${imagesOf(once).length} ${once.error?.message ?? ""}`);
    expect(images.every((i) => i.width === 640 && i.height === 480 && i.svg.includes("data:image/png;base64,")), "each a 640x480 PNG");
    expect(result.stdout === "done\n", `nothing of matplotlib's printed: ${JSON.stringify(result.stdout)}`);
    // At raw, as in Python, a value at top level is not shown - but plt.show() is a call.
    const raw = py(callRunFile, ["import matplotlib.pyplot as plt\nfig = plt.figure()\nfig\nplt.plot([1], [1])\nplt.show()\n", "raw.py", SK, "raw"]);
    expect(raw.ok === true && imagesOf(raw).length === 1, `raw: show() only: ${imagesOf(raw).length} ${raw.error?.message ?? ""}`);
    console.log("    show() and a top-level figure, each once, as a PNG");
  }

  console.log("\n[30] load_image reads JPEG, GIF and WebP, sized from their headers");
  {
    await pyodide.loadPackage("pillow");
    const code = [
      "from PIL import Image as Pil",
      // A see-through lossy WebP is the extended kind, VP8X.
      "kinds = [('jpeg', 'RGB', {}), ('jpeg', 'RGB', {'progressive': True}), ('gif', 'RGB', {}), ('webp', 'RGB', {}), ('webp', 'RGB', {'lossless': True}), ('webp', 'RGBA', {})]",
      "for kind, mode, how in kinds:",
      "    Pil.new(mode, (123, 45), (200, 10, 10, 128)[:len(mode)]).save('pic.' + kind, kind, **how)",
      "    with open('pic.' + kind, 'rb') as f:",
      "        head = f.read(16)",
      "    pic = load_image('pic.' + kind)",
      "    print(kind, head[12:16] if kind == 'webp' else '', image_width(pic), image_height(pic), ('data:image/%s;base64,' % kind) in pic.to_svg())",
    ].join("\n");
    const result = py(callRunFile, [code, "formats.py", SK]);
    expect(result.ok === true, `ran: ${result.error?.errorType}: ${result.error?.message ?? ""}`);
    expect(
      result.stdout ===
        [
          "jpeg  123 45 True", "jpeg  123 45 True", "gif  123 45 True",
          "webp b'VP8 ' 123 45 True", "webp b'VP8L' 123 45 True", "webp b'VP8X' 123 45 True", "",
        ].join("\n"),
      `each kind measured and embedded as itself: ${JSON.stringify(result.stdout)}`,
    );
    console.log("    baseline and progressive JPEG, GIF, and WebP in all three of its forms");
  }

  console.log("\n[21] the prompt says a compile warning once too");
  {
    // The REPL compiles the statements and the last expression separately,
    // and at a checked level validates the instrumentation first - so a
    // warning came out more than once there as well.
    const replOut = py(callReplEval, ["def f():\n    return 3(4)\n", SK]);
    const said = ((replOut.stderr ?? "").match(/warning: line 2:/g) ?? []).length;
    expect(said === 1, `the prompt says it once, got ${said}: ${JSON.stringify(replOut.stderr)}`);

    // And at the prompt as in a file, an error it predicts is not repeated.
    const failing = py(callReplEval, ["3(4)\n", SK]);
    expect(failing.ok === false, "calling a number fails");
    expect(
      !/warning:/.test(failing.stderr ?? ""),
      `no warning beside the error it predicted: ${JSON.stringify(failing.stderr)}`,
    );
    console.log("    once at the prompt, and not beside the error it predicted");
  }

  console.log("\n[31] print shows a picture or a table as the top level does, at the student levels");
  {
    const kinds = (result) => (result.displays ?? []).map((d) => (d.kind === "stdout" ? `text:${JSON.stringify(d.text)}` : d.kind));
    const SETUP = 'img = circle(10, "solid", "red")\nt = table(["a"], [[1], [2]])\n';
    // From inside a function, which a value on a line of its own cannot do.
    const inside = py(callRunFile, [`${SETUP}def show():\n    print(img)\n    print(t)\n\nshow()\n`, "pr.py", "print:1", "beginner"]);
    expect(kinds(inside).join(" ") === "image table", `inside a function: ${kinds(inside).join(" ")}`);
    // A block: the text before it ends its line, and none is left after it.
    const mixed = py(callRunFile, [`${SETUP}print("Area:", img)\nprint(img, "after")\nprint(1, 2)\n`, "pr.py", "print:2", "advanced"]);
    expect(
      kinds(mixed).join(" ") === 'text:"Area:" text:"\\n" image image text:"after" text:"\\n" text:"1" text:" " text:"2" text:"\\n"',
      `with text: ${kinds(mixed).join(" ")}`,
    );
    // Python's `print` wherever it has only text to go to, and at raw.
    const elsewhere = py(callRunFile, [`import io\n${SETUP}buffer = io.StringIO()\nprint(img, file=buffer)\nprint(buffer.getvalue().strip())\n`, "pr.py", "print:3", "beginner"]);
    expect(elsewhere.stdout === "<Image 20x20>\n" && imagesOf(elsewhere).length === 0, `to a file: ${JSON.stringify(elsewhere.stdout)}`);
    const redirected = py(callRunFile, [`import contextlib, io\n${SETUP}with contextlib.redirect_stdout(io.StringIO()) as caught:\n    print(img)\nprint(caught.getvalue().strip())\n`, "pr.py", "print:6", "beginner"]);
    expect(redirected.stdout === "<Image 20x20>\n" && imagesOf(redirected).length === 0, `output redirected: ${JSON.stringify(redirected.stdout)}`);
    const raw = py(callRunFile, [`${SETUP}print(img)\n`, "pr.py", "print:4", "raw"]);
    expect(raw.stdout === "<Image 20x20>\n" && imagesOf(raw).length === 0, `raw is Python: ${JSON.stringify(raw.stdout)}`);
    // And at a prompt line.
    py(callRunFile, [SETUP, "pr.py", "print:5", "beginner"]);
    const prompt = py(callReplEval, ["print(img)", "print:5", "beginner"]);
    expect(imagesOf(prompt).length === 1 && prompt.stdout === "", `a prompt line: ${JSON.stringify(prompt.stdout)}`);
    console.log("    a function's print shows them; text around them stays in its lines; raw and a file get text");
  }

  callRunFile.destroy?.();
  callReplEval.destroy?.();

  if (!passed()) {
    console.log("\nFAILED");
    process.exit(1);
  }
  console.log("\nALL IMAGE SMOKE TESTS PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
