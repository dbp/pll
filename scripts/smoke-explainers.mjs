#!/usr/bin/env node
/**
 * Smoke test for parseLevel + the static-finding explainers.
 *
 * This bundles the relevant TS modules with esbuild on the fly so we don't
 * need a separate build step.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, passed } from "./lib/check.mjs";
import { importSource, ROOT } from "./lib/bundle.mjs";

const mod = await importSource(`
import { parseLevel, levelHeaderProblem } from "./src/common/level";
import { levelHeaderFinding } from "./src/common/analyzers/levelHeaderFinding";
import { explainSyntaxError } from "./src/common/errors/syntaxExplainer";
import { enrichStaticFindings } from "./src/common/analyzers/static/registry";
import { formatFriendlyError } from "./src/common/errorFormatter";
import { findRuntimeFinding } from "./src/common/analyzers/registry";
import { LIBRARY_SIGNATURES } from "./src/common/errors/libraryFacts";

export {
  parseLevel,
  levelHeaderProblem,
  levelHeaderFinding,
  explainSyntaxError,
  enrichStaticFindings,
  formatFriendlyError,
  findRuntimeFinding,
  LIBRARY_SIGNATURES,
};
`);

/**
 * A `PythonError`, as `pythonErrorFrom` builds one from `_pll_error_info`.
 *
 * `frames` are `[file, line, function]`, outermost first; a frame is the
 * student's unless its file is PLL's (`<exec>`) or a library's. The error is
 * at the innermost frame. `facts` are what Python would have learned from
 * the live frames, and `name` among them is the name a `NameError` is about.
 */
function pyError(type, message, frames, { facts = {}, column = null } = {}) {
  const innermost = frames[frames.length - 1] ?? null;
  return {
    errorType: type,
    message,
    traceback: `${type}: ${message}`,
    fileName: innermost?.[0] ?? null,
    lineNumber: innermost?.[1] ?? null,
    column,
    nameToken: facts.name ?? null,
    frames: frames.map(([fileName, line, functionName = "<module>"]) => ({
      fileName,
      line,
      column: null,
      functionName: functionName === "<module>" ? null : functionName,
      user: !/<exec>|site-packages|\/lib\/python|_pytest|pluggy|pll_vendor/.test(fileName),
    })),
    facts,
  };
}

/**
 * The same, from the `Type: message` line a traceback ends with. A
 * `NameError`'s name is taken from its message, as Python does - that part
 * is tested against Python itself, in smoke-typecheck.
 */
function pyErrorLine(errorLine, frames, options = {}) {
  const at = errorLine.indexOf(": ");
  const type = at < 0 ? errorLine : errorLine.slice(0, at);
  const message = at < 0 ? "" : errorLine.slice(at + 2);
  const facts = { ...(options.facts ?? {}) };
  const named =
    /^(?:NameError|UnboundLocalError)$/.test(type) &&
    (/name '(\w+)' is not defined/.exec(message) ?? /cannot access (?:free|local) variable '(\w+)'/.exec(message));
  if (named && facts.name === undefined) facts.name = named[1];
  return pyError(type, message, frames, { ...options, facts });
}

console.log("\n[parseLevel]");
expect(mod.parseLevel("#level raw\nx=1") === "raw", "#level raw");
expect(mod.parseLevel("#level beginner\nx=1") === "beginner", "#level beginner");
expect(mod.parseLevel("# level beginner\nx=1") === "beginner", "# level beginner (with space)");
expect(mod.parseLevel("#level intermediate\nx=1") === "intermediate", "#level intermediate");
expect(mod.parseLevel("#level advanced\nx=1") === "advanced", "#level advanced");
expect(mod.parseLevel("#level  advanced \nx=1") === "advanced", "extra spaces around the name");
expect(mod.parseLevel("\n\n#level beginner\n") === "beginner", "blank lines before header");
// No header at all is `raw`: code written without PLL in mind runs as plain
// Python, and every difference has to be opted into by naming a level.
expect(mod.parseLevel("x = 1") === "raw", "no header defaults to raw");
expect(mod.parseLevel("# random comment\nx=1") === "raw", "non-level comment defaults to raw");
// Exactly one spelling: the bare form and any other casing are not levels.
expect(mod.parseLevel("#beginner\nx=1") === "raw", "the bare #beginner form is gone");
expect(mod.parseLevel("#LEVEL beginner\nx=1") === "raw", "#LEVEL is not #level");
expect(mod.parseLevel("#level Beginner\nx=1") === "raw", "#level Beginner is not a level");
expect(mod.parseLevel("#level expert\nx=1") === "raw", "expert is not a level");
expect(mod.parseLevel("#level\nx=1") === "raw", "a bare #level names nothing");

console.log("[enrichStaticFindings]");
const findings = mod.enrichStaticFindings(
  [
    {
      id: "shadowing",
      error_type: "Shadowing",
      message: "`count` is already defined in an outer scope",
      line_number: 10,
      column: 4,
      name_token: "count",
      scope_kind: "function",
      outer_line_number: 4,
      outer_column: 0,
      outer_scope_kind: "module",
    },
    {
      id: "shadowing-builtin",
      error_type: "Shadowing",
      message: "`list` is the name of a Python built-in",
      line_number: 15,
      column: 0,
      name_token: "list",
      scope_kind: "module",
    },
    {
      id: "reassignment",
      error_type: "Reassignment",
      message: "`total` is assigned more than once in this scope",
      line_number: 6,
      column: 0,
      name_token: "total",
      scope_kind: "module",
      first_line_number: 5,
      first_column: 0,
    },
  ],
  "beginner",
  "test.py",
);

expect(findings.length === 3, "3 findings");
expect(findings[0].errorType === "Shadowing", "shadowing errorType");
expect(findings[0].headline.includes("count"), "shadowing headline mentions name");
expect(
  findings[0].headline.includes("first defined on line 4"),
  "shadowing headline mentions outer line",
);
expect(
  findings[0].headline.includes("the file"),
  "shadowing headline mentions outer scope kind (module -> 'the file')",
);
expect(findings[0].origin === "static", "origin = static");
expect(findings[0].level === "beginner", "level = beginner");
expect(findings[1].headline.includes("built-in"), "shadowing-builtin headline");
expect(findings[2].errorType === "Reassignment", "reassignment errorType");
expect(findings[2].headline.includes("first assigned on line 5"), "reassignment headline mentions first line");
expect(findings[2].howToFix.length >= 2, "reassignment offers at least 2 fixes");
expect(
  findings[2].howToFix.every((fix) => !/comprehension/i.test(fix)),
  "reassignment fixes no longer mention comprehensions",
);
expect(
  findings[2].howToFix.every((fix) => !/#expert/i.test(fix)),
  "reassignment fixes no longer suggest switching to #expert",
);
expect(
  findings[2].howToFix.every((fix) => !/#level advanced/i.test(fix)),
  "reassignment fixes no longer suggest switching to advanced",
);

console.log("[shadowing-library explainer]");
{
  const libFindings = mod.enrichStaticFindings(
    [
      {
        id: "shadowing-library",
        error_type: "Shadowing",
        message: "`circle` is already defined by the image library",
        line_number: 3,
        column: 0,
        name_token: "circle",
        scope_kind: "module",
        library: "image",
      },
      {
        id: "shadowing-library",
        error_type: "Shadowing",
        message: "`table` is already defined by the table library",
        line_number: 8,
        column: 4,
        name_token: "table",
        scope_kind: "function",
        library: "table",
      },
      {
        id: "shadowing-library",
        error_type: "Shadowing",
        message: "`animate` is already defined by the reactor library",
        line_number: 12,
        column: 0,
        name_token: "animate",
        scope_kind: "module",
        library: "reactor",
      },
      {
        // Bootstrap-only harnesses (no pll package registered) label the
        // name "library" generically; the explainer must not crash on it.
        id: "shadowing-library",
        error_type: "Shadowing",
        message: "`circle` is already defined by the library",
        line_number: 15,
        column: 0,
        name_token: "circle",
        scope_kind: "module",
      },
    ],
    "beginner",
    "test.py",
  );
  expect(libFindings.length === 4, "4 shadowing-library findings");
  expect(libFindings[0].errorType === "Shadowing", "shadowing-library errorType");
  expect(
    libFindings[0].headline.includes("`circle` is already defined by the image library"),
    "image library headline names the library",
  );
  expect(
    libFindings[1].headline.includes("table library"),
    "table library headline",
  );
  expect(
    libFindings[2].headline.includes("reactor library"),
    "reactor library headline",
  );
  expect(
    libFindings[3].headline.includes("PLL libraries"),
    "missing library label falls back to 'the PLL libraries'",
  );
  expect(
    libFindings[0].howToFix.length >= 2,
    "shadowing-library offers at least 2 fixes",
  );
  expect(
    libFindings[0].howToFix.some((fix) => fix.includes("my_circle")),
    "fix suggests a concrete alternative name",
  );
  expect(libFindings[0].origin === "static", "origin = static");
  expect(libFindings[0].level === "beginner", "level = beginner");

  // The friendly CLI/error formatter renders it like any other finding.
  const lines = mod.formatFriendlyError(libFindings[0]);
  expect(lines[0].startsWith("Shadowing:"), "first line is errorType + headline");
  expect(lines.some((l) => l.includes("at test.py:3:1")), "shows location");
  expect(lines.some((l) => l.includes("How to fix:")), "shows How to fix section");
}

console.log("[explainers omit line 0 for preexisting session bindings]");
{
  const preexisting = mod.enrichStaticFindings(
    [
      {
        id: "reassignment",
        error_type: "Reassignment",
        message: "`x` is assigned more than once in this scope",
        line_number: 1,
        column: 0,
        name_token: "x",
        scope_kind: "module",
        first_line_number: 0,
        first_column: 0,
      },
      {
        id: "shadowing",
        error_type: "Shadowing",
        message: "`x` is already defined in an outer scope",
        line_number: 2,
        column: 4,
        name_token: "x",
        scope_kind: "function",
        outer_line_number: 0,
        outer_column: 0,
        outer_scope_kind: "module",
      },
    ],
    "beginner",
    "<repl>",
  );
  expect(
    !preexisting[0].headline.includes("line 0"),
    "reassignment headline omits first assigned on line 0",
  );
  expect(
    !preexisting[1].headline.includes("line 0"),
    "shadowing headline omits first defined on line 0",
  );
  expect(
    preexisting[1].headline.includes("the file"),
    "shadowing still mentions the outer scope",
  );
}

console.log("[disallowed-keyword explainer - global at intermediate]");
const kwFindings = mod.enrichStaticFindings(
  [
    {
      id: "disallowed-keyword",
      error_type: "DisallowedKeyword",
      message: "`global` is not allowed at the intermediate level",
      line_number: 8,
      column: 4,
      name_token: "counter",
      scope_kind: "function",
      keyword: "global",
      names: ["counter"],
    },
    {
      id: "disallowed-keyword",
      error_type: "DisallowedKeyword",
      message: "`nonlocal` is not allowed at the intermediate level",
      line_number: 14,
      column: 8,
      name_token: "n",
      scope_kind: "function",
      keyword: "nonlocal",
      names: ["n"],
    },
  ],
  "intermediate",
  "intermediate_keyword.py",
);
expect(kwFindings.length === 2, "two keyword findings");
expect(
  kwFindings[0].errorType === "DisallowedKeyword",
  "errorType is DisallowedKeyword",
);
expect(
  kwFindings[0].headline.includes("`global`"),
  "global headline mentions the keyword",
);
expect(
  kwFindings[0].headline.includes("intermediate"),
  "global headline mentions level",
);
expect(
  kwFindings[1].headline.includes("`nonlocal`"),
  "nonlocal headline mentions the keyword",
);
expect(
  kwFindings[0].howToFix.length >= 2,
  "global has at least 2 fix suggestions",
);
expect(
  kwFindings[0].howToFix.some((fix) => fix.includes("argument")),
  "global suggests passing as an argument",
);
expect(
  kwFindings[1].howToFix.some((fix) => fix.toLowerCase().includes("return")),
  "nonlocal suggests returning a value",
);

console.log("[formatFriendlyError - shadowing-builtin]");
const lines = mod.formatFriendlyError(findings[1]);
expect(lines[0].startsWith("Shadowing:"), "first line is errorType + headline");
expect(lines.some((l) => l.includes("at test.py:15:1")), "shows location");
expect(lines.some((l) => l.includes("How to fix:")), "shows How to fix section");

console.log("[name errors: a name with no value is named, not called `this name`]");
{
  /** Build a finding from a traceback the way the hosts do. */
  const finding = (error, source) =>
    mod.findRuntimeFinding(source, "lab.py", "beginner", error);

  // The Lab 10 shape: an inner function reads a name the enclosing function
  // assigns later. Only `name 'x' is not defined` was matched before, so the
  // name was unknown and the report read "Python doesn't know what `this
  // name` means" - four times over, in a file where `title` is right there.
  const free = finding(
    pyErrorLine(
      "NameError: cannot access free variable 'title' where it is not associated with a value",
      [["lab.py", 3, "inner"]],
      { column: 15 },
    ),
    "def outer():\n    def inner():\n        return title\n    inner()\n    title = 1\n",
  );
  expect(free !== null, "a free-variable NameError should be explained");
  expect(free.nameToken === "title", `the name should be found, got ${free.nameToken}`);
  expect(/`title`/.test(free.headline), `the headline should name it: ${free.headline}`);
  expect(!/this name/.test(free.headline + free.howToFix.join(" ")), "no placeholder anywhere");
  // A name spelled correctly needs advice about order, not spelling.
  expect(
    !free.howToFix.some((line) => /spelling/.test(line)),
    `spelling advice is wrong here: ${JSON.stringify(free.howToFix)}`,
  );
  expect(
    free.howToFix.some((line) => /Move the line that sets/.test(line)),
    `expected advice about order: ${JSON.stringify(free.howToFix)}`,
  );

  // `UnboundLocalError` is the same mistake under a different type, and was
  // not handled at all - it fell through to a bare traceback.
  const local = finding(
    pyErrorLine(
      "UnboundLocalError: cannot access local variable 'count' where it is not associated with a value",
      [["lab.py", 2, "f"]],
      { column: 10 },
    ),
    "def f():\n    print(count)\n    count = 1\n",
  );
  expect(local !== null, "an UnboundLocalError should be explained too");
  expect(local.nameToken === "count", `the name should be found, got ${local.nameToken}`);
  expect(local.errorType === "UnboundLocalError", `keep Python's type: ${local.errorType}`);
  expect(
    local.howToFix.some((line) => /local to the whole function/.test(line)),
    `expected the assigning-makes-it-local note: ${JSON.stringify(local.howToFix)}`,
  );

  // A genuinely unknown name still gets the spelling advice.
  const unknown = finding(
    pyErrorLine("NameError: name 'Totl' is not defined", [["lab.py", 1]], { column: 6 }),
    "print(Totl)\n",
  );
  expect(unknown.nameToken === "Totl", `got ${unknown.nameToken}`);
  expect(/doesn't know what `Totl`/.test(unknown.headline), `headline: ${unknown.headline}`);
  expect(
    unknown.howToFix.some((line) => /spelling/.test(line)),
    "an unknown name does want the spelling check",
  );
  console.log("    free, local and unknown names each named and advised correctly");
}

console.log("[a #level line that names nothing valid is an error, not silence]");
{
  // Absence stays silent, so ordinary Python runs as ordinary Python. But a
  // line that *asked* for a level and did not get one used to run at raw
  // with every expected check gone and nothing said.
  // Returns `{ message, line, howToFix }` or null, so the finding can blame
  // the line the header is actually on.
  const problem = (header) => mod.levelHeaderProblem(`${header}\nx = 1\n`)?.message ?? null;

  expect(problem("#level beginner") === null, "a valid header is fine");
  expect(problem("# level advanced") === null, "a space after the hash is fine");
  expect(problem("#level raw") === null, "raw is a level like any other");
  // Absence, and anything that is not trying to be a header, stay silent.
  expect(problem("x = 1") === null, "no header at all is not an error");
  expect(problem("# my lab 1") === null, "an ordinary comment is not an error");
  expect(problem("#levels of abstraction") === null, "nor is a comment about levels");
  expect(problem("") === null, "nor is an empty file");

  const typo = problem("#level begginer");
  expect(/not a level/.test(typo ?? ""), `a misspelling is an error: ${typo}`);
  expect(/Did you mean `beginner`/.test(typo ?? ""), `with a suggestion: ${typo}`);
  // Case matters for acceptance, so a capital is a misspelling - and worth
  // guessing at rather than listing every level.
  expect(/Did you mean `beginner`/.test(problem("#level Beginner") ?? ""),
    `a capital should suggest the lower-case name: ${problem("#level Beginner")}`);
  // Nothing close enough to guess: list them instead of inventing one.
  const far = problem("#level easy");
  expect(/not a level/.test(far ?? "") && !/Did you mean/.test(far ?? ""),
    `an unrelated word gets the list, not a guess: ${far}`);
  expect(/needs a level after it/.test(problem("#level") ?? ""),
    `a bare #level says what is missing: ${problem("#level")}`);
  // One character away from working, and silent before.
  expect(/needs a space before `beginner`/.test(problem("#levelbeginner") ?? ""),
    `a missing space is named: ${problem("#levelbeginner")}`);

  // A valid header below the top of the file does nothing at all, which is
  // the commonest way to lose a level entirely: a comment gets added above
  // it. Reported, and blamed on its own line rather than on line 1.
  const misplaced = mod.levelHeaderProblem("# my lab 1\n#level beginner\nx = 1\n");
  expect(misplaced !== null, "a header below the top should be reported");
  expect(misplaced.line === 2, `blamed on the header's own line, got ${misplaced?.line}`);
  expect(/only counts on the first line/.test(misplaced.message), `message: ${misplaced.message}`);
  const afterSeveral = mod.levelHeaderProblem(
    "# name\n# date\n\n#level intermediate\nx = 1\n",
  );
  expect(afterSeveral?.line === 4, `found past several comments, got ${afterSeveral?.line}`);
  // Below code too, anywhere in the file - but only on a line that is a
  // comment. A `#level` line inside a docstring is text, and erroring on a
  // string literal would be worse than missing a misplaced header.
  expect(
    mod.levelHeaderProblem('x = 1\n"""\n#level beginner\n"""\n') === null,
    "a #level inside a docstring is not a misplaced header",
  );
  const lines = (code) => mod.levelHeaderProblem(code)?.line ?? null;
  const underCode = mod.levelHeaderProblem("x = 1\n#level beginner\n");
  expect(underCode?.line === 2, `a header under code is reported: ${underCode?.line}`);
  expect(/above the code/.test(underCode?.howToFix[0] ?? ""), `and moved above it: ${underCode?.howToFix[0]}`);
  expect(lines('"""Lab 1."""\n#level beginner\n') === 2, "under a module docstring");
  expect(lines("x = 1  # a\n'''\n#level beginner\n'''\n#level beginner\n") === 5,
    "past a docstring, at the line that is a comment");
  expect(lines("x = '#level beginner'\n") === null, "not inside a one-line string");
  expect(lines('s = """\n#level beginner"""\n') === null, "not in a string that closes on that line");
  expect(lines('x = "a\\"b"\n#level beginner\n') === 2, "an escaped quote does not open a string");
  expect(lines('x = 1  # """\n#level beginner\n') === 2, "quotes in a comment do not either");
  expect(lines("x = 1\n# level 2 of the game\n") === null, "an ordinary comment further down is not one");
  expect(lines("#level beginner\nx = 1\n#level advanced\n") === null, "a file with a header on top is fine");
  expect(
    mod.levelHeaderProblem("# just a note\n# another\nx = 1\n") === null,
    "comments with no header at all stay silent",
  );

  // And it becomes a finding that stops the run, at any level - there is no
  // level to consult, which is the problem.
  const finding = mod.levelHeaderFinding("#level begginer\nx = 1\n", "lab.py", "raw");
  expect(finding !== null, "a broken header should produce a finding");
  expect(finding.errorType === "Level", `errorType: ${finding.errorType}`);
  expect(finding.lineNumber === 1, `blamed on the header line: ${finding.lineNumber}`);
  expect(finding.severity === "error", "it has to stop the run");
  expect(mod.levelHeaderFinding("x = 1\n", "lab.py", "raw") === null,
    "a file with no header produces no finding");
  console.log("    valid headers and comments silent; broken and misplaced ones named");
}

console.log("[syntax errors: Python's wording where it is clear, better where it is not]");
{
  const explain = (type, message, line) => mod.explainSyntaxError(type, message, line);

  // Python names the token that finally failed to parse, not the mistake:
  // `else if` parses `else` and then wants its colon.
  const elseIf = explain("SyntaxError", "expected ':'", "else if x > 1:");
  expect(/spells this `elif`/.test(elseIf.headline), `else if: ${elseIf.headline}`);

  // Python suggests `==` *or* `:=`. The walrus is not something this course
  // teaches, and offering it invites a second mistake.
  const ifEq = explain(
    "SyntaxError",
    "invalid syntax. Maybe you meant '==' or ':=' instead of '='?",
    "if x = 5:",
  );
  expect(/needs `==`/.test(ifEq.headline), `if x = 5: ${ifEq.headline}`);
  expect(!/:=/.test(ifEq.headline + ifEq.howToFix.join(" ")), "never suggest the walrus");

  // `assert f(1) = 1` does not even reach Python's suggestion - the left
  // side is a call, which cannot be assigned to, so Python just gives up
  // with "invalid syntax".
  const assertEq = explain("SyntaxError", "invalid syntax", "assert f(1) = 1");
  expect(/compares with `==`/.test(assertEq.headline), `assert with =: ${assertEq.headline}`);

  const keyword = explain("SyntaxError", "invalid syntax", "class = 30");
  expect(/`class` is a word Python reserves/.test(keyword.headline), `keyword: ${keyword.headline}`);
  // An ordinary name must not be mistaken for a keyword.
  const ordinary = explain("SyntaxError", "invalid syntax", "classes = 30");
  expect(!/reserves/.test(ordinary.headline), `a normal name is not a keyword: ${ordinary.headline}`);

  const curly = explain("SyntaxError", "invalid character '“' (U+201C)", 'print(“hi”)');
  expect(/not a character Python can read/.test(curly.headline), `curly: ${curly.headline}`);
  expect(
    curly.howToFix.some((l) => /straight quotes/.test(l)),
    `and says why: ${JSON.stringify(curly.howToFix)}`,
  );

  const tab = explain("TabError", "inconsistent use of tabs and spaces in indentation", "\ty = 2");
  expect(/mixes tabs and spaces/.test(tab.headline), `tab: ${tab.headline}`);
  expect(
    tab.howToFix.some((l) => /Convert Indentation to Spaces/.test(l)),
    "and names the command that fixes it",
  );

  const ret = explain("SyntaxError", "'return' outside function", "return 5");
  expect(/only works inside a function/.test(ret.headline), `return: ${ret.headline}`);

  // Already clear, so it is left alone - only punctuated.
  const clear = explain("SyntaxError", "'(' was never closed", 'print("hi"');
  expect(clear.headline === "'(' was never closed.", `kept verbatim: ${clear.headline}`);
  expect(clear.howToFix.length === 0, "with nothing invented to add");
  const colon = explain("SyntaxError", "expected ':'", "if x > 3");
  expect(colon.headline === "expected ':'.", `kept verbatim: ${colon.headline}`);
  console.log("    seven rewordings, and the clear ones left as Python wrote them");
}

console.log("[stock messages: Python's own wording replaced with the course's]");
{
  /** Build a finding the way the hosts do, from a traceback and the file. */
  const finding = (error, source) =>
    mod.findRuntimeFinding(source, "lab.py", "beginner", error);

  /** A one-frame traceback pointing at `line` of `source`. */
  const raised = (source, line, fn, errorLine) =>
    finding(pyErrorLine(errorLine, [["<exec>", 560, "run"], ["lab.py", line, fn]]), source);

  /** Nothing a student never typed should ever reach them. */
  const INTERNALS = [/__init__/, /types\.UnionType/, /__pll_test__/, /_Rectangle/, /NoneType/];
  const noInternals = (f, label) => {
    const text = `${f.headline} ${f.howToFix.join(" ")}`;
    for (const pattern of INTERNALS) {
      expect(!pattern.test(text), `${label} must not mention ${pattern}: ${text}`);
    }
  };

  // -- argument counts, which Python states without saying the total ------
  const pens = "def pen_cost(num_pens: int, message: str) -> float:\n    return num_pens * 2.5\n\n\nprint(pen_cost(3))\n";
  const tooFew = raised(
    pens,
    5,
    "<module>",
    "TypeError: pen_cost() missing 1 required positional argument: 'message'",
  );
  expect(
    tooFew.headline === "`pen_cost` takes 2 arguments (`num_pens` and `message`), but got 1.",
    `too few args: ${tooFew.headline}`,
  );

  const ship = "def add_shipping(order_amt: float) -> float:\n    return order_amt + 5\n\n\nadd_shipping(10, 2)\n";
  const tooMany = raised(
    ship,
    5,
    "<module>",
    "TypeError: add_shipping() takes 1 positional argument but 2 were given",
  );
  expect(
    tooMany.headline === "`add_shipping` takes 1 argument (`order_amt`), but got 2.",
    `too many args: ${tooMany.headline}`,
  );

  // A library function has no `def` in the file, but PLL knows its own
  // contract, so the total is named just as it is for the student's.
  const lib = "from pll.image import circle\n\ncircle(50)\n";
  const missing = raised(
    lib,
    3,
    "<module>",
    "TypeError: circle() missing 2 required positional arguments: 'mode' and 'color'",
  );
  expect(
    missing.headline === "`circle` takes 3 arguments (`radius`, `mode` and `color`), but got 1.",
    `library call: ${missing.headline}`,
  );

  // A function from somewhere else entirely: only what Python named.
  const foreign = raised(
    "from helpers import prep\n\nprep(1)\n",
    3,
    "<module>",
    "TypeError: prep() missing 2 required positional arguments: 'b' and 'c'",
  );
  expect(
    foreign.headline === "`prep` needs 2 more arguments: `b` and `c`.",
    `unknown function: ${foreign.headline}`,
  );

  // A test with a parameter never runs at all; pytest cannot supply one.
  const testArg = raised(
    "def test_pen_cost(n: int) -> None:\n    assert n == 1\n",
    1,
    "<module>",
    "TypeError: test_pen_cost() missing 1 required positional argument: 'n'",
  );
  expect(
    /is a test, so it cannot take any parameters/.test(testArg.headline),
    `test parameter: ${testArg.headline}`,
  );

  // A method of PLL's own libraries: Python names the class the student
  // never typed (`Table.scatter_plot()` for `movies.scatter_plot(...)`).
  const method = raised(
    'from pll.table import table\n\nmovies = table(["x", "y"], [[1, 2]])\nmovies.scatter_plot("x")\n',
    4,
    "<module>",
    "TypeError: Table.scatter_plot() missing 1 required positional argument: 'y'",
  );
  expect(
    method.headline === "`scatter_plot` takes 2 arguments (`x` and `y`), but got 1.",
    `method call: ${method.headline}`,
  );
  expect(!/Table\./.test(method.headline), "and drops the class the student never wrote");

  // -- dataclasses, where Python names an `__init__` nobody wrote --------
  const song =
    "from dataclasses import dataclass\n\n\n@dataclass\nclass ITunesSong:\n    name: str\n    singer: str\n    year: int\n\n\ns = ITunesSong(\"Yesterday\", \"The Beatles\")\n";
  const dcFew = raised(
    song,
    11,
    "<module>",
    "TypeError: ITunesSong.__init__() missing 1 required positional argument: 'year'",
  );
  expect(
    dcFew.headline === "`ITunesSong` needs 3 values (`name`, `singer` and `year`), but got 2.",
    `dataclass too few: ${dcFew.headline}`,
  );
  noInternals(dcFew, "dataclass too few");

  const dcMany = raised(
    song,
    11,
    "<module>",
    "TypeError: ITunesSong.__init__() takes 4 positional arguments but 5 were given",
  );
  expect(
    dcMany.headline === "`ITunesSong` needs 3 values (`name`, `singer` and `year`), but got 4.",
    `dataclass too many: ${dcMany.headline}`,
  );
  noInternals(dcMany, "dataclass too many");

  const typo = raised(
    song.replace('s = ITunesSong("Yesterday", "The Beatles")', "print(s.yaer)"),
    11,
    "<module>",
    "AttributeError: 'ITunesSong' object has no attribute 'yaer'",
  );
  expect(
    typo.headline ===
      "`ITunesSong` has no field `yaer` (its fields are `name`, `singer` and `year`).",
    `field typo: ${typo.headline}`,
  );
  expect(
    typo.howToFix.some((l) => /Did you mean `year`\?/.test(l)),
    `and suggests the right one: ${JSON.stringify(typo.howToFix)}`,
  );

  const brackets = raised(
    song.replace('s = ITunesSong("Yesterday", "The Beatles")', 'print(s["year"])'),
    11,
    "<module>",
    "TypeError: 'ITunesSong' object is not subscriptable",
  );
  expect(
    /Square brackets do not get a field out of `ITunesSong`/.test(brackets.headline),
    `dataclass brackets: ${brackets.headline}`,
  );
  expect(
    // Their own subscript, `s["year"]`, turned into `s.year`.
    brackets.howToFix.some((l) => /`s\.year` rather than `s\["year"\]`/.test(l)),
    `and shows the dot form: ${JSON.stringify(brackets.howToFix)}`,
  );

  // -- loops, conversions and comparisons --------------------------------
  const loop = "def total(nums: list[int]) -> int:\n    out = 0\n    for item in len(nums):\n        out = out + item\n    return out\n";
  const rangeLen = raised(loop, 3, "total", "TypeError: 'int' object is not iterable");
  expect(
    rangeLen.headline === "`len(nums)` is a number, and a number is not something to loop over.",
    `for over len: ${rangeLen.headline}`,
  );
  expect(
    rangeLen.howToFix.some((l) => /for item in nums:/.test(l)),
    `and shows the fix: ${JSON.stringify(rangeLen.howToFix)}`,
  );

  const concat = raised(
    'n = 1\nprint("total: " + n)\n',
    2,
    "<module>",
    'TypeError: can only concatenate str (not "int") to str',
  );
  expect(
    concat.headline === "A string and a whole number cannot be added together.",
    `concat: ${concat.headline}`,
  );
  expect(
    // Their own literal and name: `print("total: " + n)` becomes this.
    concat.howToFix.some((l) => /`print\("total:", n\)`/.test(l)),
    `and offers commas in print: ${JSON.stringify(concat.howToFix)}`,
  );

  // A method that changes something in place returns None, which a
  // beginner has no way to guess from "'NoneType' and 'int'".
  const none = raised(
    "def deposit(acct, amt):\n    acct.balance = acct.balance + amt\n\n\nprint(deposit(acct1, 50) + 1)\n",
    5,
    "<module>",
    "TypeError: unsupported operand type(s) for +: 'NoneType' and 'int'",
  );
  expect(
    none.headline === "`deposit(...)` gave back `None`, so `+` cannot be used on it.",
    `None arithmetic: ${none.headline}`,
  );
  noInternals(none, "None arithmetic");

  const compare = raised(
    'if "999" < 1000:\n    print("yes")\n',
    1,
    "<module>",
    "TypeError: '<' not supported between instances of 'str' and 'int'",
  );
  expect(
    compare.headline === "`<` cannot compare a string with a whole number.",
    `comparison: ${compare.headline}`,
  );

  const badInt = raised(
    'n = int("nineteen")\n',
    1,
    "<module>",
    "ValueError: invalid literal for int() with base 10: 'nineteen'",
  );
  expect(
    badInt.headline === '`int` cannot turn "nineteen" into a whole number.',
    `int literal: ${badInt.headline}`,
  );
  const blank = raised(
    'rides = load_table("rides.csv")\nn = int(rides.row(0)["riders"])\n',
    2,
    "<module>",
    "ValueError: invalid literal for int() with base 10: ''",
  );
  expect(
    blank.howToFix.some((l) => /blank cell/.test(l) && /empty/.test(l)),
    `a blank cell is called out: ${JSON.stringify(blank.howToFix)}`,
  );

  const index = raised(
    "nums = [1, 2, 3]\nprint(nums[3])\n",
    2,
    "<module>",
    "IndexError: list index out of range",
  );
  expect(index.headline === "`nums` has no item at that position.", `index: ${index.headline}`);
  // Without the real length (no `->` line from Python), no made-up list
  // either - "a list of 3 items" read as a claim about theirs.
  expect(
    index.howToFix.some((l) => /len\(\.\.\.\) - 1/.test(l)) &&
      index.howToFix.some((l) => /len\(nums\)/.test(l)) &&
      !index.howToFix.some((l) => /list of 3/.test(l)),
    `and explains numbering: ${JSON.stringify(index.howToFix)}`,
  );

  // -- calls that are not calls ------------------------------------------
  const times = raised(
    "width = 4\nprint(3(width))\n",
    2,
    "<module>",
    "TypeError: 'int' object is not callable",
  );
  expect(
    /Brackets after `3` look like a function call, not multiplication/.test(times.headline),
    `missing star: ${times.headline}`,
  );
  expect(
    times.howToFix.some((l) => /3 \* /.test(l)),
    `and shows the star: ${JSON.stringify(times.howToFix)}`,
  );

  const union =
    "Animal = Boa | Armadillo\n\n\ndef make():\n    return Animal(\"Slithers\")\n";
  const unionCall = raised(union, 5, "make", "TypeError: 'types.UnionType' object is not callable");
  expect(
    unionCall.headline === "`Animal` is a union of several types, not something to make one of.",
    `union call: ${unionCall.headline}`,
  );
  expect(
    unionCall.howToFix.some((l) => /`Boa` and `Armadillo`/.test(l)),
    `and names the members: ${JSON.stringify(unionCall.howToFix)}`,
  );
  noInternals(unionCall, "union call");

  // -- match patterns ----------------------------------------------------
  const boa =
    "from dataclasses import dataclass\n\n\n@dataclass\nclass Boa:\n    name: str\n    length: int\n\n\ndef describe(a):\n    match a:\n        case Boa(name, length, extra):\n            return name\n";
  const pattern = raised(
    boa,
    12,
    "describe",
    "TypeError: Boa() accepts 2 positional sub-patterns (3 given)",
  );
  expect(
    pattern.headline === "`Boa` has 2 fields (`name` and `length`), but this pattern names 3.",
    `pattern arity: ${pattern.headline}`,
  );
  expect(
    pattern.howToFix.some((l) => /case Boa\(name, length\):/.test(l)),
    `and shows the shape: ${JSON.stringify(pattern.howToFix)}`,
  );

  // -- recursion, where the traceback itself names the culprit -----------
  const recursion = finding(
    pyErrorLine("RecursionError: maximum recursion depth exceeded", [
      ["lab.py", 6],
      ...Array.from({ length: 40 }, () => ["lab.py", 3, "my_len"]),
    ]),
    "def my_len(nums):\n    if nums == []:\n        return 1 + my_len(nums)\n    return 0\n\n\nprint(my_len([1, 2, 3]))\n",
  );
  expect(
    recursion.headline === "`my_len` kept calling itself and never stopped.",
    `recursion: ${recursion.headline}`,
  );
  expect(
    recursion.howToFix.some((l) => /something smaller/.test(l)),
    `and says what is missing: ${JSON.stringify(recursion.howToFix)}`,
  );

  // -- pandas, whose KeyError arrives through a wall of internals --------
  const pandas = finding(
    pyErrorLine("KeyError: 'ratings'", [
      ["lab.py", 4],
      ["/lib/python3.13/site-packages/pandas/core/frame.py", 4102, "__getitem__"],
    ]),
    'import pandas as pd\n\nmovies = pd.DataFrame({"title": [], "rating": []})\nprint(movies["ratings"].mean())\n',
  );
  expect(
    pandas.headline === "There is no column named `ratings`.",
    `pandas key: ${pandas.headline}`,
  );
  expect(
    pandas.howToFix.some((l) => /print\(movies\.columns\)/.test(l)),
    `and says how to see them: ${JSON.stringify(pandas.howToFix)}`,
  );
  expect(pandas.lineNumber === 4, `blamed at the student's line, got ${pandas.lineNumber}`);

  // A student file *named* `pandas.py` is not pandas. `samples/pandas.py`
  // is a real file in this repo, and a plain dict `KeyError` in it was
  // being reported as a missing DataFrame column.
  const notPandas = finding(
    pyErrorLine("KeyError: 'bob'", [["pandas.py", 2]]),
    'ages = {"alice": 30}\nprint(ages["bob"])\n',
  );
  expect(
    !/no column named/.test(notPandas.headline),
    `a dict in a file named pandas.py is not a DataFrame: ${notPandas.headline}`,
  );

  // -- a class passed where one of its instances was wanted --------------
  const classItself = finding(
    pyErrorLine(
      'TypeCheckError: argument "s" (class __pll_test__.ITunesSong) is not an instance of __pll_test__.ITunesSong',
      [["lab.py", 12], ["lab.py", 11, "title"]],
    ),
    song + "\n\ndef title(s: ITunesSong) -> str:\n    return s.name\n\n\nprint(title(ITunesSong))\n",
  );
  expect(
    /the class `ITunesSong` itself/.test(classItself.headline),
    `class not instance: ${classItself.headline}`,
  );
  expect(
    classItself.howToFix.some((l) => /blueprint/.test(l)),
    `and says what the brackets do: ${JSON.stringify(classItself.howToFix)}`,
  );
  noInternals(classItself, "class not instance");

  // The class used where one of its values was meant. "type object" is
  // Python's phrase for this and means nothing to a student.
  const onClass = raised(
    song.replace('s = ITunesSong("Yesterday", "The Beatles")', "print(ITunesSong.name)"),
    11,
    "<module>",
    "AttributeError: type object 'ITunesSong' has no attribute 'name'",
  );
  expect(
    onClass.headline ===
      "`ITunesSong` on its own is the class, not one made from it, so it has no `name`.",
    `attribute on the class: ${onClass.headline}`,
  );
  expect(
    onClass.howToFix.some((l) => /`ITunesSong\(\.\.\.\)` makes one/.test(l)),
    `and says how to make one: ${JSON.stringify(onClass.howToFix)}`,
  );
  expect(!/type object/.test(onClass.headline), "and drops Python's `type object`");

  // A function passed by calling it. The call happens before `filter` is
  // entered, so Python's message names neither `filter` nor the brackets.
  const called = raised(
    't = table(["riders"], [[1]])\n\n\ndef below_1k(r):\n    return r["riders"] < 1000\n\n\nt.filter(below_1k())\n',
    8,
    "<module>",
    "TypeError: below_1k() missing 1 required positional argument: 'r'",
  );
  expect(
    called.headline === "`filter` calls `below_1k` for you, so it needs the function itself.",
    `function called not passed: ${called.headline}`,
  );
  expect(
    called.howToFix.some((l) => /Leave the brackets off: `filter\(below_1k\)`/.test(l)),
    `and shows the call without them: ${JSON.stringify(called.howToFix)}`,
  );

  // An unrelated empty call that merely shares a line with a taker is not
  // a function passed by mistake.
  const beside = raised(
    't = table(["riders"], [[1]])\n\n\ndef keep(r):\n    return True\n\n\ndef total(n):\n    return n\n\n\nprint(t.filter(keep), total())\n',
    12,
    "<module>",
    "TypeError: total() missing 1 required positional argument: 'n'",
  );
  expect(
    !/calls `total` for you/.test(beside.headline),
    `an unrelated call must not be blamed on filter: ${beside.headline}`,
  );
  expect(
    /`total` takes 1 argument \(`n`\), but got 0/.test(beside.headline),
    `it is just a missing argument: ${beside.headline}`,
  );

  // A reactor handler, where the fix is written with `=` rather than a call.
  const handler = raised(
    "def draw(s):\n    return s\n\n\nreactor(init=1, to_draw=draw())\n",
    5,
    "<module>",
    "TypeError: draw() missing 1 required positional argument: 's'",
  );
  expect(
    handler.howToFix.some((l) => /`to_draw=draw`/.test(l)),
    `a handler is set, not called: ${JSON.stringify(handler.howToFix)}`,
  );

  // `table` with the wrong number of arguments: the parameter names do not
  // say the shape, so the hint does.
  const noColumns = raised(
    't = table([["Jan", 1121]])\n',
    1,
    "<module>",
    "TypeError: table() missing 1 required positional argument: 'rows'",
  );
  expect(
    noColumns.headline === "`table` takes 2 arguments (`columns` and `rows`), but got 1.",
    `table arity: ${noColumns.headline}`,
  );
  expect(
    noColumns.howToFix.some((l) => /column names come first/.test(l)),
    `and says what shape they are: ${JSON.stringify(noColumns.howToFix)}`,
  );

  // Two rows with no comma between them, which Python reports as a lookup.
  const comma = raised(
    't = table(["month"], [["Jan"] ["Feb"]])\n',
    1,
    "<module>",
    "TypeError: list indices must be integers or slices, not tuple",
  );
  expect(
    comma.headline === "A comma is missing between two values in a list.",
    `missing comma: ${comma.headline}`,
  );

  // A class with fields and no `@dataclass`. Python says it "takes no
  // arguments", which is true and says nothing about the decorator.
  const noDecorator = raised(
    "class ITunesSong:\n    name: str\n    singer: str\n    year: int\n\n\ns = ITunesSong(\"a\", \"b\", 1)\n",
    7,
    "<module>",
    "TypeError: ITunesSong() takes no arguments",
  );
  expect(
    /lists fields \(`name`, `singer` and `year`\) but has no `@dataclass`/.test(
      noDecorator.headline,
    ),
    `missing @dataclass: ${noDecorator.headline}`,
  );
  expect(
    noDecorator.howToFix.some((l) => /`@dataclass` on the line above `class ITunesSong`/.test(l)),
    `and says where it goes: ${JSON.stringify(noDecorator.howToFix)}`,
  );

  // A column a discarded `add_column` would have made. The error is right
  // and arrives several lines after the line that explains it.
  const discarded = raised(
    'employees = table(["name"], [["Harley"]])\nemployees.add_column("total-wage", lambda r: 1)\nemployees.select_columns(["total-wage"])\n',
    3,
    "<module>",
    'KeyError: \'the table has no column "total-wage" (it has: name).\'',
  );
  expect(
    discarded.headline === "`add_column` makes a new table; it does not change `employees`.",
    `a discarded result: ${discarded.headline}`,
  );
  expect(
    discarded.howToFix.some((l) => /employees = employees\.add_column\(\.\.\.\)/.test(l)),
    `and shows how to keep it: ${JSON.stringify(discarded.howToFix)}`,
  );

  // A column that was simply never there keeps PLL's own message.
  const plain = raised(
    'employees = table(["name"], [["Harley"]])\nemployees.select_columns(["wage"])\n',
    2,
    "<module>",
    'KeyError: \'the table has no column "wage" (it has: name).\'',
  );
  expect(
    /has no column "wage"/.test(plain.headline),
    `a genuinely missing column is left alone: ${plain.headline}`,
  );

  // A misspelled column in a method whose result is discarded is still
  // just a misspelling. `order_by` cannot make a column, and matching the
  // failing line against itself turned a typo into a lecture on mutation.
  for (const [label, source, line] of [
    [
      "order_by",
      'shuttle = table(["month", "riders"], [["Jan", 1121]])\nshuttle.order_by("rider")\n',
      2,
    ],
    [
      "select_columns",
      'shuttle = table(["month", "riders"], [["Jan", 1121]])\nshuttle.select_columns(["rider"])\n',
      2,
    ],
    [
      "filter on a discarded result",
      'shuttle = table(["month", "riders"], [["Jan", 1121]])\nshuttle.transform_column("rider", int)\n',
      2,
    ],
  ]) {
    const typo = raised(
      source,
      line,
      "<module>",
      'KeyError: \'the table has no column "rider" (it has: month, riders). Did you mean "riders"?\'',
    );
    expect(
      /has no column "rider"/.test(typo.headline) && !/makes a new table/.test(typo.headline),
      `${label}: a misspelling must stay a misspelling, got ${typo.headline}`,
    );
  }

  // And an `add_column` whose result *was* kept explains nothing either.
  const kept = raised(
    'employees = table(["name"], [["Harley"]])\nemployees = employees.add_column("total-wage", lambda r: 1)\nemployees.select_columns(["wage"])\n',
    3,
    "<module>",
    'KeyError: \'the table has no column "wage" (it has: name, total-wage).\'',
  );
  expect(
    !/makes a new table/.test(kept.headline),
    `a kept result is not a mutation mistake: ${kept.headline}`,
  );

  // -- and the rules give up rather than guess ---------------------------
  const unknown = raised(
    "x = 1\nx.frobnicate()\n",
    2,
    "<module>",
    "TypeError: some message no rule has ever seen",
  );
  expect(
    unknown.headline === "some message no rule has ever seen.",
    `unrecognised messages pass through: ${unknown.headline}`,
  );
  console.log("    twenty-five stock messages reworded, with no internal names left in them");
}

console.log("[library signatures match the Python they describe]");
{
  // `libraryFacts.ts` is written by hand so the Python sources stay
  // out of the extension bundle. That only works if it cannot drift, so
  // re-derive every signature from the real files and compare both ways.
  const PUBLIC_CLASSES = new Set(["Table", "Reactor", "Row", "Image"]);
  const derived = new Map();
  for (const rel of ["imageLib.py", "tableLib.py", "reactorLib.py"]) {
    const src = readFileSync(resolve(ROOT, "src/common", rel), "utf8");
    const exported = new Set();
    for (const m of src.matchAll(/PLL_\w*EXPORTS\s*=\s*\[([\s\S]*?)\]/g)) {
      for (const name of m[1].matchAll(/"([^"]+)"/g)) exported.add(name[1]);
    }
    let cls = null;
    for (const line of src.split("\n")) {
      const classLine = /^class (\w+)/.exec(line);
      if (classLine) {
        cls = classLine[1];
        continue;
      }
      if (/^\S/.test(line) && !line.startsWith("def ")) cls = null;
      const def = /^([ \t]*)def (\w+)\(([^)]*)\)/.exec(line);
      if (def === null) continue;
      const [, indent, name, params] = def;
      if (name.startsWith("_")) continue;
      const top = indent.length === 0;
      if (top && !exported.has(name)) continue;
      if (!top && !PUBLIC_CLASSES.has(cls)) continue;
      const required = [];
      const all = [];
      for (const raw of params.split(",")) {
        const part = raw.trim();
        if (!part || part === "self" || part === "cls" || part.startsWith("*")) continue;
        const pname = part.split(":")[0].split("=")[0].trim();
        all.push(pname);
        if (!part.includes("=")) required.push(pname);
      }
      if (required.length === 0) continue;
      if (!derived.has(name)) derived.set(name, { required, all });
    }
  }

  expect(derived.size > 50, `the derivation found signatures, got ${derived.size}`);
  const table = mod.LIBRARY_SIGNATURES;
  for (const [name, sig] of derived) {
    const written = table[name];
    expect(written !== undefined, `libraryFacts.ts is missing \`${name}\``);
    if (written === undefined) continue;
    expect(
      written.required.join(",") === sig.required.join(","),
      `\`${name}\` required: table has ${JSON.stringify(written.required)}, Python has ${JSON.stringify(sig.required)}`,
    );
    expect(
      written.all.join(",") === sig.all.join(","),
      `\`${name}\` all: table has ${JSON.stringify(written.all)}, Python has ${JSON.stringify(sig.all)}`,
    );
  }
  for (const name of Object.keys(table)) {
    expect(derived.has(name), `libraryFacts.ts has \`${name}\`, which Python does not`);
  }
  console.log(`    ${derived.size} signatures agree with imageLib, tableLib and reactorLib`);
}

console.log("[name errors: the hint that fits, not the one that always fits]");
{
  const finding = (error, source) =>
    mod.findRuntimeFinding(source, "lab.py", "raw", error);
  const raised = (source, line, errorLine) =>
    finding(pyErrorLine(errorLine, [["lab.py", line]]), source);

  // A name an import provides. Python's own suggestion for `pd` is `id`,
  // a real built-in with nothing to do with pandas.
  const pandas = raised(
    'movies = pd.DataFrame({"a": [1]})\n',
    1,
    "NameError: name 'pd' is not defined. Did you mean: 'id'?",
  );
  expect(
    pandas.headline === "`pd` comes from an import, and this file has not imported it.",
    `an import-provided name: ${pandas.headline}`,
  );
  expect(
    pandas.howToFix.length === 1 && /import pandas as pd/.test(pandas.howToFix[0]),
    `gives the import line and nothing else: ${JSON.stringify(pandas.howToFix)}`,
  );
  expect(
    !/\bid\b/.test(pandas.howToFix.join(" ")),
    "and drops Python's unrelated suggestion",
  );

  // Defined, but further down. "Check the spelling" sends the student
  // looking for a mistake that is not there.
  const later = raised(
    "height = width * 3\nwidth = 10\nprint(height)\n",
    1,
    "NameError: name 'width' is not defined",
  );
  expect(
    later.headline === "`width` is defined on line 2, after this line.",
    `a name defined later: ${later.headline}`,
  );
  expect(
    !later.howToFix.some((l) => /spelling/.test(l)),
    `and says nothing about spelling: ${JSON.stringify(later.howToFix)}`,
  );

  // The missing name is a parameter of the function being passed.
  const parameter = raised(
    'def below_1k(r):\n    return r["riders"] < 1000\n\n\nprint(t.filter(below_1k(r)))\n',
    5,
    "NameError: name 'r' is not defined",
  );
  expect(
    /`filter` calls `below_1k` for you/.test(parameter.headline),
    `a parameter used as a value: ${parameter.headline}`,
  );
  expect(
    parameter.howToFix.some((l) => /`filter\(below_1k\)`/.test(l)),
    `and shows the call: ${JSON.stringify(parameter.howToFix)}`,
  );

  // A forward reference in an *annotation* cannot be fixed by moving the
  // definition up: `NumList = Empty | Link` needs `Link`, and `Link` needs
  // `NumList`. This is the shape of every recursive definition in the
  // course, so the advice has to be the string form.
  const recursive = raised(
    "from dataclasses import dataclass\n\n\n@dataclass\nclass Link:\n    first: int\n    rest: NumList\n\n\nNumList = None | Link\n",
    7,
    "NameError: name 'NumList' is not defined",
  );
  expect(
    /an annotation is read as the file runs/.test(recursive.headline),
    `a forward reference in an annotation: ${recursive.headline}`,
  );
  expect(
    recursive.howToFix.some((l) => /`rest: "NumList"`/.test(l)),
    `the fix is quotes, shown on their own field: ${JSON.stringify(recursive.howToFix)}`,
  );
  expect(
    !recursive.howToFix.some((l) => /[Mm]ove the definition/.test(l)),
    `and never says to move it, which is impossible: ${JSON.stringify(recursive.howToFix)}`,
  );

  // A return annotation has no field to name it by.
  const returned = raised(
    "def rest(xs) -> NumList:\n    return xs\n\n\nNumList = int\nrest(1)\n",
    1,
    "NameError: name 'NumList' is not defined",
  );
  expect(
    returned.howToFix.some((l) => /`-> "NumList"`/.test(l)),
    `a return type is shown as itself: ${JSON.stringify(returned.howToFix)}`,
  );

  // An ordinary name defined later still gets "move it up", which for a
  // plain value is the right answer.
  const ordinary = raised(
    "height = width * 3\nwidth = 10\nprint(height)\n",
    1,
    "NameError: name 'width' is not defined",
  );
  expect(
    ordinary.howToFix.some((l) => /Move the definition of `width`/.test(l)),
    `a value defined later is still moved: ${JSON.stringify(ordinary.howToFix)}`,
  );

  // A name that really is just unknown keeps the general advice.
  const unknown = raised("print(Total)\n", 1, "NameError: name 'Total' is not defined");
  expect(
    unknown.headline === "Python doesn't know what `Total` means.",
    `an unknown name: ${unknown.headline}`,
  );
  expect(
    unknown.howToFix.some((l) => /spelling/.test(l)),
    `still mentions spelling: ${JSON.stringify(unknown.howToFix)}`,
  );
  console.log("    an import, a later definition, a parameter, and a plain typo");
}

console.log("[annotations: the function wording only where there is a function]");
{
  const annotation = (written) =>
    mod.enrichStaticFindings(
      [
        {
          id: "annotation-not-a-type",
          error_type: "NotAType",
          message: `\`${written}\` is not a type`,
          line_number: 1,
          column: 10,
          name_token: written,
          scope_kind: "function",
        },
      ],
      "beginner",
      "ann.py",
    )[0];

  // `table` and `reactor` really are functions PLL provides.
  for (const [written, type] of [["table", "Table"], ["reactor", "Reactor"]]) {
    const found = annotation(written);
    expect(
      found.headline === `\`${written}\` is the function that makes a ${written}; the type is \`${type}\`.`,
      `${written}: ${found.headline}`,
    );
    expect(
      found.howToFix.some((l) => l === `Write \`${type}\` instead.`),
      `and names the type: ${JSON.stringify(found.howToFix)}`,
    );
  }

  // Nothing is called `image`, and `row` is a method of a table rather
  // than a function that makes one - so neither gets told it is one. A row
  // is a `dict`: `Row` is not a name a student's program has.
  for (const [written, type] of [["image", "Image"], ["row", "dict"], ["string", "str"]]) {
    const found = annotation(written);
    expect(
      found.headline === `\`${written}\` is not a type Python knows.`,
      `${written} must not be called a function: ${found.headline}`,
    );
    expect(
      found.howToFix.some((l) => l === `Write \`${type}\` instead.`),
      `but still names the type: ${JSON.stringify(found.howToFix)}`,
    );
  }
  console.log("    `table` and `reactor` named as functions; `image` and `row` not");
}

console.log("[second review: advice that has to come from the program in hand]");
{
  const finding = (error, source, level = "raw") =>
    mod.findRuntimeFinding(source, "lab.py", level, error);
  const raised = (source, line, errorLine, level = "raw") =>
    finding(pyErrorLine(errorLine, [["<exec>", 560, "run"], ["lab.py", line]]), source, level);

  // The comparison hint used to show `int("999")` and `str(1000)`, and to
  // mention CSV columns, whatever the program compared.
  const noTable = raised(
    'n = 5\nif n < "apple":\n    print("x")\n',
    2,
    "TypeError: '<' not supported between instances of 'int' and 'str'",
  );
  const noTableText = noTable.howToFix.join(" ");
  expect(!/999|1000/.test(noTableText), `no fixed example values: ${noTableText}`);
  expect(!/CSV/.test(noTableText), `no CSV in a file with no table: ${noTableText}`);
  expect(/`int\(\.\.\.\)`/.test(noTableText), `the conversion is the right one: ${noTableText}`);

  const withTable = raised(
    'cars = load_table("cars.csv")\nif cars.row(0)["mpg"] < 30:\n    print("x")\n',
    2,
    "TypeError: '<' not supported between instances of 'str' and 'int'",
  );
  expect(
    withTable.howToFix.some((l) => /column read from a CSV is text|Every column read from a CSV/.test(l)),
    `a file that reads a CSV gets the CSV advice: ${JSON.stringify(withTable.howToFix)}`,
  );

  // `t = t.add_column(...)` is refused at the levels that set a name once,
  // so it is only offered where it would work.
  const discardedAt = (level) =>
    raised(
      'employees = table(["name"], [["Harley"]])\nemployees.add_column("total-wage", lambda r: 1)\nemployees.select_columns(["total-wage"])\n',
      3,
      'KeyError: \'the table has no column "total-wage" (it has: name).\'',
      level,
    );
  for (const level of ["beginner", "intermediate"]) {
    const found = discardedAt(level);
    expect(
      !found.howToFix.some((l) => /`employees = employees\./.test(l)),
      `${level} must not be told to reassign: ${JSON.stringify(found.howToFix)}`,
    );
    expect(
      found.howToFix.some((l) => /new_employees = employees\.add_column/.test(l)),
      `${level} is given a new name instead: ${JSON.stringify(found.howToFix)}`,
    );
  }
  for (const level of ["raw", "advanced"]) {
    expect(
      discardedAt(level).howToFix.some((l) => /`employees = employees\.add_column/.test(l)),
      `${level} can reassign`,
    );
  }

  // A table-row error points at the row, not at `table(`.
  const rowsSource =
    'shuttle = table(\n    ["month", "riders"],\n    [\n        ["Jan", 1121],\n        ["Feb", 982],\n        ["Mar"],\n    ],\n)\n';
  const shortRow = raised(
    rowsSource,
    1,
    'ValueError: the 3rd row, ["Mar"], has 1 value, but the table has 2 columns: month, riders',
  );
  expect(shortRow.lineNumber === 6, `the 3rd row is on line 6, got ${shortRow.lineNumber}`);

  // Strings containing `,` and `]` are not structure.
  const tricky = raised(
    't = table(["a", "b"], [["x, ]", 1], ["y"]])\n',
    1,
    'ValueError: the 2nd row, ["y"], has 1 value, but the table has 2 columns: a, b',
  );
  expect(tricky.lineNumber === 1, `a one-line table stays on its line: ${tricky.lineNumber}`);

  // Rows passed as a variable have no line of their own.
  const variable = raised(
    'rows = [["Jan", 1], ["Feb"]]\nt = table(["month", "riders"], rows)\n',
    2,
    'ValueError: the 2nd row, ["Feb"], has 1 value, but the table has 2 columns: month, riders',
  );
  expect(variable.lineNumber === 2, `rows in a variable keep the table( line: ${variable.lineNumber}`);

  // `3(width)` uses the student's operand, not a placeholder.
  const times = raised("width = 4\nh = 3(width)\n", 2, "TypeError: 'int' object is not callable");
  expect(
    times.howToFix.some((l) => /`3 \* width`, not `3\(width\)`/.test(l)),
    `the fix is written with their own operand: ${JSON.stringify(times.howToFix)}`,
  );

  // A list and a string: one item, in brackets.
  const listPlus = raised(
    'words = ["hi"]\nprint(words + "!")\n',
    2,
    'TypeError: can only concatenate list (not "str") to list',
  );
  expect(
    listPlus.headline === "A list and a string cannot be added together.",
    `list concatenation: ${listPlus.headline}`,
  );
  expect(
    listPlus.howToFix.some((l) => /`words \+ \[item\]`/.test(l)),
    `and says to put the item in brackets: ${JSON.stringify(listPlus.howToFix)}`,
  );
  // Concatenation advice quotes the student's own operands, not a fixed
  // `"total: " + str(n)` shown whatever they wrote.
  const concat = raised(
    'count = 3\nprint("Total: " + count)\n',
    2,
    'TypeError: can only concatenate str (not "int") to str',
  );
  expect(
    concat.howToFix.some((l) => /`"Total: " \+ str\(count\)`/.test(l)),
    `the join is written with their operands: ${JSON.stringify(concat.howToFix)}`,
  );
  expect(
    concat.howToFix.some((l) => /`print\("Total:", count\)`/.test(l)),
    `and so is the print form: ${JSON.stringify(concat.howToFix)}`,
  );
  expect(
    !concat.howToFix.some((l) => /"total: " \+ str\(n\)|int\("19"\)/.test(l)),
    `with no fixed example left: ${JSON.stringify(concat.howToFix)}`,
  );
  // Outside `print`, the print suggestion does not apply.
  const notPrint = raised(
    'count = 3\nlabel = "Total: " + count\n',
    2,
    'TypeError: can only concatenate str (not "int") to str',
  );
  expect(
    !notPrint.howToFix.some((l) => /In `print`/.test(l)),
    `no print advice where there is no print: ${JSON.stringify(notPrint.howToFix)}`,
  );

  // Brackets on a dataclass: their own subscript, turned round.
  const dot = raised(
    'from dataclasses import dataclass\n\n\n@dataclass\nclass Song:\n    name: str\n    year: int\n\n\nsong = Song("a", 1)\nprint(song["year"])\n',
    11,
    "TypeError: 'Song' object is not subscriptable",
  );
  expect(
    dot.howToFix.some((l) => /`song\.year` rather than `song\["year"\]`/.test(l)),
    `their own subscript, as a dot: ${JSON.stringify(dot.howToFix)}`,
  );
  console.log("    comparisons, levels, row lines, operands and lists from the program itself");
}

console.log("[second review: a wrong annotation says what will actually happen]");
{
  const annotation = (written) =>
    mod.enrichStaticFindings(
      [
        {
          id: "annotation-not-a-type",
          error_type: "NotAType",
          message: `\`${written}\` is not a type`,
          line_number: 1,
          column: 10,
          name_token: written,
          scope_kind: "function",
        },
      ],
      "beginner",
      "ann.py",
    )[0];
  // `table` exists, so the annotation is accepted and checks nothing.
  expect(
    annotation("table").howToFix.some((l) => /accepted and nothing about this value is checked/.test(l)),
    `table: ${JSON.stringify(annotation("table").howToFix)}`,
  );
  // `string` does not exist, so the line fails - "accepted" would be false.
  for (const written of ["string", "Float", "image"]) {
    const found = annotation(written);
    expect(
      !found.howToFix.some((l) => /accepted/.test(l)),
      `${written} is not accepted - it is a NameError: ${JSON.stringify(found.howToFix)}`,
    );
    expect(
      found.howToFix.some((l) => new RegExp(`nothing called \`${written}\``).test(l)),
      `${written}: says why it fails: ${JSON.stringify(found.howToFix)}`,
    );
  }
  // `name = str` is quoted back as written, not as `name = int`.
  const assigned = mod.enrichStaticFindings(
    [
      {
        id: "field-assigned-type",
        error_type: "FieldNeedsType",
        message: "the field `name` is assigned a type instead of annotated",
        line_number: 6,
        column: 4,
        name_token: "name",
        scope_kind: "function",
        written_type: "str",
      },
    ],
    "beginner",
    "dc.py",
  )[0];
  expect(
    assigned.headline === "`name = str` sets `name` to the type itself; did you mean `name: str`?",
    `the type they wrote: ${assigned.headline}`,
  );
  console.log("    an existing name is accepted silently; a missing one fails, and each says so");
}

console.log("[third review: the cases replayed from docs/error-review.md]");
{
  const finding = (error, source, level = "beginner") =>
    mod.findRuntimeFinding(source, "student.py", level, error);
  const raised = (source, line, errorLine, frames = []) =>
    finding(
      pyErrorLine(errorLine, [["<exec>", 1, "_pll_run_file"], ["student.py", line], ...frames]),
      source,
    );
  const text = (f) => `${f.headline}\n${f.howToFix.join("\n")}`;

  // syn-string-concat-num: the operand is a nested call, and converting
  // only its name converted the function rather than its result.
  const nested = raised(
    'print("Total: " + add_shipping(pen_cost(10, "bravo")))\n',
    1,
    'TypeError: can only concatenate str (not "float") to str',
  );
  expect(
    /`"Total: " \+ str\(add_shipping\(pen_cost\(10, "bravo"\)\)\)`/.test(text(nested)),
    `the whole call is converted: ${text(nested)}`,
  );
  expect(!/str\(add_shipping\)`/.test(text(nested)), `never the bare function: ${text(nested)}`);

  // in-print-comma-plus: `print` adds a space between its arguments, so
  // the literal's own trailing space would make two.
  const spaced = raised(
    'age = 19\nprint("Next year you will be " + age)\n',
    2,
    'TypeError: can only concatenate str (not "int") to str',
  );
  expect(
    /`print\("Next year you will be", age\)`/.test(text(spaced)),
    `the trailing space is dropped in the comma form: ${text(spaced)}`,
  );

  // in-no-int: the text is a typed number, and adding to it is the point.
  const typed = raised(
    'age = input("How old are you? ")\nprint("Next year you will be", age + 1)\n',
    2,
    'TypeError: can only concatenate str (not "int") to str',
  );
  expect(/came from `input`, which always gives back text/.test(text(typed)), `input named: ${text(typed)}`);
  expect(/`int\(age\) \+ 1`/.test(text(typed)), `converted first: ${text(typed)}`);
  expect(!/join them as text|commas instead/.test(text(typed)), `no joining advice: ${text(typed)}`);

  // filter-expression: the comparison is worked out before `filter` runs,
  // so the real mistake - a condition where a function belongs - has to
  // be read from the line.
  const condition = raised(
    'low = shuttle.filter("riders" < 1000)\n',
    1,
    "TypeError: '<' not supported between instances of 'str' and 'int'",
  );
  expect(
    condition.headline === "`filter` needs a function, but this gives it a condition.",
    `the real mistake is named: ${condition.headline}`,
  );
  expect(
    /`return r\["riders"\] < 1000`/.test(text(condition)) && /`shuttle\.filter\(keep\)`/.test(text(condition)),
    `with their condition inside a function: ${text(condition)}`,
  );
  // A function that compares is still a function.
  const lambda = raised(
    'low = shuttle.filter(lambda r: r["riders"] < "x")\n',
    1,
    "TypeError: '<' not supported between instances of 'int' and 'str'",
  );
  expect(!/gives it a condition/.test(lambda.headline), `a lambda is a function: ${lambda.headline}`);

  // rx-call-handler: Python cannot know the handler's name - `draw_dog(0)`
  // has already run - but the line does.
  const handler = raised(
    "dog_reactor = reactor(init=0, to_draw=draw_dog(0), on_tick=next_x)\n",
    1,
    "ValueError: reactor's `to_draw` has to be a function, written as its name with no brackets after it.",
  );
  expect(
    /Write `to_draw=draw_dog`, not `to_draw=draw_dog\(0\)`/.test(text(handler)),
    `the handler as they wrote it: ${text(handler)}`,
  );
  expect(!/`draw`, not `draw\(\)`/.test(text(handler)), `no fixed example: ${text(handler)}`);

  // in-word: what was typed, not a CSV cell, and quoted the course's way.
  const word = raised(
    'age = int(input("How old are you? "))\n',
    1,
    "ValueError: invalid literal for int() with base 10: 'nineteen'",
  );
  expect(/cannot turn "nineteen" into/.test(word.headline), `double quotes: ${word.headline}`);
  expect(/`input` gives back exactly what was typed/.test(text(word)), `input named: ${text(word)}`);
  expect(!/CSV/.test(text(word)), `no CSV in a program that reads input: ${text(word)}`);
  const cell = raised(
    'cars = load_table("cars.csv")\nn = int(cars.row(0)["mpg"])\n',
    2,
    "ValueError: invalid literal for int() with base 10: ''",
  );
  expect(/CSV/.test(text(cell)), `a program that reads a CSV gets the CSV bullet: ${text(cell)}`);

  // no-columns: the example belongs in the sentence that introduces it.
  const noColumns = raised(
    't = table([["Jan", 1121]])\n',
    1,
    "TypeError: table() missing 1 required positional argument: 'rows'",
  );
  expect(
    noColumns.howToFix.some((l) => /one more list: `table\(\["month", "riders"\]/.test(l)),
    `the example is in the same bullet: ${JSON.stringify(noColumns.howToFix)}`,
  );
  expect(
    !noColumns.howToFix.some((l) => /^`table\(/.test(l)),
    `and not a bullet of its own: ${JSON.stringify(noColumns.howToFix)}`,
  );

  // loop-list-annotation: what item 0 *is*, read by Python from the frame.
  const item = finding(
    pyErrorLine(
      'TypeCheckError: item 0 of argument "lst" (list) is not an instance of float',
      [["student.py", 25], ["student.py", 2, "sum_list"]],
      { facts: { elementValue: 'the string "1"' } },
    ),
    'def sum_list(lst: list[float]) -> float:\n    return 0\n',
  );
  expect(
    /but item 0 is the string "1"\.$/.test(item.headline),
    `the element is described: ${item.headline}`,
  );

  // A dict's key in the quotes its value is described in, not Python's.
  const keyed = (element, value) =>
    finding(
      pyErrorLine(
        `TypeCheckError: ${element} of argument "d" (dict) is not an instance of int`,
        [["student.py", 4], ["student.py", 2, "total"]],
        { facts: value ? { elementValue: value } : {} },
      ),
      "def total(d: dict[str, int]) -> int:\n    return 0\n",
    );
  const valueOf = keyed("value of key 'a'", 'the string "1"');
  expect(/the value for key "a" is the string "1"\.$/.test(valueOf.headline), `one kind of quote: ${valueOf.headline}`);
  expect(valueOf.howToFix.some((l) => l.includes('key "a"')), `in the advice too: ${JSON.stringify(valueOf.howToFix)}`);
  expect(/key "b"/.test(keyed("key 'b'").headline), `a key itself: ${keyed("key 'b'").headline}`);
  // Not a string, or quoted the way it is because of what is in it: as Python wrote it.
  expect(/key 1 /.test(keyed("value of key 1").headline), `a number key: ${keyed("value of key 1").headline}`);
  expect(keyed(`value of key 'say "hi"'`).headline.includes(`key 'say "hi"'`),
    `a key with a quote in it: ${keyed(`value of key 'say "hi"'`).headline}`);

  // mut-local-not-field: the line reads the field it meant to change.
  const field = finding(
    pyErrorLine(
      "TypeCheckError: value assigned to ac (int) is not an instance of __pll_test__.Account",
      [["student.py", 14], ["student.py", 3, "deposit"]],
    ),
    "def deposit(ac: Account, amt: float) -> None:\n    x = 1\n    ac = ac.balance + amt\n",
  );
  expect(
    field.howToFix.some((l) => /`ac\.balance = ac\.balance \+ amt`/.test(l)),
    `assign to the field: ${JSON.stringify(field.howToFix)}`,
  );
  expect(
    !field.howToFix.some((l) => /Assign `Account` to/.test(l)),
    `never "assign the class": ${JSON.stringify(field.howToFix)}`,
  );

  // dc-class-call-no-args: "not `ITunesSong`" next to "the class
  // `ITunesSong`" said the same name twice for opposite things.
  const cls = finding(
    pyErrorLine(
      'TypeCheckError: argument "s" (class __pll_test__.ITunesSong) is not an instance of __pll_test__.ITunesSong',
      [["student.py", 8], ["student.py", 5, "song_age"]],
    ),
    "class ITunesSong:\n    pass\n\n\ndef song_age(s: ITunesSong) -> int:\n    return 1\n\n\nsong_age(ITunesSong)\n",
  );
  expect(/itself, not one made from it\.$/.test(cls.headline), `class itself: ${cls.headline}`);

  // rx-init-string: a capital, and the handler named.
  const state = finding(
    pyErrorLine('TypeCheckError: argument "x" (str) is not an instance of float', [
      ["<exec>", 960, "_pll_run_file"],
      ["student.py", 21],
      ["<exec>", 223, "interact"],
      ["<exec>", 431, "_pll_reactor_interact"],
      ["<exec>", 396, "_pll_reactor_view"],
      ["student.py", 5, "draw_dog"],
    ]),
    "#level beginner\n\n\n\ndef draw_dog(x: float) -> Image:\n    return x\n",
  );
  expect(
    /^The reactor calls `draw_dog` with its state/.test(state.howToFix[0] ?? ""),
    `a capital, and the handler named: ${JSON.stringify(state.howToFix)}`,
  );
  // dc-field-no-annotation: this is reported before the program runs, so
  // the NameError it used to lead to is never shown - and must not be
  // referred to.
  const noType = mod.enrichStaticFindings(
    [
      {
        id: "field-no-type",
        error_type: "FieldNeedsType",
        message: "the field `year` has no type",
        line_number: 8,
        column: 4,
        name_token: "year",
        scope_kind: "function",
      },
    ],
    "intermediate",
    "student.py",
  )[0];
  expect(
    !/error is about a name/.test(noType.howToFix.join(" ")),
    `no reference to an error that is not shown: ${JSON.stringify(noType.howToFix)}`,
  );
  expect(
    noType.howToFix.some((l) => /only uses the name; it does not declare anything/.test(l)),
    `says what the line does instead: ${JSON.stringify(noType.howToFix)}`,
  );
  console.log("    sixteen replayed cases worded from the program, with the right advice");
}

console.log("[fourth pass: every replayed case read for the same patterns]");
{
  const finding = (error, source, level = "beginner") =>
    mod.findRuntimeFinding(source, "student.py", level, error);
  const raised = (source, line, errorLine, extra = []) =>
    finding(pyErrorLine(errorLine, [["student.py", line]], { facts: extra }), source);
  const text = (f) => `${f.headline}\n${f.howToFix.join("\n")}`;

  // One suggestion is "Did you mean", not "try one of those"; a case-only
  // difference says so; and the spelling and quotes bullets are moot.
  const one = raised("print(widht)\n", 1, "NameError: name 'widht' is not defined. Did you mean: 'width'?");
  expect(one.howToFix.join("|") === "Did you mean `width`?", `one suggestion: ${JSON.stringify(one.howToFix)}`);
  const caseOnly = raised("x = boa\n", 1, "NameError: name 'boa' is not defined. Did you mean: 'Boa'?");
  expect(/case-sensitive, so `boa` and `Boa` are different names/.test(text(caseOnly)), `case: ${text(caseOnly)}`);
  expect(!/put it in quotes/.test(text(caseOnly)), `no quotes advice beside a confident match: ${text(caseOnly)}`);

  // The list's real length, from the line Python added.
  const sized = raised(
    "nums = [1, 2, 3]\nprint(nums[3])\n",
    2,
    "IndexError: list index out of range",
    { sequence: "nums", length: 3 },
  );
  expect(
    sized.howToFix.some((l) => /`nums` has 3 items, numbered 0 to 2/.test(l)),
    `the real length: ${JSON.stringify(sized.howToFix)}`,
  );

  // Too many arguments: how many too many.
  const extra = raised(
    't = table(["a", "b"], ["x", 1], ["y", 2], ["z", 3])\n',
    1,
    "TypeError: table() takes 2 positional arguments but 5 were given",
  );
  expect(/there are 3 values too many/.test(text(extra)), `counted: ${text(extra)}`);

  // A class with no fields has nothing to get.
  const empty = raised(
    "class NoInfo:\n    pass\n\n\nprint(NoInfo().name)\n",
    5,
    "AttributeError: 'NoInfo' object has no attribute 'name'",
  );
  expect(/`NoInfo` has no fields at all, so it has no `name`/.test(empty.headline), `empty class: ${empty.headline}`);
  expect(/`case NoInfo\(\):`/.test(text(empty)), `with the check to add: ${text(empty)}`);

  // pandas' uneven columns.
  const uneven = raised(
    'df = pd.DataFrame({"a": [1, 2], "b": [1]})\n',
    1,
    "ValueError: All arrays must be of the same length",
  );
  expect(/different numbers of values/.test(uneven.headline), `uneven: ${uneven.headline}`);

  // "Return `Image`" read as returning the class: a class gets an article.
  const returned = finding(
    pyErrorLine("TypeCheckError: the return value (str) is not an instance of Image", [
      ["student.py", 2, "flag"],
    ]),
    'def flag() -> Image:\n    return "red"\n',
  );
  expect(returned.howToFix.includes("Return an `Image` from this line."), `article: ${JSON.stringify(returned.howToFix)}`);

  // Swapped values in a dataclass, as Python reports them.
  const swapped = finding(
    pyErrorLine("TypeCheckError: field 'singer' of 'Song' got 2015 (int), not str", [["student.py", 9]], {
      facts: { swappedWith: "year" },
    }),
    'class Song:\n    name: str\n    singer: str\n    year: int\n',
  );
  expect(/values for `singer` and `year` of `Song` look swapped/.test(swapped.headline), `swap: ${swapped.headline}`);
  expect(!/str\(\.\.\.\)/.test(text(swapped)), `no conversion advice, which would hide the swap: ${text(swapped)}`);

  // A value thrown away: the student's own expression.
  const thrown = (expression) =>
    mod.enrichStaticFindings(
      [
        {
          id: "unused-value",
          error_type: "UnusedValue",
          message: "this value is not used",
          line_number: 3,
          column: 4,
          name_token: null,
          scope_kind: "function",
          expression,
        },
      ],
      "beginner",
      "student.py",
    )[0];
  expect(
    thrown("order_amt + 8").howToFix[0] === "Did you mean `return order_amt + 8`? On its own, the value is worked out and thrown away.",
    `return form: ${JSON.stringify(thrown("order_amt + 8").howToFix)}`,
  );
  expect(
    /`ac\.balance = ac\.balance \+ amt`/.test(thrown("ac.balance + amt").howToFix[0]),
    `field form: ${JSON.stringify(thrown("ac.balance + amt").howToFix)}`,
  );
  const compared = mod.enrichStaticFindings(
    [
      {
        id: "unused-comparison",
        error_type: "UnusedValue",
        message: "x",
        line_number: 3,
        column: 4,
        name_token: null,
        scope_kind: "function",
        expression: 'pen_cost(0, "huskies") == 1',
      },
    ],
    "beginner",
    "student.py",
  )[0];
  expect(
    /Did you mean `assert pen_cost\(0, "huskies"\) == 1`\?/.test(compared.howToFix[0]),
    `their comparison, not "assert ...": ${compared.howToFix[0]}`,
  );
  console.log("    suggestions, lengths, counts, empty classes, swaps and expressions from the program");
}

if (!passed()) {
  console.log("\nFAILED");
  process.exit(1);
}
console.log("\nALL EXPLAINER SMOKE TESTS PASSED");
