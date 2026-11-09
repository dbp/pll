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

if (section(2, "a value is checked to its end however deep it is, and a failure found in one pass")) {
  const LONG = (n, last) => [
    ...NODE,
    "def build(n):",
    `    l = Node(${last}, None)`,
    "    for k in range(n - 1):",
    "        l = Node(k, l)",
    "    return l",
    "",
    "def head(l: Node[int] | None) -> int:",
    "    return l.first",
    "",
    `print(head(build(${n})))`,
  ];
  const deep = ran(lines(...LONG(1000, 0)), "intermediate");
  expect(deep.stdout === "998\n" && deep.error === null, `1000 cells: ${deep.stdout} ${deep.error?.errorType} ${deep.error?.message}`);
  const broken = (n) => ran(lines(...LONG(n, '"x"')), "intermediate");
  const runs = SIZES.map(broken);
  runs.forEach((run, i) =>
    expect(
      run.error?.errorType === "TypeMismatch" && run.error?.facts?.check?.value === '"x"' && run.error?.facts?.check?.path?.length === SIZES[i] + 1,
      `the last of ${SIZES[i]} cells: ${run.error?.errorType} ${run.error?.facts?.check?.value} ${run.error?.facts?.check?.path?.length}`,
    ),
  );
  expect(linearly(runs, "checks"), `finding it: ${runs.map((run) => run.checks).join(", ")} checks at ${SIZES.join(", ")} cells`);
  // A list that contains itself, under a type that names itself, is
  // taken as what it is - as a dataclass that contains itself already was.
  const cyclic = ran(
    lines("type Tree = list[Tree] | int", "", "def size(t: Tree) -> int:", "    return 1", "", "t = []", "t.append(t)", "print(size(t))"),
    "advanced",
  );
  expect(cyclic.stdout === "1\n" && cyclic.error === null, `a list in itself: ${cyclic.stdout} ${cyclic.error?.errorType}`);
  // A union's members are tried in order: a name defined further down is
  // not looked up for a value an earlier member takes.
  const later = ran(lines("from typing import Union", "", 'counts: dict[Union[int, "Later"], int] = {1: 2}', "print(len(counts))"), "advanced");
  expect(later.stdout === "1\n" && later.error === null, `a name not yet defined, after int: ${later.stdout} ${later.error?.message}`);
  // Two members shaped like the value, deeper than Python's stack.
  const nest = ran(
    lines(
      "type Nest = list[Nest] | list[int]",
      "",
      "def size(x: Nest) -> int:",
      "    return 0",
      "",
      "x = [1]",
      "for i in range(3000):",
      "    x = [x]",
      "print(size(x))",
    ),
    "advanced",
  );
  expect(nest.stdout === "0\n" && nest.error === null, `3000 lists deep, two members shaped: ${nest.stdout} ${nest.error?.errorType}`);
  console.log("    1000 cells checked; the bad one found in one pass; a list in itself accepted");
}

const LOOPED = (last) => [
  ...NODE,
  "def build(n):",
  `    l = Node(${last}, None)`,
  "    for k in range(n - 1):",
  "        l = Node(k, l)",
  "    return l",
  "",
];

if (section(3, "a generic function's copy of a value is made however deep the value is")) {
  const head = ran(
    lines(...LOOPED(7), "def head[T](l: Node[T] | None) -> T | None:", "    return None if l is None else l.first", "", "print(head(build(1200)))"),
    "intermediate",
  );
  expect(head.stdout === "1198\n" && head.error === null, `1200 cells: ${head.stdout} ${head.error?.errorType} ${head.error?.message}`);
  linear("a generic function's copy", (n) => lines(...LOOPED(7), "def head[T](l: Node[T] | None) -> T | None:", "    return None if l is None else l.first", "", `print(head(build(${n})))`), {
    level: "intermediate",
    counts: ["steps"],
    printed: (n) => `${n - 2}\n`,
  });
  console.log("    1200 cells copied for a generic function, at a cost per cell that does not grow");
}

if (section(4, "a value a contract accepted is not checked again")) {
  linear("a recursive function over Node[int]", (n) => lines(...NODE, ...BUILD, ...LENGTH, `print(length(build(${n})))`));
  linear("building Node[int] by consing", (n) =>
    lines(...NODE, "def build(k: int) -> Node[int] | None:", "    return None if k == 0 else Node(k, build(k - 1))", "", `print(build(${n}) is not None)`),
  );
  // A field set, or deleted, after the check is checked again.
  const changed = (change) =>
    ran(lines(...NODE, ...LENGTH, "l = Node(1, Node(2, None))", "print(length(l))", change, "print(length(l))"), "advanced");
  for (const change of ['l.rest.first = "x"', "del l.rest.first"]) {
    const after = changed(change);
    expect(after.stdout === "2\n" && after.error?.errorType === "TypeMismatch", `after \`${change}\`: ${after.stdout} ${after.error?.message}`);
  }
  // A list inside one is read again each time: it can change unseen.
  const listed = ran(
    lines(
      "@dataclass",
      "class Box[T]:",
      "    item: T",
      "",
      "def size(b: Box[list[int]]) -> int:",
      "    return len(b.item)",
      "",
      "b = Box([1])",
      "print(size(b))",
      'b.item.append("x")',
      "print(size(b))",
    ),
    "advanced",
  );
  expect(listed.stdout === "1\n" && listed.error?.errorType === "TypeMismatch", `a list changed in place: ${listed.stdout} ${listed.error?.message}`);
  // Made again by its own `__init__`, or changed through a subclass of a
  // frozen one that lets it: seen too.
  const BOX = ["@dataclass", "class Box[T]:", "    item: T", "", "    def reset(self, item):", "        self.__init__(item)", ""];
  const TAKE = ["def take(b: Box[int]) -> int:", "    return 0", ""];
  const reinit = ran(lines(...BOX, ...TAKE, "b = Box(1)", "print(take(b))", 'b.reset("s")', "print(take(b))"), "advanced");
  expect(reinit.stdout === "0\n" && reinit.error?.errorType === "TypeMismatch", `made again: ${reinit.stdout} ${reinit.error?.message}`);
  const loose = ran(
    lines(
      "@dataclass(frozen=True)",
      "class Box[T]:",
      "    item: T",
      "",
      "class Loose(Box):",
      "    def __setattr__(self, name, value):",
      "        object.__setattr__(self, name, value)",
      "",
      ...TAKE,
      "b = Loose(1)",
      "print(take(b))",
      'b.item = "s"',
      "print(take(b))",
    ),
    "advanced",
  );
  expect(loose.stdout === "0\n" && loose.error?.errorType === "TypeMismatch", `a frozen one let loose: ${loose.stdout} ${loose.error?.message}`);
  console.log("    each cell checked once; a change to one is seen");
}

if (section(5, "where nothing can change it, a list checked once is not walked again")) {
  linear(
    "a helper given the list in a loop",
    (n) =>
      lines(
        "def item(l: list[int], i: int) -> int:",
        "    return l[i]",
        "",
        "def total(l: list[int]) -> int:",
        "    s = 0",
        "    for i in range(len(l)):",
        "        s = s + item(l, i)",
        "    return s",
        "",
        `print(total(list(range(${n}))))`,
      ),
    { level: "intermediate" },
  );
  // Where a list can change, it is checked again.
  const changed = ran(
    lines("def total(l: list[int]) -> int:", "    return len(l)", "", "xs = [1, 2]", "print(total(xs))", 'xs.append("x")', "print(total(xs))"),
    "advanced",
  );
  expect(changed.stdout === "2\n" && changed.error?.errorType === "TypeMismatch", `a list changed at advanced: ${changed.stdout} ${changed.error?.message}`);
  // None is not a list that was remembered.
  const none = ran(lines("def size(l: list[int]) -> int:", "    return 0", "", "print(size([1]))", "print(size(None))"), "intermediate");
  expect(none.stdout === "0\n" && none.error?.errorType === "TypeMismatch", `None as a list: ${none.stdout} ${none.error?.errorType}`);
  // The next run lets go of an earlier run's lists.
  ran(lines("xs: list[int] = [1, 2, 3]", "print(len(xs))"), "intermediate", "cost-held");
  ran(lines("print(0)"), "intermediate", "cost-held");
  const held = pyodide.runPython("sum(len(accepted.held) for accepted in globals().get('_PLL_HOLDING', ()))");
  expect(held === 0, `values still held after the next run: ${held}`);
  // A teaching level doesn't keep a deque from changing.
  const deque = ran(
    lines("from collections import deque", "", "def size(d: deque[int]) -> int:", "    return len(d)", "", "d = deque([1])", "print(size(d))", 'd.append("x")', "print(size(d))"),
    "intermediate",
  );
  expect(deque.stdout === "1\n" && deque.error?.errorType === "TypeMismatch", `a deque changed at intermediate: ${deque.stdout} ${deque.error?.message}`);
  console.log("    each list checked once at intermediate; checked again where it can change");
}

if (section(6, "a function passed on through the same parameter is not wrapped again")) {
  const APPLY = [
    "def apply_n(f: Callable[[int], int], k: int, x: int) -> int:",
    "    return x if k == 0 else apply_n(f, k - 1, f(x))",
    "",
    "def add1(x: int) -> int:",
    "    return x + 1",
    "",
  ];
  linear("apply_n", (n) => lines(...APPLY, `print(apply_n(add1, ${n}, 0))`));
  // As deep as the same program goes unannotated: wrappers do not pile up
  // on the stack either.
  const deep = ran(lines(...APPLY, "print(apply_n(add1, 900, 0))"));
  expect(deep.stdout === "900\n" && deep.error === null, `900 deep: ${deep.stdout} ${deep.error?.errorType} ${deep.error?.message}`);
  // Still checked at each call, and still blamed on the caller.
  const broken = ran(
    lines(...APPLY, "def bad(x: int) -> int:", '    return "s" if x == 5 else x + 1', "", "print(apply_n(bad, 10, 0))"),
  );
  expect(
    broken.error?.errorType === "TypeMismatch" && broken.error?.facts?.check?.blamed?.name === "bad",
    `a result broken on the 6th call: ${broken.error?.errorType} ${JSON.stringify(broken.error?.facts?.check?.blamed)}`,
  );
  console.log("    one wrapper for the crossings that repeat; each call still checked");
}

if (section(7, "a method called from one line is put under its contract once")) {
  const calls = (n) =>
    ran(
      lines(
        "@dataclass",
        "class Box:",
        "    v: int",
        "",
        "    def get(self) -> int:",
        "        return self.v",
        "",
        "def total(b: Box, k: int) -> int:",
        "    s = 0",
        "    for i in range(k):",
        "        s = s + b.get()",
        "    return s",
        "",
        `print(total(Box(1), ${n}))`,
      ),
      "intermediate",
    );
  const [few, many] = [calls(10), calls(1000)];
  expect(many.stdout === "1000\n" && many.error === null, `1000 calls: ${many.stdout} ${many.error?.message}`);
  expect(many.wraps === few.wraps, `wrappers: ${few.wraps} for 10 calls, ${many.wraps} for 1000`);
  console.log("    one wrapper for the line, however many calls it makes");
}

if (section(8, "a function passed between functions with the same parameter types is not wrapped again either")) {
  const PING = (other) => [
    "def ping(f: Callable[[int], int], k: int, x: int) -> int:",
    "    return x if k == 0 else pong(f, k - 1, f(x))",
    "",
    `def pong(f: Callable[[int], ${other}], k: int, x: int) -> int:`,
    "    return x if k == 0 else ping(f, k - 1, f(x))",
    "",
    "def inc(x):",
    "    return x + 1",
    "",
  ];
  linear("ping and pong", (n) => lines(...PING("int"), `print(ping(inc, ${n}, 0))`));
  const deep = ran(lines(...PING("int"), "print(ping(inc, 900, 0))"));
  expect(deep.stdout === "900\n" && deep.error === null, `900 deep: ${deep.stdout} ${deep.error?.errorType} ${deep.error?.message}`);
  // pong says f gives back a str: the first result it sees is ping's to answer for.
  const broken = ran(lines(...PING("str"), "print(ping(inc, 6, 0))"));
  expect(
    broken.error?.errorType === "TypeMismatch" && broken.error?.facts?.check?.blamed?.name === "ping",
    `pong's str broken: ${broken.error?.errorType} ${JSON.stringify(broken.error?.facts?.check?.blamed)}`,
  );
  console.log("    the same checks, kept once; the same blame");
}

if (section(9, "a variable's annotation with a name in quotes is read in each run")) {
  const DOGS = ["@dataclass", "class Dog:", "    name: str", "", 'pets: list["Dog"] = [Dog("a")]', "print(len(pets))"];
  for (const [run, session] of [["first", "cost-dogs"], ["again", "cost-dogs"], ["in another file", "cost-dogs-2"]]) {
    const dogs = ran(lines(...DOGS), "beginner", session);
    expect(dogs.stdout === "1\n" && dogs.error === null, `run ${run}: ${dogs.stdout} ${dogs.error?.message}`);
  }
  // Through a type alias, after the class it names is made again.
  const key = "cost-pack";
  ran(lines("@dataclass", "class Dog:", "    name: str", "", 'type Pack = list["Dog"]', 'p: Pack = [Dog("a")]', "print(len(p))"), "advanced", key);
  pllCall("_pll_repl_eval", JSON.stringify(["@dataclass\nclass Dog:\n    name: str\n", key, "advanced"]));
  const packed = JSON.parse(pllCall("_pll_repl_eval", JSON.stringify(['q: Pack = [Dog("b")]\nprint(len(q))', key, "advanced"])));
  expect(packed.stdout === "1\n" && !packed.error, `an alias's quoted name after Dog is made again: ${packed.stdout} ${packed.error?.message}`);
  // Each annotation's own words in what it says.
  const words = ran(lines("Numbers = list[int]", "xs: Numbers = [1]", "ys: list[int] = 5"), "advanced");
  expect(words.error?.facts?.check?.expected?.[0] === "list[int]", `ys's annotation as written: ${JSON.stringify(words.error?.facts?.check?.expected)}`);
  console.log("    each run's own Dog, through an alias too; each annotation in its own words");
}

console.log(passed() ? "\nsmoke-contracts-cost: ok" : "\nsmoke-contracts-cost: FAILED");
if (!passed()) process.exitCode = 1;
