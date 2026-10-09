#!/usr/bin/env node
/**
 * Smoke test for the PLL table library.
 *
 * Boots Pyodide in Node, loads bootstrap + image lib + table lib + the
 * "register exports into the per-session template" install snippet, then
 * runs each scenario through `_pll_run_file` / `_pll_repl_eval`.
 */

import { expect, passed } from "./lib/check.mjs";
import { bootPll } from "./lib/pyodide.mjs";

const SK = "test:tables";

async function main() {
  const pyodide = await bootPll();

  const runFileAt = pyodide.globals.get("_pll_run_file");
  // At a student level: `#level raw` is Python, which shows no top-level
  // value, and these are about what is shown.
  const callRunFile = (code, fileName, session, level = "advanced", ...rest) =>
    runFileAt(code, fileName, session, level, ...rest);
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
    // And charting text says what to do about it, since loading a CSV is
    // the usual way to meet that error.
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

  console.log("\n[15] the table library's own messages say what to do");
  {
    const T = 't = table(["month", "riders"], [["Jan", 1121], ["Feb", 982]])\n';
    const CSV = [
      'with open("cars.csv", "w") as f:',
      '    f.write("name,mpg,day\\nvw,29,Mon\\nhonda,33,Tue\\nford,,Wed\\n")',
      'c = load_table("cars.csv")',
      "",
    ].join("\n");

    for (const [label, code, kind, needle] of [
      // Building a table: the row is counted from 1st, not from 0, and shown.
      [
        "short row",
        'table(["month", "riders"], [["Jan", 1121], ["Feb"]])',
        "ValueError",
        'the 2nd row, ["Feb"], has 1 value, but the table has 2 columns: month, riders',
      ],
      [
        "long row",
        'table(["month", "riders"], [["Jan", 1121, 9]])',
        "ValueError",
        'the 1st row, ["Jan", 1121, 9], has 3 values',
      ],
      // One string is iterable, so these must not come apart into letters.
      [
        "column names as one string",
        'table("month, riders", [["Jan", 1121]])',
        "TypeError",
        'column names should be a list of strings, like ["month", "riders"]',
      ],
      [
        "rows not nested",
        'table(["month", "riders"], ["Jan", 1121])',
        "TypeError",
        'the 1st row is the string "Jan". Put every row inside one outer list',
      ],
      [
        "duplicate columns",
        'table(["month", "month"], [["Jan", "Feb"]])',
        "ValueError",
        'two columns called "month"',
      ],
      // Rows: a dict's own errors say nothing about the table.
      ["row key typo", `${T}t.row(0)["rider"]`, "KeyError", 'this row has no column "rider" (it has: month, riders). Did you mean "riders"?'],
      ["row key case", `${T}t.row(0)["Riders"]`, "KeyError", "Column names are case-sensitive."],
      ["row attribute", `${T}t.row(0).riders`, "AttributeError", 'use square brackets: row["riders"]'],
      ["row by name", `${T}t.row("Mar")`, "TypeError", 'row expects a row number, but got the string "Mar"'],
      ["row out of range", `${T}t.row(5)`, "IndexError", "this table's rows are numbered 0 to 1"],
      ["column typo", `${T}t.column("rider")`, "KeyError", 'Did you mean "riders"?'],
      // Functions passed to the table methods.
      [
        "filter given a value",
        `${T}t.filter(t.row(0)["riders"] < 1000)`,
        "TypeError",
        "filter calls your function with one row at a time",
      ],
      [
        "filter function takes two",
        `${T}def below(r, limit):\n    return r["riders"] < limit\n\nt.filter(below)`,
        "TypeError",
        "filter calls `below` with one row, but `below` takes 2 parameters",
      ],
      [
        "filter returns a number",
        `${T}def below(r):\n    return r["riders"]\n\nt.filter(below)`,
        "TypeError",
        "has to return True or False, but `below` returned the number 1121 for the 1st row",
      ],
      [
        "transform given a value",
        `${CSV}c.transform_column("mpg", int())`,
        "TypeError",
        "no brackets after it - `int`, not `int()`",
      ],
      // Options given the wrong kind of value are refused, not ignored.
      [
        "ascending as a string",
        `${T}t.order_by("riders", ascending="False")`,
        "TypeError",
        'ascending has to be True or False, but it is the string "False"',
      ],
      [
        "select_columns given one name",
        `${T}t.select_columns("month")`,
        "TypeError",
        'a list of column names, like ["month"]',
      ],
      [
        "add_column over an existing one",
        `${T}t.add_column("riders", [1, 2])`,
        "ValueError",
        'use transform_column("riders", ...)',
      ],
      [
        "add_column with too few values",
        `${T}t.add_column("extra", [1])`,
        "ValueError",
        'given 1 value for "extra", but the table has 2 rows',
      ],
      // Converting, and charting what cannot be charted.
      [
        "conversion fails on one cell",
        `${CSV}c.transform_column("mpg", int)`,
        "ValueError",
        'transform_column("mpg", int) failed on the 3rd row, whose value is blank (""). A blank cell cannot be converted; write a function that decides what a blank should become',
      ],
      // A column a name starts: too far for a spelling match, and still
      // almost certainly what was meant.
      [
        "a column name that starts another",
        't = table(["name", "hours-worked"], [["a", 1]])\nt.column("hours")',
        "KeyError",
        'Did you mean "hours-worked"?',
      ],
      [
        "histogram with no bins",
        `${T}t.histogram("riders", bins=0)`,
        "ValueError",
        "histogram's `bins` has to be 1 or more",
      ],
      // The value as the student wrote it, not rounded the way a cell is.
      [
        "histogram with a negative width",
        `${T}t.histogram("riders", bin_width=-0.123456789)`,
        "ValueError",
        "but it is -0.123456789.",
      ],
      [
        "numbers still text",
        `${CSV}c.mean("mpg")`,
        "TypeError",
        'transform_column("mpg", float) first',
      ],
      // The convert advice is wrong for a column of words, so it is not given.
      [
        "a column of words",
        `${CSV}c.histogram("day")`,
        "TypeError",
        "That column holds text, so there is nothing to measure",
      ],
      [
        "bar_chart the wrong way round",
        `${T}t.bar_chart("riders", "month")`,
        "TypeError",
        'bar_chart takes the labels column first: bar_chart("month", "riders")',
      ],
      // Reading a file.
      // An image where a row number or a bool belongs: the one place a
      // table message describes an image, and so where an internal class
      // name would show. The libraries share one globals dict, so there
      // can only be one `_pll_describe` - it lives in the bootstrap.
      [
        "an image where a row number belongs",
        `${T}t.row(circle(5, "solid", "red"))`,
        "TypeError",
        "row expects a row number, but got an image",
      ],
      [
        "an image where a bool belongs",
        `${T}t.order_by("riders", ascending=circle(5, "solid", "red"))`,
        "TypeError",
        "ascending has to be True or False, but it is an image",
      ],
      [
        "a web page instead of a CSV",
        'with open("page.csv", "w") as f:\n    f.write("<!DOCTYPE html>\\n<html></html>\\n")\nload_table("page.csv")',
        "ValueError",
        "gave back a web page, not a CSV file",
      ],
    ]) {
      const result = py(callRunFile, code, "f6.py", SK);
      const message = result.error_message ?? "";
      expect(
        result.ok === false && result.error_type === kind && message.includes(needle),
        `${label}: wanted ${kind} "${needle}", got ${result.error_type}: ${message}`,
      );
    }
    console.log("    twenty-nine table, row, CSV and chart messages name the fix");

    // A missing file lists the ones that are there, which is usually the
    // whole answer.
    const missing = py(callRunFile, 'load_table("car.csv")', "f6.py", SK);
    // A close name answers it outright, rather than sitting in a list.
    expect(
      (missing.error_message ?? "").includes('Did you mean "cars.csv"?'),
      `a near-miss names the file: ${missing.error_message}`,
    );
    expect(
      !(missing.error_message ?? "").includes("Check the spelling"),
      `and does not also say to check the spelling: ${missing.error_message}`,
    );
    // Nothing close: the files that are there.
    const unrelated = py(callRunFile, 'load_table("zebra.csv")', "f6.py", SK);
    expect(
      (unrelated.error_message ?? "").includes("The CSV files next to your program are:"),
      `nothing close lists the real ones: ${unrelated.error_message}`,
    );
    // File names are quoted the course's way.
    expect(!/'car\.csv'/.test(missing.error_message ?? ""), `no Python repr quotes: ${missing.error_message}`);

    // Rows still have to be dicts, or every test written against one breaks.
    const asDict = py(
      callRunFile,
      `${T}print(t.row(0) == {"month": "Jan", "riders": 1121})\nprint(sorted(t.row(0).keys()))\nprint(t.rows() == [{"month": "Jan", "riders": 1121}, {"month": "Feb", "riders": 982}])`,
      "row.py",
      SK,
    );
    expect(asDict.ok === true, `rows still behave as dicts: ${asDict.error_message ?? ""}`);
    expect(
      (asDict.stdout ?? "").trim().split("\n").join("|") ===
        "True|['month', 'riders']|True",
      `a row compares equal to the plain dict a test is written with: ${asDict.stdout}`,
    );
    console.log("    and a row is still a dict: equal, keyed and ordered the same");
  }

  console.log("\n[16] a float is shown as Python prints it, and Save CSV has the whole table");
  {
    const rows = Array.from({ length: 250 }, (_, i) => `[${i}, ${i}.25]`).join(", ");
    const result = py(
      callRunFile,
      [
        `t = table(["n", "x"], [${rows}])`,
        `money = table(["amount", "flag", "missing"], [[12999.99, True, None], [1234567.89, False, 2.0]])`,
        "money",
        "t",
        'load_table_text = table(["code"], [["9"], ["100"]])',
        "load_table_text",
      ].join("\n"),
      "floats.py",
      SK,
    );
    expect(result.ok === true, `ran: ${result.error_message ?? ""}`);
    const [money, big, text] = result.displays.filter((d) => d.type === "table");
    expect(
      JSON.stringify(money.rows) === JSON.stringify([["12999.99", "True", ""], ["1234567.89", "False", "2.0"]]),
      `every digit, as Python prints it: ${JSON.stringify(money.rows)}`,
    );
    // Only columns of numbers - as Python holds them - line up on the right.
    expect(JSON.stringify(money.numeric) === "[true,false,true]", `numeric columns: ${JSON.stringify(money.numeric)}`);
    expect(JSON.stringify(text.numeric) === "[false]", `text that looks like a number is text: ${JSON.stringify(text.numeric)}`);
    expect(big.shown_count === 200 && big.truncated === true, `the card shows 200: ${big.shown_count}`);
    const csv = big.csv.trim().split("\n");
    expect(csv.length === 251 && csv[0] === "n,x" && csv[250] === "249,249.25" && big.csv_rows === 250,
      `Save CSV: every row, every digit: ${csv.length} lines, last ${csv[250]}`);
    expect(money.csv === "amount,flag,missing\n12999.99,True,\n1234567.89,False,2.0\n", `CSV of the values: ${JSON.stringify(money.csv)}`);
    console.log("    repr in the cells, numbers on the right by type, the whole table in the CSV");
  }

  console.log("\n[17] Excel's CSVs: a BOM is dropped, Windows-1252 is read and said once");
  {
    const code = [
      'with open("bom.csv", "wb") as f:',
      '    f.write("\\ufeffname,age\\nAda,36\\n".encode("utf-8"))',
      'with open("excel.csv", "wb") as f:',
      '    f.write("city,pop\\nZürich,400000\\nKöln,1\\n".encode("cp1252"))',
      'print(load_table("bom.csv").columns())',
      'print(load_table("excel.csv").column("city"))',
      'print(load_table("excel.csv").length())',
    ].join("\n");
    const result = py(callRunFile, code, "excel.py", SK);
    expect(result.ok === true, `ran: ${result.error_message ?? ""}`);
    const out = result.stdout.trim().split("\n");
    expect(out[0] === "['name', 'age']", `no BOM on the first name: ${out[0]}`);
    expect(out[1] === "['Zürich', 'Köln']", `Windows-1252 read: ${out[1]}`);
    const notes = (result.stderr.match(/note: excel\.csv is not UTF-8/g) ?? []).length;
    expect(notes === 1, `said once, though read twice: ${JSON.stringify(result.stderr)}`);
    const again = py(callRunFile, 'load_table("excel.csv")', "excel.py", SK);
    expect(/note: excel\.csv is not UTF-8/.test(again.stderr ?? ""), `and again in the next run: ${JSON.stringify(again.stderr)}`);
    const binary = py(callRunFile, 'with open("p.csv", "wb") as f:\n    f.write(b"\\x89PNG\\x00\\x00")\nload_table("p.csv")', "bin.py", SK);
    expect(/does not look like a text file/.test(binary.error_message ?? ""), `a binary file is still refused: ${binary.error_message}`);
    console.log("    BOM gone, cp1252 read with one note, binary still refused");
  }

  console.log("\n[18] load_table counts file lines, keeps blank cells, and refuses a quote left open");
  {
    const write = (name, body) => [`with open("${name}", "w") as f:`, `    f.write(${JSON.stringify(body)})`, ""].join("\n");
    const cases = [
      [write("lines.csv", 'a,b\n1,"two\nlines"\n3\n') + 'load_table("lines.csv")', false, "Line 4 of 'lines.csv'"],
      [write("open.csv", 'a,b\n1,"never closed\n3,4\n5,6\n') + 'load_table("open.csv")', false, 'has a quote (") on line 2 that is never closed'],
      [write("page.csv", "\ufeff<!-- generated -->\n<!DOCTYPE html><html></html>") + 'load_table("page.csv")', false, "gave back a web page"],
      [write("one.csv", "n\n1\n\n3\n\n\n") + 'print(load_table("one.csv").column("n"))', true, "['1', '', '3']"],
      [write("gaps.csv", "a,b\n1,2\n,\n3,4\n,\n\n") + 'print(load_table("gaps.csv").length())', true, "3"],
    ];
    for (const [code, ok, needle] of cases) {
      const result = py(callRunFile, code, "csv.py", SK);
      const text = ok ? result.stdout.trim() : result.error_message ?? "";
      expect(result.ok === ok && text.includes(needle), `wanted ${ok ? "output" : "error"} ${needle}, got ${result.error_type}: ${text}`);
    }
    console.log("    lines as the file has them, blank cells kept, trailing blanks not rows");
  }

  console.log("\n[19] sums of whole numbers are whole, and True is not a number at the teaching levels");
  {
    const code = [
      't = table(["n", "ok"], [[10**17, True], [1, False], [2, True]])',
      'print(repr(t.sum("n")), t.mean("n") == (10**17 + 3) / 3)',
      "def total(tb: Table) -> int:",
      '    return tb.sum("n")',
      "print(total(t))",
    ].join("\n");
    const beginner = py(callRunFile, code, "sums.py", SK, "beginner");
    expect(beginner.ok === true && beginner.stdout === "100000000000000003 True\n100000000000000003\n",
      `exact, and an int: ${JSON.stringify(beginner.stdout)} ${beginner.error_message ?? ""}`);
    for (const level of ["beginner", "intermediate"]) {
      const bools = py(callRunFile, 't = table(["ok"], [[True], [False]])\nt.sum("ok")', "bools.py", SK, level);
      expect(bools.ok === false && /True and False are not numbers/.test(bools.error_message ?? ""),
        `${level} refuses True: ${bools.error_message}`);
    }
    const advanced = py(callRunFile, 't = table(["ok"], [[True], [True], [False]])\nprint(t.sum("ok"), t.mean("ok"))', "bools.py", SK, "advanced");
    expect(advanced.stdout === "2 0.6666666666666666\n", `advanced counts them, as Python does: ${JSON.stringify(advanced.stdout)}`);
    console.log("    exact int sums, -> int fits, True refused where it is not a number");
  }

  console.log("\n[20] NaN and numbers left as text are not compared in silence");
  {
    const nan = py(callRunFile, 't = table(["x"], [[3.0], [float("nan")], [1.0], [2.0]])\nprint(t.order_by("x").column("x"))\nt.mean("x")', "nan.py", SK);
    expect(nan.stdout === "[1.0, 2.0, 3.0, nan]\n", `NaN sorts last: ${JSON.stringify(nan.stdout)}`);
    expect(nan.error_type === "ValueError" && /holds nan \("not a number"\) in the 2nd row/.test(nan.error_message ?? ""),
      `mean says which row: ${nan.error_message}`);
    const hist = py(callRunFile, 't = table(["x"], [[1.0], [float("inf")]])\nt.histogram("x")', "inf.py", SK);
    expect(hist.error_type === "ValueError" && /holds inf in the 2nd row/.test(hist.error_message ?? ""), `inf: ${hist.error_message}`);
    const CSV = 'with open("n.csv", "w") as f:\n    f.write("n\\n9\\n100\\n41\\n")\nc = load_table("n.csv")\n';
    for (const call of ['c.max("n")', 'c.min("n")', 'c.order_by("n")']) {
      const result = py(callRunFile, CSV + call, "text.py", SK);
      expect(result.error_type === "TypeError" && /as text "100" comes before "9"/.test(result.error_message ?? "") &&
        /transform_column\("n", int\)/.test(result.error_message ?? ""), `${call}: ${result.error_message}`);
    }
    // Text that sorts the same either way, like zip codes, is left alone.
    const zips = py(callRunFile, 't = table(["zip"], [["02115"], ["10001"], ["02134"]])\nprint(t.order_by("zip").column("zip"), t.max("zip"))', "zip.py", SK);
    expect(zips.stdout === "['02115', '02134', '10001'] 10001\n", `zip codes sort as text: ${JSON.stringify(zips.stdout)} ${zips.error_message ?? ""}`);
    console.log("    NaN last and named; '9' > '100' refused; zip codes fine");
  }

  console.log("\n[21] charts are images: they combine, annotate and compare like any other");
  {
    const code = [
      't = table(["n"], [[1], [2], [2], [9]])',
      "def chart(tb: Table) -> Image:",
      '    return tb.histogram("n")',
      'pic = above(text("Counts", 14, "black"), chart(t))',
      "print(image_width(pic), image_height(pic) > 320, chart(t) == chart(t))",
      'print(t.histogram("n", bin_width=5).to_svg().count("<rect"))',
      "import re",
      "print(re.findall(r'text-anchor=\"middle\" fill=\"#444\">([^<]*)<', table(['n'], [[10], [9], [100], [9]]).freq_bar_chart('n').to_svg()))",
      "print(function_plot(lambda x: 1 / x, -3, 3).to_svg().count(' M '))",
      "import math",
      "print(function_plot(math.sqrt, -3, 3) is not None)",
    ].join("\n");
    const result = py(callRunFile, code, "charts.py", SK, "beginner");
    expect(result.ok === true, `ran: ${result.error_type}: ${result.error_message ?? ""}`);
    const out = result.stdout.trim().split("\n");
    expect(out[0] === "480 True True", `above a chart, annotated -> Image, equal: ${out[0]}`);
    // 0-5, 5-10: two bars, and the white background.
    expect(out[1] === "3", `bin_width is used: ${out[1]}`);
    expect(out[2] === "['9', '10', '100']", `numbers in order of size: ${out[2]}`);
    expect(out[3] === "1", `1/x has a gap at 0, not a line through it: ${out[3]}`);
    expect(out[4] === "True", `sqrt below 0 is a gap, not a failed plot: ${out[4]}`);
    const notFn = py(callRunFile, "function_plot(3, -3, 3)", "fp.py", SK);
    expect(/function_plot needs a function, but got the number 3/.test(notFn.error_message ?? ""), `checked: ${notFn.error_message}`);
    console.log("    above(title, chart), -> Image, bin_width, number order, gaps");
  }

  console.log("\n[22] an error in the student's own function is theirs, not transform_column's");
  {
    const code = [
      "def per_hour(minutes):",
      "    return 60 / minutes",
      't = table(["m"], [[30], [0]])',
      't.transform_column("m", per_hour)',
    ].join("\n");
    const result = py(callRunFile, code, "own.py", SK);
    expect(result.error_type === "ZeroDivisionError" && result.error_message === "division by zero",
      `Python's own error: ${result.error_type}: ${result.error_message}`);
    const frames = (result.error_frames ?? []).filter((f) => f.user);
    expect(frames.at(-1)?.line === 2 && frames.at(-1)?.function === "per_hour", `at their line: ${JSON.stringify(frames.at(-1))}`);
    // A ValueError of their own is theirs too, in Python's words.
    const own = py(callRunFile, 'def hours(m):\n    return int(m) / 60\n\nt = table(["m"], [["90"], ["abc"]])\nt.transform_column("m", hours)', "ownv.py", SK);
    expect(own.error_type === "ValueError" && own.error_message === "invalid literal for int() with base 10: 'abc'",
      `their ValueError, as raised: ${own.error_message}`);
    // An exception whose constructor takes other arguments survives.
    const odd = py(callRunFile, 't = table(["b"], [[b"\\xff"]])\nt.transform_column("b", bytes.decode)', "odd.py", SK);
    expect(odd.error_type === "UnicodeDecodeError", `UnicodeDecodeError, as raised: ${odd.error_type}: ${odd.error_message}`);
    // A conversion is still reworded with the row and the advice.
    const blank = py(callRunFile, 't = table(["n"], [["1"], [""]])\nt.transform_column("n", int)', "conv.py", SK);
    expect(/failed on the 2nd row, whose value is blank/.test(blank.error_message ?? ""), `int still explained: ${blank.error_message}`);
    console.log("    the student's error kept, with its line; conversions still explained");
  }

  console.log("\n[23] names, slices, rows: refused in PLL's words");
  {
    const T = 't = table(["name", "age"], [["Ada", 36], ["Alan", 41]])\n';
    for (const [code, kind, needle] of [
      [`${T}t.add_column(5, [1, 2])`, "TypeError", "column name has to be a string"],
      ['table_from_columns({5: [1]})', "TypeError", "column name has to be a string"],
      ['table_from_columns([1, 2])', "TypeError", "takes one dictionary"],
      ['table_from_columns({"a": "abc"})', "TypeError", 'needs a list of values for each column, but "a" is the string "abc"'],
      ['table_from_columns({"a": [1, 2, 3], "b": [1, 2]})', "ValueError", '"a" has 3 values and "b" has 2'],
      [`${T}t.select_columns(["name", "name"])`, "ValueError", 'given "name" more than once'],
      [`${T}t.column(["name"])`, "TypeError", "a column is named by a string"],
      [`${T}t.row(1.0)`, "TypeError", "got 1.0, which is a float: write row(1)"],
      [`${T}t.head(-1)`, "ValueError", "cannot be negative"],
      [`${T}t.tail("2")`, "TypeError", "as a whole number like tail(5)"],
      [`${T}t.add_column("x", 0)`, "TypeError", "add_column needs a list of values"],
      ['table(["age"], []).mean("age")', "ValueError", "mean needs at least one row"],
      ['table(["name", "age"], [{"nmae": "Ada", "age": 3}])', "ValueError", '"nmae", which is not one of the columns (name, age). Did you mean "name"?'],
      [`${T}t.histogram("age", bins=2.5)`, "TypeError", "`bins` has to be a whole number"],
      [`${T}t.scatter_plot("name", "age")`, "TypeError", "scatter_plot needs a column of numbers"],
      ['table(["l", "v"], [["a", -1]]).pie_chart("l", "v")', "ValueError", 'column "v" holds -1 in the 1st row'],
      [`${T}t["age"]`, "TypeError", 'write t.column("age")'],
      [`${T}t[0]`, "TypeError", "write t.row(0)"],
      [`${T}[r for r in t]`, "TypeError", "loop over t.rows()"],
      [`${T}t.age`, "AttributeError", 'write t.column("age")'],
      [`${T}t.colum("age")`, "AttributeError", "a table has no method `colum`. Did you mean: 'column'?"],
    ]) {
      const result = py(callRunFile, code, "names.py", SK);
      const message = result.error_message ?? "";
      expect(result.ok === false && result.error_type === kind && message.includes(needle),
        `${code.split("\n").at(-1)}: wanted ${kind} "${needle}", got ${result.error_type}: ${message}`);
    }
    console.log("    twenty-one mistakes, each with the fix");
  }

  console.log("\n[24] add_row, Row, and help in pll.table");
  {
    const code = [
      'people = table(["name", "age"], [["Ada", 36]])',
      'more = people.add_row(["Alan", 41]).add_row({"name": "Grace"})',
      "print(more.rows(), people.length())",
      "def first(tb: Table) -> Row:",
      "    return tb.row(0)",
      "print(first(more))",
      "from pll.table import Row as R",
      "print(R is Row)",
      "import time",
      "start = time.time()",
      "big = table(['i'], [])",
      "for i in range(2000):",
      "    big = big.add_row([i])",
      "print(big.length(), time.time() - start < 5)",
      "import pydoc",
      "print(pydoc.render_doc(load_table).splitlines()[0])",
    ].join("\n");
    const result = py(callRunFile, code, "rows.py", SK, "advanced");
    expect(result.ok === true, `ran: ${result.error_type}: ${result.error_message ?? ""}`);
    const out = result.stdout.trim().split("\n");
    expect(out[0] === "[{'name': 'Ada', 'age': 36}, {'name': 'Alan', 'age': 41}, {'name': 'Grace', 'age': None}] 1",
      `added, and the first table unchanged: ${out[0]}`);
    expect(out[1] === "{'name': 'Ada', 'age': 36}" && out[2] === "True", `Row is a name: ${out.slice(1, 3)}`);
    expect(out[3] === "2000 True", `row by row in time: ${out[3]}`);
    expect(out[4] === "Python Library Documentation: function load_table in module pll.table", `help: ${out[4]}`);
    console.log("    add_row, `-> Row`, `from pll.table import Row`, help names pll.table");
  }

  console.log("\n[25] a file kept back for its size is said to be, not missing");
  {
    pyodide.runPython('_pll_note_left_out(\'[{"name": "big.csv", "why": "each file can be at most 2 MB"}]\')');
    const result = py(callRunFile, 'load_table("big.csv")', "big.py", SK);
    expect(result.error_type === "FileNotFoundError" &&
      result.error_message === '"big.csv" is next to your program, but it was not loaded: each file can be at most 2 MB.',
      `why it is not there: ${result.error_message}`);
    pyodide.runPython("_pll_note_left_out('[]')");
    console.log("    not loaded, and why");
  }

  callRunFile.destroy?.();
  callReplEval.destroy?.();

  if (!passed()) {
    console.log("\nFAILED");
    process.exit(1);
  }
  console.log("\nALL TABLE SMOKE TESTS PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
