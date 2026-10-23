#!/usr/bin/env node
/**
 * Annotations as higher-order contracts (bootstrap/contracts.py): who is
 * blamed, where, and when - Findler and Felleisen's λCON, with Racket's
 * first-order checks on functions (docs/contracts.md). Each program is run
 * as a file, through the same Python a run uses, and the finding read.
 */
import { expect, passed } from "./lib/check.mjs";
import { bootPll } from "./lib/pyodide.mjs";

const pyodide = await bootPll();
const pllCall = pyodide.globals.get("_pll_call");

let runs = 0;
/** Run `source` as `lab.py` at `level`: the finding, its facts, and the output. */
function ran(source, level = "beginner") {
  runs += 1;
  const result = JSON.parse(pllCall("_pll_run_file", JSON.stringify([source, "lab.py", `contracts-${runs}`, level, false])));
  return { finding: result.error?.finding ?? null, error: result.error ?? null, stdout: result.stdout, stderr: result.stderr };
}

// `Callable` needs no import at the student levels.
const CALLABLE = "";

console.log("[`dataclass` needs no import at the student levels; raw is Python]");
{
  const DOG = '@dataclass\nclass Dog:\n    name: str\n\nprint(Dog("Rex"))\n';
  for (const level of ["beginner", "intermediate", "advanced"]) {
    const given = ran(DOG, level);
    expect(given.stdout === "Dog(name='Rex')\n" && given.error === null, `${level}: ${given.stdout} ${given.error?.message ?? ""}`);
  }
  const raw = ran(DOG, "raw");
  expect(
    raw.error?.errorType === "NameError" && raw.finding?.howToFix?.[0] === "Add `from dataclasses import dataclass` at the top of the file.",
    `raw needs the import: ${JSON.stringify(raw.finding)}`,
  );
  console.log("    given at beginner, intermediate and advanced, and checked there as an imported one is");
}
const ADD1 = "def add1(x: int) -> int:\n    return x + 1\n\n";

console.log("[the paper's examples: a function's argument contract, broken two ways]");
{
  // (a) foo calls f with 1: foo broke its own promise, at that call.
  const a = ran(`${CALLABLE}${ADD1}def foo(f: Callable[[str], str]) -> int:\n    return f(1)\n\nfoo(add1)\n`);
  expect(
    a.finding?.headline === "`foo` calls `f` with `1`, a whole number (`int`), but its annotation says `f` takes a string (`str`)." &&
      a.finding?.lineNumber === 5,
    `(a): ${a.finding?.headline} at ${a.finding?.lineNumber}`,
  );
  expect(a.error?.facts?.check?.blamed?.name === "foo" && a.error?.facts?.check?.role === "owner", `(a) blames foo: ${JSON.stringify(a.error?.facts?.check?.blamed)}`);
  // (b) foo calls f with "a", as its annotation allows: the top level that
  // handed add1 over is to blame, at the line that did.
  const b = ran(`${CALLABLE}${ADD1}def foo(f: Callable[[str], str]) -> int:\n    f("a")\n    return 0\n\nfoo(add1)\n`);
  expect(
    b.finding?.headline ===
      "`add1` expects `x` to be a whole number (`int`), but it was handed over on line 8 and then called by `foo` with a string (`str`)." &&
      b.finding?.lineNumber === 8,
    `(b): ${b.finding?.headline} at ${b.finding?.lineNumber}`,
  );
  expect(b.error?.facts?.check?.blamed?.kind === "main", `(b) blames the top level: ${JSON.stringify(b.error?.facts?.check?.blamed)}`);
  // When the function crosses, only its first-order part: callable, and
  // taking that many arguments.
  const arity = ran(`${CALLABLE}def two(a: int, b: int) -> int:\n    return a + b\n\ndef foo(f: Callable[[str], str]) -> int:\n    return 0\n\nfoo(two)\n`);
  expect(
    arity.finding?.headline ===
      "`foo` expects `f` to be a function that takes 1 argument (`Callable[[str], str]`), but it takes 2 arguments (`a` and `b`)." &&
      arity.finding?.lineNumber === 7,
    `arity: ${arity.finding?.headline} at ${arity.finding?.lineNumber}`,
  );
  // A function that fits is not checked against the other's annotation:
  // contracts are not types, and nothing is wrong until a call is.
  const fits = ran(`${CALLABLE}${ADD1}def foo(f: Callable[[str], str]) -> int:\n    return 0\n\nprint(foo(add1))\n`);
  expect(fits.finding === null && fits.stdout === "0\n", `no call, no blame: ${fits.finding?.headline ?? fits.stdout}`);
  console.log("    foo blamed for its call, the top level for what it handed over, arity when it crosses");
}

console.log("[functions given back, and given in]");
{
  const misused = ran(`${CALLABLE}def adder(n: int) -> Callable[[int], int]:\n    return lambda x: x + n\n\nplus = adder(1)\nprint(plus("a"))\n`);
  expect(
    misused.finding?.headline === 'The function `adder` returns takes a whole number (`int`), but it was given `"a"`, a string (`str`).' &&
      misused.finding?.lineNumber === 5,
    `a returned function misused: ${misused.finding?.headline} at ${misused.finding?.lineNumber}`,
  );
  const lying = ran(`${CALLABLE}def liar(n: int) -> Callable[[int], int]:\n    return lambda x: "no"\n\nprint(liar(1)(2))\n`);
  expect(
    lying.finding?.headline === '`liar` says the function it returns gives back a whole number (`int`), but it gave back `"no"`, a string (`str`).' &&
      lying.finding?.lineNumber === 2,
    `a returned function that lies: ${lying.finding?.headline} at ${lying.finding?.lineNumber}`,
  );
  const given = ran(`${CALLABLE}def foo(f: Callable[[int], int]) -> int:\n    return f(1)\n\nprint(foo(lambda x: "s"))\n`);
  expect(
    given.finding?.headline === 'The function given to `foo` as `f` should give back a whole number (`int`), but it gave back `"s"`, a string (`str`).' &&
      given.finding?.lineNumber === 4,
    `a function given that lies: ${given.finding?.headline} at ${given.finding?.lineNumber}`,
  );
  // Unannotated, a lambda has no contract of its own: foo's is the only one.
  const lambda = ran(`${CALLABLE}def foo(f: Callable[[str], str]) -> str:\n    return f(1)\n\nfoo(lambda s: s)\n`);
  expect(lambda.error?.facts?.check?.blamed?.name === "foo", `a lambda given: ${JSON.stringify(lambda.error?.facts?.check?.blamed)}`);
  // A union with one function in it chooses it by its first-order check.
  const optional = ran(`${CALLABLE}def opt(f: Callable[[int], int] | None) -> int:\n    return 0 if f is None else f("x")\n\nprint(opt(None))\nopt(lambda x: x)\n`);
  expect(optional.stdout === "0\n" && optional.error?.facts?.check?.blamed?.name === "opt", `or/c: ${optional.stdout} ${JSON.stringify(optional.error?.facts?.check?.blamed)}`);
  // Functions in a list are shared with the caller, so only first-order.
  const items = ran(`${CALLABLE}def apply_all(fs: list[Callable[[int], int]]) -> int:\n    return 0\n\nprint(apply_all([len, 5]))\n`);
  expect(items.finding?.headline === "`apply_all` expects every item in `fs` to be `Callable[[int], int]`, but item 1 is the number 5.", `items: ${items.finding?.headline}`);
  console.log("    returned, given, a lambda, a union, a list of functions");
}

console.log("[recursion, methods, data]");
{
  // A reference inside the function's own body is an obligation too: its
  // own recursive call is blamed on it, where it made it.
  const count = ran("def count(n: int) -> int:\n    if n == 0:\n        return 0\n    return count(str(n - 1))\n\nprint(count(3))\n");
  expect(
    count.finding?.headline === "`count` expects `n` to be a whole number (`int`), but got a string (`str`)." && count.finding?.lineNumber === 4,
    `recursion: ${count.finding?.headline} at ${count.finding?.lineNumber}`,
  );
  expect(count.error?.facts?.check?.blamed?.name === "count", `count blamed: ${JSON.stringify(count.error?.facts?.check?.blamed)}`);
  // And as deep as Python goes without contracts.
  const deep = ran("def deep(n: int) -> int:\n    return 0 if n == 0 else 1 + deep(n - 1)\n\nprint(deep(900))\n");
  expect(deep.stdout === "900\n", `deep recursion: ${deep.stdout} ${deep.finding?.headline ?? ""}`);
  const method = ran('class Dog:\n    def bark(self, times: int) -> str:\n        return "woof" * times\n\nprint(Dog().bark("2"))\n');
  expect(
    method.finding?.headline === "`Dog.bark` expects `times` to be a whole number (`int`), but got a string (`str`)." && method.finding?.lineNumber === 5,
    `a method: ${method.finding?.headline} at ${method.finding?.lineNumber}`,
  );
  // A method has no reference to make its obligation; its boundary makes
  // one with the student's code that called it - past PLL's own, here the
  // table library's.
  const library = ran('class Fixer:\n    def fix(self, n: int) -> int:\n        return n\n\nt = table(["a"], [["x"]])\nt.transform_column("a", Fixer().fix)\n');
  const libraryBlamed = library.error?.facts?.check?.blamed;
  expect(libraryBlamed?.kind === "main" && libraryBlamed?.file === "lab.py" && library.finding?.lineNumber === 6,
    `a method a library calls: ${JSON.stringify(libraryBlamed)} at ${library.finding?.lineNumber}`);
  const TREE =
    "from dataclasses import dataclass\n\n@dataclass\nclass Leaf[T]:\n    value: T\n\n@dataclass\nclass Node[T]:\n" +
    '    left: "BinTree[T]"\n    right: "BinTree[T]"\n\ntype BinTree[T] = Leaf[T] | Node[T]\n\n' +
    "def tree_sum(t: BinTree[float]) -> float:\n    match t:\n        case Leaf(v):\n            return v\n        case Node(l, r):\n            return tree_sum(l) + tree_sum(r)\n\n";
  const good = ran(`${TREE}print(tree_sum(Node(Leaf(1.0), Leaf(2.5))))\n`);
  expect(good.stdout === "3.5\n", `a good tree: ${good.stdout} ${good.finding?.headline ?? ""}`);
  // The caller's tree is wrong, not tree_sum's arithmetic.
  const bad = ran(`${TREE}print(tree_sum(Node(Leaf(1.0), Leaf("x"))))\n`);
  expect(
    bad.finding?.headline === '`tree_sum` expects `t` to be `BinTree[float]`, but `t.right.value` is the string "x".' && bad.finding?.lineNumber === 21,
    `a bad leaf: ${bad.finding?.headline} at ${bad.finding?.lineNumber}`,
  );
  // Setting a field is checked where it is allowed, at advanced; the
  // teaching levels refuse it whatever the value.
  const field = ran('from dataclasses import dataclass\n\n@dataclass\nclass Dog:\n    name: str\n    age: int\n\nd = Dog("Rex", 3)\nd.age = "x"\n', "advanced");
  expect(
    field.finding?.headline === 'The `age` field of `Dog` should be a whole number (`int`), but got `"x"`.' && field.finding?.lineNumber === 9 &&
      field.finding?.howToFix[0] === "Check the value assigned to the `age` field on this line.",
    `a field assigned: ${field.finding?.headline} at ${field.finding?.lineNumber}`,
  );
  console.log("    recursion blamed on itself, 900 deep; a method; a tree to its leaves; a field set");
}

console.log("[annotations that are not types]");
{
  const CASES = [
    ["z = 10\n\ndef func1(x: int) -> z:\n    return x * 2\n", "`func1`'s return annotation, `z`, is a number (10), not a type.", 3],
    ["def func2(x: int) -> 12345:\n    return x * 2\n", "`func2`'s return annotation, `12345`, is a number, not a type.", 1],
    ["z = 10\n\ndef func3(x: z) -> int:\n    return x\n", "The annotation of `x` in `func3`, `z`, is a number (10), not a type.", 3],
    ['def func4(x: int) -> "test":\n    return x * 2\n\nfunc4(1)\n', '`func4`\'s return annotation, `"test"`, names `test`, which is not defined.', 1],
    ['s = "failure"\n\ndef func6(x: int) -> s:\n    return x * 2\n', '`func6`\'s return annotation, `s`, holds the string "failure", not a type.', 3],
    ['def func7():\n    n = "test"\n    def inner(x: int) -> n:\n        return x * 2\n    return inner(3)\n\nfunc7()\n',
      '`func7.inner`\'s return annotation, `n`, holds the string "test", not a type.', 3],
    ["def f(x: len) -> int:\n    return 0\n", "The annotation of `x` in `f`, `len`, is a function, not a type.", 1],
    ["x: 5 = 3\n", "The annotation of `x`, `5`, is a number, not a type.", 1],
    // A name in quotes inside the annotation is looked up at the first check.
    ['def names(xs: list["Dgo"]) -> int:\n    return 0\n\nprint(names([1]))\n', "An annotation of `names` names `Dgo`, which is not defined.", 1],
  ];
  for (const [source, headline, line] of CASES) {
    const got = ran(source);
    expect(got.finding?.errorType === "NotAType" && got.finding?.headline === headline && got.finding?.lineNumber === line,
      `${JSON.stringify(source.split("\n")[0])}: ${got.finding?.headline} at ${got.finding?.lineNumber}`);
  }
  // A name in quotes is looked up when needed, so it may come later.
  const later = ran('def make() -> "Later":\n    return Later()\n\nclass Later:\n    pass\n\nprint(type(make()).__name__)\n');
  expect(later.stdout === "Later\n", `defined further down: ${later.stdout} ${later.finding?.headline ?? ""}`);
  console.log(`    ${CASES.length} annotations refused, and a name in quotes found later`);
}

console.log("[what a contracted function still is]");
{
  const same = ran(`import inspect\n${ADD1}print(inspect.signature(add1))\nfs = [add1 for _ in range(2)]\nprint(fs[0] is fs[1], add1.__name__, add1.__annotations__)\n`);
  expect(
    same.stdout === "(x: int) -> int\nTrue add1 {'x': <class 'int'>, 'return': <class 'int'>}\n",
    `its signature, name and annotations, and one function per reference: ${JSON.stringify(same.stdout)}`,
  );
  // Nothing of PLL's is left in a program PLL could not instrument, but it says so.
  const plain = ran(`${ADD1}print(add1(1))\n`, "raw");
  expect(plain.stdout === "2\n" && !/not checked/.test(plain.stderr), `raw: ${plain.stdout} ${plain.stderr}`);
  console.log("    a signature, a name, one wrapper per reference");
}

console.log("[`Callable` at the student levels, and not at raw]");
{
  const program = "def apply(f: Callable[[int], int]) -> int:\n    return f(1)\n\nprint(apply(lambda x: x + 1))\n";
  for (const level of ["beginner", "intermediate", "advanced"]) {
    const got = ran(program, level);
    expect(got.stdout === "2\n" && got.finding === null, `${level}: ${got.stdout} ${got.finding?.headline ?? ""}`);
  }
  const raw = ran(program, "raw");
  expect(
    raw.finding?.errorType === "NameError" && raw.finding?.howToFix[0] === "Add `from collections.abc import Callable` at the top of the file.",
    `raw is Python: ${raw.finding?.headline} ${JSON.stringify(raw.finding?.howToFix)}`,
  );
  // A prompt line with no file run before it has the level's names too.
  const fresh = JSON.parse(pllCall("_pll_repl_eval", JSON.stringify(["Callable", "contracts-fresh", "beginner"])));
  expect(fresh.error === null && /Callable/.test(fresh.resultRepr ?? ""), `a fresh prompt: ${fresh.error?.message ?? fresh.resultRepr}`);
  console.log("    given at beginner, intermediate and advanced; an import at raw");
}

console.log("[a prompt line calls what the file defined]");
{
  const key = "contracts-prompt";
  pllCall("_pll_run_file", JSON.stringify([ADD1, "lab.py", key, "beginner", false]));
  const bad = JSON.parse(pllCall("_pll_repl_eval", JSON.stringify(['add1("x")', key, "beginner"])));
  expect(bad.error?.errorType === "TypeMismatch" && bad.error?.facts?.check?.blamed?.kind === "main", `the prompt is checked: ${bad.error?.errorType}`);
  const good = JSON.parse(pllCall("_pll_repl_eval", JSON.stringify(["add1(1)", key, "beginner"])));
  expect(good.resultRepr === "2", `and a good call works: ${good.resultRepr}`);
  // A function the file defined, handed over at the prompt: the prompt line
  // is to blame, as a reference in the file would be.
  const handed = `${CALLABLE}${ADD1}def foo(f: Callable[[str], str]) -> int:\n    f("a")\n    return 0\n`;
  pllCall("_pll_run_file", JSON.stringify([handed, "lab.py", key, "beginner", false]));
  const over = JSON.parse(pllCall("_pll_repl_eval", JSON.stringify(["foo(add1)", key, "beginner"])));
  const site = over.error?.facts?.check?.site;
  expect(
    over.error?.facts?.check?.blamed?.kind === "main" && site?.file === "<repl>" && site?.line === 1,
    `handed over at the prompt: ${JSON.stringify(over.error?.facts?.check?.blamed)} ${JSON.stringify(site)}`,
  );
  console.log("    checked, and blamed on the prompt");
}

console.log(passed() ? "\nsmoke-contracts: ok" : "\nsmoke-contracts: FAILED");
if (!passed()) process.exitCode = 1;
