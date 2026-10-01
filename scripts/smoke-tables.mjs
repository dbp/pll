#!/usr/bin/env node
/**
 * Smoke test for the PLL table library.
 *
 * Boots Pyodide in Node, loads bootstrap + image lib + table lib + the
 * "register exports into the per-session template" install snippet, then
 * runs each scenario through `_pll_run_file` / `_pll_repl_eval`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { loadPyodide } from "pyodide";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

function readText(rel) {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

let ok = true;
function expect(cond, msg) {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    ok = false;
  }
}

const SK = "test:tables";

async function main() {
  const indexURL = resolve(ROOT, "node_modules", "pyodide");
  const pyodide = await loadPyodide({ indexURL });
  pyodide.runPython(readText("src/common/pyodideBootstrap.py"));
  pyodide.runPython(readText("src/common/imageLib.py"));
  pyodide.runPython(readText("src/common/tableLib.py"));
  // Install image + table exports into the per-session template, mirroring
  // what PYODIDE_INSTALL_PY does in the runtime.
  pyodide.runPython(`
for _name in PLL_IMAGE_EXPORTS:
    _pll_initial_globals[_name] = globals()[_name]
for _name in PLL_TABLE_EXPORTS:
    _pll_initial_globals[_name] = globals()[_name]
del _name
`);

  const callRunFile = pyodide.globals.get("_pll_run_file");
  const callReplEval = pyodide.globals.get("_pll_repl_eval");

  const py = (fn, ...args) => {
    const proxy = fn(...args);
    const obj = proxy.toJs({ dict_converter: Object.fromEntries });
    proxy.destroy?.();
    return obj;
  };

  console.log("\n[1] table() + auto-display + inspection");
  {
    const result = py(
      callRunFile,
      `t = table(["name", "age"], [["Alice", 30], ["Bob", 25]])\nt`,
      "tables_smoke.py",
      SK,
    );
    expect(result.ok === true, "ok=true; stderr=" + result.stderr);
    expect(
      Array.isArray(result.displays) && result.displays.length === 1,
      "1 display emission",
    );
    const d = result.displays[0];
    expect(d.type === "table", "display.type === 'table'");
    expect(
      Array.isArray(d.columns) && d.columns[0] === "name" && d.columns[1] === "age",
      "columns are name, age",
    );
    expect(d.row_count === 2, "row_count === 2");
    expect(d.shown_count === 2, "shown_count === 2");
    expect(d.truncated === false, "truncated === false for 2 rows");
    expect(
      Array.isArray(d.rows) && d.rows.length === 2 && d.rows[0][0] === "Alice",
      "rows[0][0] === 'Alice'",
    );
    expect(d.rows[0][1] === "30", "ints rendered without decimals: 30");
  }

  console.log("\n[2] filter / transform_column / add_column / select_columns");
  {
    const code = `
t = table(["name", "age"], [["Alice", 30], ["Bob", 25], ["Carol", 35]])
t.filter(lambda r: r["age"] >= 30)
t.transform_column("age", lambda a: a + 1)
t.add_column("decade", lambda r: r["age"] // 10 * 10)
t.select_columns(["name"])
`;
    const result = py(callRunFile, code, "ops.py", SK);
    expect(result.ok === true, "ok; stderr=" + result.stderr);
    expect(result.displays.length === 4, "4 table displays");

    const filtered = result.displays[0];
    expect(filtered.row_count === 2, "filter -> 2 rows (Alice 30, Carol 35)");

    const transformed = result.displays[1];
    expect(
      transformed.rows[0][1] === "31" && transformed.rows[1][1] === "26",
      "transform_column ages -> 31, 26",
    );

    const added = result.displays[2];
    expect(
      added.columns.length === 3 && added.columns[2] === "decade",
      "add_column -> third column 'decade'",
    );
    expect(added.rows[0][2] === "30", "Alice's decade -> 30");

    const selected = result.displays[3];
    expect(selected.columns.length === 1 && selected.columns[0] === "name",
      "select_columns(['name']) -> 1 column");
  }

  console.log("\n[3] order_by / head / tail");
  {
    const code = `
t = table(["x"], [[3], [1], [4], [1], [5], [9], [2], [6]])
t.order_by("x").head(3)
t.order_by("x", ascending=False).head(3)
t.tail(2)
`;
    const result = py(callRunFile, code, "order.py", SK);
    expect(result.ok === true, "ok; stderr=" + result.stderr);
    const ascHead = result.displays[0];
    expect(
      ascHead.rows.map((r) => r[0]).join(",") === "1,1,2",
      "ascending head -> 1,1,2",
    );
    const descHead = result.displays[1];
    expect(
      descHead.rows.map((r) => r[0]).join(",") === "9,6,5",
      "descending head -> 9,6,5",
    );
    const tailed = result.displays[2];
    expect(
      tailed.rows.map((r) => r[0]).join(",") === "2,6",
      "tail(2) -> 2,6 (preserves original order)",
    );
  }

  console.log("\n[4] aggregations: sum / mean / min / max / count");
  {
    const code = `
t = table(["v"], [[1], [2], [3], [4]])
print("sum=", t.sum("v"))
print("mean=", t.mean("v"))
print("min=", t.min("v"))
print("max=", t.max("v"))
print("count=", t.count())
`;
    const result = py(callRunFile, code, "agg.py", SK);
    expect(result.ok === true, "ok");
    expect(result.stdout.includes("sum= 10"), "sum=10");
    expect(result.stdout.includes("mean= 2.5"), "mean=2.5");
    expect(result.stdout.includes("min= 1"), "min=1");
    expect(result.stdout.includes("max= 4"), "max=4");
    expect(result.stdout.includes("count= 4"), "count=4");
  }

  console.log("\n[5] charts return image displays");
  {
    const code = `
t = table(["x", "y"], [[1, 2], [2, 4], [3, 6]])
t.bar_chart("x", "y", title="bar")
t.scatter_chart("x", "y", title="scatter")
t.line_chart("x", "y", title="line")
t.histogram("y", bins=3, title="hist")
`;
    const result = py(callRunFile, code, "charts.py", SK);
    expect(result.ok === true, "ok; stderr=" + result.stderr);
    expect(result.displays.length === 4, "4 image emissions");
    for (const d of result.displays) {
      expect(d.type === "image", "chart display type === 'image'");
      expect(typeof d.data === "string" && d.data.startsWith("<svg"), "chart SVG produced");
      expect(d.width === 480 && d.height === 320, "chart sized 480x320");
    }
  }

  console.log("\n[6] interleaved displays preserve emit order");
  {
    const code = `
t = table(["x", "y"], [[1, 2], [2, 4]])
t                                # 1: table
t.scatter_chart("x", "y")        # 2: image
t.add_column("z", [10, 20])      # 3: table (with z col)
`;
    const result = py(callRunFile, code, "interleave.py", SK);
    expect(result.ok === true, "ok");
    const cards = result.displays.filter(
      (d) => d.type === "table" || d.type === "image",
    );
    expect(cards.length === 3, "3 image/table displays");
    expect(
      cards[0].type === "table" &&
        cards[1].type === "image" &&
        cards[2].type === "table",
      "order: table, image, table",
    );
    expect(
      cards[2].columns.length === 3,
      "third card has 3 columns (x, y, z)",
    );
  }

  console.log("\n[6b] print() and table emissions are *interleaved*");
  {
    const code = `
t1 = table(["a"], [[1]])
print("before t1")
t1
print("between")
t2 = table(["b"], [[2]])
t2
print("after t2")
`;
    const result = py(callRunFile, code, "interleave2.py", SK);
    expect(result.ok === true, "ok; stderr=" + result.stderr);
    // Strip out the stdout chunks that just contain the trailing "\n" so the
    // ordering test is easier to read; we still want every type to appear.
    const types = result.displays.map((d) =>
      d.type === "stdout"
        ? "stdout(" + JSON.stringify(d.text) + ")"
        : d.type,
    );
    console.log("    timeline:", types.join(" | "));
    // The actual sequence Python writes: each print() is two writes:
    // "<text>" then "\n". Either order of merging is fine, but the
    // *first* table emission must come strictly after the first print
    // and strictly before the second print.
    const firstStdoutBefore = result.displays.findIndex(
      (d) => d.type === "stdout" && d.text.includes("before"),
    );
    const firstTable = result.displays.findIndex((d) => d.type === "table");
    const firstStdoutBetween = result.displays.findIndex(
      (d) => d.type === "stdout" && d.text.includes("between"),
    );
    const secondTable = result.displays
      .map((d, i) => [d, i])
      .filter(([d]) => d.type === "table")[1]?.[1];
    const stdoutAfter = result.displays.findIndex(
      (d) => d.type === "stdout" && d.text.includes("after"),
    );
    expect(firstStdoutBefore >= 0, "saw 'before t1' stdout chunk");
    expect(firstTable > firstStdoutBefore, "first table after 'before t1'");
    expect(firstStdoutBetween > firstTable, "'between' stdout after first table");
    expect(secondTable > firstStdoutBetween, "second table after 'between'");
    expect(stdoutAfter > secondTable, "'after t2' stdout after second table");
  }

  console.log("\n[7] big tables truncate at 200 rows but report full count");
  {
    const code = `
table(["i"], [[i] for i in range(500)])
`;
    const result = py(callRunFile, code, "big.py", SK);
    expect(result.ok === true, "ok");
    const d = result.displays[0];
    expect(d.row_count === 500, "row_count === 500");
    expect(d.shown_count === 200, "shown_count === 200");
    expect(d.truncated === true, "truncated === true");
    expect(d.rows.length === 200, "rows array capped at 200");
  }

  console.log("\n[8] bad column / non-numeric ops produce friendly errors");
  {
    const result = py(callRunFile, `table(["a"], [[1]]).sum("b")`, "err.py", SK);
    expect(result.ok === false && result.error_type === "KeyError", "KeyError on missing column");

    const result2 = py(callRunFile, `table(["a"], [["x"]]).sum("a")`, "err2.py", SK);
    expect(
      result2.ok === false && result2.error_type === "TypeError",
      "TypeError on non-numeric sum",
    );
  }

  console.log("\n[9] REPL eval can also display tables");
  {
    const result = py(callReplEval, `table(["n"], [[1], [2]])`, SK);
    expect(result.ok === true, "ok");
    expect(result.displays.length === 1 && result.displays[0].type === "table",
      "REPL eval emits a table display");
  }

  console.log("\n[10] images still flow through new displays pipeline");
  {
    const result = py(callRunFile, `circle(20, "solid", "red")`, "img.py", SK);
    expect(result.ok === true, "ok");
    expect(result.displays.length === 1 && result.displays[0].type === "image",
      "image display still emitted via new protocol");
  }

  console.log("\n[11] every Pyret chart has a PLL counterpart that renders");
  {
    // The set `public-resources/static/cs2000.arr` hands a course, so a
    // chart an assignment asks for is one PLL can draw.
    const setup = `t = table(["city", "region", "pop", "temp"], [
    ["Boston", "NE", 650, 51.0],
    ["Providence", "NE", 190, 52.0],
    ["Austin", "S", 970, 69.0],
    ["Dallas", "S", 1300, 67.0],
    ["Boise", "W", 240, 52.0]])
`;
    const calls = {
      bar_chart: 't.bar_chart("city", "pop")',
      scatter_chart: 't.scatter_chart("pop", "temp")',
      scatter_plot: 't.scatter_plot("pop", "temp")',
      line_chart: 't.line_chart("pop", "temp")',
      labeled_scatter_plot: 't.labeled_scatter_plot("region", "pop", "temp")',
      pie_chart: 't.pie_chart("city", "pop")',
      dot_plot: 't.dot_plot("temp")',
      labeled_dot_plot: 't.labeled_dot_plot("region", "temp")',
      freq_bar_chart: 't.freq_bar_chart("region")',
      box_plot: 't.box_plot("pop")',
      lr_plot: 't.lr_plot("pop", "temp")',
      labeled_lr_plot: 't.labeled_lr_plot("region", "pop", "temp")',
      histogram_bins: 't.histogram("pop", bins=3)',
      histogram_bin_width: 't.histogram("pop", bin_width=250)',
      function_plot: "function_plot(lambda x: x * x, -3, 3)",
    };
    for (const [name, call] of Object.entries(calls)) {
      const result = py(callRunFile, setup + call, `${name}.py`, SK);
      expect(result.ok === true, `${name} ran: ${result.error_message ?? ""}`);
      const shown = result.displays?.[0];
      expect(shown?.type === "image", `${name} emitted an image display`);
      expect(
        typeof shown?.data === "string" &&
          shown.data.startsWith("<svg") &&
          shown.data.trimEnd().endsWith("</svg>"),
        `${name} produced a complete svg`,
      );
      expect(shown.width > 0 && shown.height > 0, `${name} reported a size`);
    }
    console.log(`    ${Object.keys(calls).length} chart kinds render`);

    // The fit is the part with an answer to check rather than a picture.
    const fit = py(
      callRunFile,
      setup + 'print(tuple(round(v, 4) for v in t.linear_regression("pop", "temp")))',
      "fit.py",
      SK,
    );
    expect(fit.ok === true && fit.stdout.includes("0.0161"), `slope: ${fit.stdout}`);
    expect(fit.stdout.includes("0.7286"), `r-squared: ${fit.stdout}`);

    // A dot plot and a box plot are strips, not squares: their height is
    // set by the data, not by the chart constant.
    const strip = py(callRunFile, setup + 't.box_plot("pop")', "strip.py", SK);
    expect(strip.displays[0].height < 320, `box plot should be short, got ${strip.displays[0].height}`);
  }

  console.log("\n[12] charts refuse what they cannot draw, and say why");
  {
    for (const [code, kind] of [
      ['table(["a"], [["x"]]).box_plot("a")', "TypeError"],
      ['table(["a", "b"], [["x", -1]]).pie_chart("a", "b")', "ValueError"],
      ['table(["a", "b"], [["x", 0]]).pie_chart("a", "b")', "ValueError"],
      ['table(["a", "b"], [[1, 2], [1, 3]]).lr_plot("a", "b")', "ValueError"],
      ['table(["a"], [[1]]).histogram("a", bin_width=0)', "ValueError"],
      ["function_plot(lambda x: x, 3, 3)", "ValueError"],
    ]) {
      const result = py(callRunFile, code, "bad.py", SK);
      expect(
        result.ok === false && result.error_type === kind,
        `${code} -> ${kind}, got ${result.error_type}: ${result.error_message}`,
      );
    }
    console.log("    six refusals, each with its own reason");
  }

  console.log("\n[13] load_table reads a CSV, and tables compare by value");
  {
    // `JSON.stringify` builds the Python string literal: JSON's string
    // syntax is a subset of Python's, so the quoted CSV field survives
    // without a layer of hand-escaping to get wrong.
    const csv = [
      "name,mpg,note",
      'vw,29,"cheap, small"',
      "honda,33,reliable",
      "ford,18,",
      "",
    ].join("\n");
    const code = [
      'with open("cars.csv", "w") as f:',
      `    f.write(${JSON.stringify(csv)})`,
      't = load_table("cars.csv")',
      "print(t.columns())",
      'print(t.column("mpg"))',
      'print(t.column("note"))',
      // Every column is text, so charting one is a two-step job on purpose.
      'print(t.transform_column("mpg", float).column("mpg"))',
      'print(t.transform_column("mpg", float).mean("mpg"))',
      "try:",
      '    t.histogram("mpg")',
      "except TypeError as e:",
      '    print("hint:", "transform_column" in str(e))',
      'print(t == load_table("cars.csv"))',
      'print(t == table(["name"], [["vw"]]))',
      'print(table(["a", "b"], [[1, 2]]) == table(["b", "a"], [[2, 1]]))',
      'print(table(["a"], [[1]]) == table(["a"], [[1.0]]))',
      'print(repr(table(["a"], [[1], [2]])))',
    ].join("\n");
    const result = py(callRunFile, code, "load.py", SK);
    expect(result.ok === true, `ran: ${result.error_message ?? ""}`);
    const lines = (result.stdout ?? "").trim().split("\n");
    expect(lines[0] === "['name', 'mpg', 'note']", `columns: ${lines[0]}`);
    // Every cell is text, as Pyret's `load-table` gives it to you - a
    // column that looks numeric is not converted behind the program's back.
    expect(lines[1] === "['29', '33', '18']", `numbers arrive as text: ${lines[1]}`);
    // The quoted comma has to survive, and a blank cell is the empty string.
    expect(lines[2] === "['cheap, small', 'reliable', '']", `text column: ${lines[2]}`);
    // Conversion is one explicit step.
    expect(lines[3] === "[29.0, 33.0, 18.0]", `transform_column: ${lines[3]}`);
    expect(lines[4].startsWith("26.66"), `mean after converting: ${lines[4]}`);
    // And charting text says what to do about it, since this is now the
    // normal way to meet that error.
    expect(lines[5] === "hint: True", `the error should suggest the fix: ${lines[5]}`);
    expect(lines[6] === "True", "a table equals one loaded from the same file");
    expect(lines[7] === "False", "and not a different table");
    expect(lines[8] === "False", "column order is part of the table");
    expect(lines[9] === "True", "cells compare as Python values, so 1 == 1.0");
    // The repr is what a failed `assert t == expected` prints, so it has to
    // show the data rather than just the shape.
    expect(lines[10] === "table(['a'], [[1], [2]])", `repr: ${lines[10]}`);
    console.log("    csv arrives as text, converts explicitly, compares by value");
  }

  console.log("\n[14] load_table explains what went wrong");
  {
    // Separate statements, not `write(...) or load_table(...)`: `write`
    // returns the character count, so `or` would short-circuit and the
    // load would never run.
    const write = (name, body) =>
      [`with open("${name}", "w") as f:`, `    f.write(${JSON.stringify(body)})`, ""].join("\n");
    for (const [code, kind, needle] of [
      ['load_table("nope.csv")', "FileNotFoundError", "no file called"],
      ['load_table("ftp://h/a.csv")', "ValueError", "not a ftp:// one"],
      ["load_table(42)", "TypeError", "as a string"],
      [write("e.csv", "") + 'load_table("e.csv")', "ValueError", "no rows"],
      [write("d.csv", "a,a\n1,2\n") + 'load_table("d.csv")', "ValueError", "two columns called"],
      [write("r.csv", "a,b\n1\n") + 'load_table("r.csv")', "ValueError", "but there are 2 columns"],
      [write("h.csv", "a,,b\n1,2,3\n") + 'load_table("h.csv")', "ValueError", "has no name"],
    ]) {
      const result = py(callRunFile, code, "lterr.py", SK);
      expect(
        result.ok === false && result.error_type === kind &&
          (result.error_message ?? "").includes(needle),
        `${kind}/${needle}, got ${result.error_type}: ${result.error_message}`,
      );
    }
    console.log("    seven bad inputs, each named precisely");
  }

  callRunFile.destroy?.();
  callReplEval.destroy?.();

  if (!ok) {
    console.log("\nFAILED");
    process.exit(1);
  }
  console.log("\nALL TABLE SMOKE TESTS PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
