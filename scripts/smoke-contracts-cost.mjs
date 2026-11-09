#!/usr/bin/env node
/**
 * What a contract costs as a program grows (bootstrap/contracts.py): the
 * checks a run makes are counted at the leaves, `_PllClassContract.accepts`,
 * and must grow as the program's own work does - not once more for every
 * call that a value, or a function, has already crossed.
 */
import { expect, passed, section } from "./lib/check.mjs";
import { bootPll } from "./lib/pyodide.mjs";

const pyodide = await bootPll();
const pllCall = pyodide.globals.get("_pll_call");

pyodide.runPython(`
import json as _pll_test_json

_pll_test_counts = {}

def _pll_test_counting(name, original, measure=lambda *args, **kwargs: 1):
    def counted(*args, **kwargs):
        _pll_test_counts[name] = _pll_test_counts.get(name, 0) + measure(*args, **kwargs)
        return original(*args, **kwargs)
    return counted

_PllClassContract.accepts = _pll_test_counting("checks", _PllClassContract.accepts)
_pll_wrapped = _pll_test_counting("wraps", _pll_wrapped)
_PllBlame.__init__ = _pll_test_counting("steps", _PllBlame.__init__, lambda self, positive, negative, owner, steps=(), *rest, **named: len(steps))
`);

let runs = 0;
/** Run `source` at `level`: its output, its error, and what it counted - the leaf checks it made, the wrappers it asked for and the steps of the paths its blames were made with. */
function ran(source, level = "beginner", session = `cost-${(runs += 1)}`) {
  pyodide.runPython("_pll_test_counts.clear()");
  const result = JSON.parse(pllCall("_pll_run_file", JSON.stringify([source, "lab.py", session, level, false])));
  return { stdout: result.stdout, error: result.error ?? null, ...JSON.parse(pyodide.runPython("_pll_test_json.dumps(_pll_test_counts)")) };
}

const lines = (...rows) => rows.join("\n") + "\n";
const NODE = ["@dataclass", "class Node[T]:", "    first: T", '    rest: "Node[T] | None"', ""];
const BUILD = ["def build(k):", "    return None if k == 0 else Node(k, build(k - 1))", ""];
const LENGTH = ["def length(l: Node[int] | None) -> int:", "    return 0 if l is None else 1 + length(l.rest)", ""];

/** The sizes a program's counts are compared at, evenly spaced, the last close to the depth PLL's recursion limit lets a recursion over it reach. */
const SIZES = [100, 450, 800];

/** Whether `count` grew no faster than n across `runs`, one at each of SIZES: by no more from the second to the third than from the first to the second. */
const linearly = (runs, count) => {
  const [a, b, c] = runs.map((run) => run[count] ?? 0);
  return c - b <= b - a + 8;
};

/** `program(n)` at each of SIZES, printing `printed(n)` where that is given, each of `counts` growing no faster than n. */
function linear(what, program, { level = "beginner", counts = ["checks"], printed } = {}) {
  const runs = SIZES.map((n) => ran(program(n), level));
  runs.forEach((run, i) =>
    expect(run.error === null && (printed === undefined || run.stdout === printed(SIZES[i])), `${what} at ${SIZES[i]}: ${run.stdout} ${run.error?.message ?? ""}`),
  );
  for (const count of counts) {
    expect(linearly(runs, count), `${what}: ${runs.map((run) => run[count] ?? 0).join(", ")} ${count} at ${SIZES.join(", ")}`);
  }
}

if (section(1, "a recursive generic dataclass is checked by one contract, however deep the value")) {
  const contracts = (n) => {
    ran(lines(...NODE, ...BUILD, ...LENGTH, `print(length(build(${n})))`), "beginner", "cost-depth");
    return pyodide.runPython(
      "import gc\nnode = _pll_get_session('cost-depth')['Node']\nsum(1 for o in gc.get_objects() if isinstance(o, _PllDataContract) and o.cls is node)",
    );
  };
  const few = contracts(3);
  const many = contracts(SIZES.at(-1));
  expect(many <= few, `contracts for Node: ${few} after 3 cells, ${many} after ${SIZES.at(-1)}`);
  // A type alias that names itself, given an ordinary value.
  const nested = ran(lines("type Nested = list[Nested] | int", "", "def depth(x: Nested) -> int:", "    return 0", "", "print(depth([[1], 2]))"), "advanced");
  expect(nested.stdout === "0\n" && nested.error === null, `type Nested = list[Nested] | int: ${nested.stdout} ${nested.error?.errorType}`);
  // A file run again reads its names in quotes in the new run.
  const PLAIN = ["@dataclass", "class Cell:", "    first: int", '    rest: "Cell | None"', "", "print(Cell(1, Cell(2, None)).rest.first)"];
  for (const run of ["first", "again"]) {
    const rerun = ran(lines(...PLAIN), "beginner", "cost-rerun");
    expect(rerun.stdout === "2\n" && rerun.error === null, `a rerun, ${run}: ${rerun.stdout} ${rerun.error?.message}`);
  }
  console.log("    the same contracts after a long value as after a short one; an alias that names itself; a rerun");
}

console.log(passed() ? "\nsmoke-contracts-cost: ok" : "\nsmoke-contracts-cost: FAILED");
if (!passed()) process.exitCode = 1;
