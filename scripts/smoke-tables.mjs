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
