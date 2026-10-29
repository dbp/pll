#!/usr/bin/env node
/**
 * Smoke test for parseLevel and the explanations: the static findings'
 * wording, from Python, and the runtime explainers, bundled with esbuild on
 * the fly so no separate build step is needed.
 */
import { expect, passed } from "./lib/check.mjs";
import { importSource } from "./lib/bundle.mjs";
import { bootPll } from "./lib/pyodide.mjs";

const mod = await importSource(`
import { parseLevel, levelHeaderProblem } from "./src/core/level";
import { levelHeaderFinding } from "./src/run/finding";
import { formatFriendlyError } from "./src/run/finding";
import { findRuntimeFinding } from "./src/run/finding";

export {
  parseLevel,
  levelHeaderProblem,
  levelHeaderFinding,
  formatFriendlyError,
  findRuntimeFinding,
};
`);

const pyodide = await bootPll();
const pllCall = pyodide.globals.get("_pll_call");

/**
 * Static findings as `_pll_static_analyze` makes them, worded by Python
 * (`explain/static.py`) as the host receives them.
 */
const wordStatic = (raw, level, fileName) =>
  raw.map((finding) =>
    JSON.parse(pllCall("_pll_word_static", JSON.stringify([{ severity: "error", ...finding }, level, fileName]))),
  );

let runs = 0;
/** Run `source` as the file `fileName`, and give the finding Python made of its error. */
function ran(source, fileName = "lab.py", level = "beginner") {
  runs += 1;
  const result = JSON.parse(pllCall("_pll_run_file", JSON.stringify([source, fileName, `run-${runs}`, level, false])));
  return result.error?.finding ?? null;
}

/**
 * The finding Python's rules make of `error` (as `pyError` describes it), in
 * a run of `source` as `fileName` at `level` - completed as the host
 * completes it.
 */
function explained(error, source, fileName, level) {
  const finding = JSON.parse(pllCall("_pll_explain_error", JSON.stringify([error, [fileName, source], level])));
  return { ...finding, fileName: finding.fileName ?? fileName, level };
}

/** The facts' own names, as Python spells them. */
const SNAKE = {
  elementValue: "element_value",
  elementType: "element_type",
  swappedWith: "swapped_with",
  returnedNone: "returned_none",
  fixedLength: "fixed_length",
  hasList: "has_list",
  headerProblem: "header_problem",
};
const snakeFacts = (value) =>
  Array.isArray(value)
    ? value.map(snakeFacts)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [SNAKE[key] ?? key, snakeFacts(inner)]))
      : value;

/**
 * An error as `_pll_error_info` describes it.
 *
 * `frames` are `[file, line, function]`, outermost first; a frame is the
 * student's unless its file is PLL's (`<pll:...>`) or a library's. The error is
 * at the innermost frame. `facts` are what Python would have learned from
 * the live frames, and `name` among them is the name a `NameError` is about.
 */
function pyError(type, message, frames, { facts = {}, column = null } = {}) {
  const innermost = frames[frames.length - 1] ?? null;
  return {
    errorType: type,
    message,
    fileName: innermost?.[0] ?? null,
    lineNumber: innermost?.[1] ?? null,
    column,
    text: null,
    frames: frames.map(([file, line, functionName = "<module>"]) => ({
      file,
      line,
      column: null,
      function: functionName === "<module>" ? null : functionName,
      // As `_pll_is_students` decides.
      user: file === "<repl>" || (!file.startsWith("<") && !/site-packages|\/lib\/python|_pytest|pluggy|pll_vendor/.test(file)),
      text: null,
      parameters: null,
    })),
    facts: snakeFacts(facts),
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

/**
 * What `_pll_definition` sends for a function, one of the student's
 * classes, and a union - tested against Python itself in smoke-typecheck.
 */
const defFunction = (parameters, required = parameters) => ({ kind: "function", parameters, required });
const defClass = (fields, dataclass = true) => ({ kind: "class", students: true, fields, dataclass });
const defUnion = (members) => ({ kind: "union", members });

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

console.log("[static findings, worded]");
const findings = wordStatic(
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
  "reassignment fixes do not mention comprehensions",
);
expect(
  findings[2].howToFix.every((fix) => !/#expert/i.test(fix)),
  "reassignment fixes do not suggest switching to #expert",
);
expect(
  findings[2].howToFix.every((fix) => !/#level advanced/i.test(fix)),
  "reassignment fixes do not suggest switching to advanced",
);

console.log("[shadowing-library explainer]");
{
  const libFindings = wordStatic(
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
  const preexisting = wordStatic(
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
const kwFindings = wordStatic(
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

console.log("[unbinding explainer - del of a name]");
{
  const unbinding = (extra, level = "beginner") =>
    wordStatic(
      [{ id: "unbinding", error_type: "Unbinding", line_number: 3, column: 4, name_token: "total", ...extra }],
      level,
      "del.py",
    )[0];
  const plain = unbinding({ names: ["total"], scope_kind: "module", loop_variable: false });
  expect(plain.errorType === "Unbinding", `errorType: ${plain.errorType}`);
  expect(
    plain.headline === "`del` removes the name `total`, which is not allowed at the beginner level.",
    `the name, and the level: ${plain.headline}`,
  );
  // Taking an item out is changing a value in place, refused as it runs.
  expect(!plain.howToFix.some((fix) => fix.includes("`del d[key]`")), `no item's del offered: ${JSON.stringify(plain.howToFix)}`);
  expect(/`#level advanced`/.test(plain.howToFix.at(-1)), `and where it is allowed: ${plain.howToFix.at(-1)}`);
  expect(!/go away by themselves/.test(plain.howToFix[0]), `nothing about functions at the top level: ${plain.howToFix[0]}`);
  const inFunction = unbinding({ names: ["total", "count"], scope_kind: "function", loop_variable: false }, "intermediate");
  expect(
    inFunction.headline === "`del` removes the names `total` and `count`, which is not allowed at the intermediate level.",
    `every name, and the level: ${inFunction.headline}`,
  );
  expect(/go away by themselves when it returns/.test(inFunction.howToFix[0]), `inside a function: ${inFunction.howToFix[0]}`);
  const loop = unbinding({ name_token: "n", names: ["n"], scope_kind: "function", loop_variable: true });
  expect(
    /removes only the name `n`, not the item/.test(loop.howToFix[0]) && /new list/.test(loop.howToFix[0]),
    `a loop's own name says the item stays: ${loop.howToFix[0]}`,
  );
  expect(!loop.howToFix.some((fix) => fix.includes("`del items[0]`")), `and does not suggest removing by index: ${JSON.stringify(loop.howToFix)}`);
}

console.log("[formatFriendlyError - shadowing-builtin]");
const lines = mod.formatFriendlyError(findings[1]);
expect(lines[0].startsWith("Shadowing:"), "first line is errorType + headline");
expect(lines.some((l) => l.includes("at test.py:15:1")), "shows location");
expect(lines.some((l) => l.includes("How to fix:")), "shows How to fix section");

console.log("[name errors: a name with no value is named, not called `this name`]");
{

  // The Lab 10 shape: an inner function reads a name the enclosing function
  // assigns later. The name is recovered from this wording too, not only
  // from `name 'x' is not defined`, or the report would read "Python doesn't
  // know what `this name` means", in a file where `title` is right there.
  const free = ran("def outer():\n    def inner():\n        return title\n    inner()\n    title = 1\n\n\nouter()\n");
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
  const local = ran("def f():\n    print(count)\n    count = 1\n\n\nf()\n");
  expect(local !== null, "an UnboundLocalError should be explained too");
  expect(local.nameToken === "count", `the name should be found, got ${local.nameToken}`);
  expect(local.errorType === "UnboundLocalError", `keep Python's type: ${local.errorType}`);
  expect(
    local.howToFix.some((line) => /local to the whole function/.test(line)),
    `expected the assigning-makes-it-local note: ${JSON.stringify(local.howToFix)}`,
  );

  // A genuinely unknown name still gets the spelling advice.
  const unknown = ran("print(Totl)\n");
  expect(unknown.nameToken === "Totl", `got ${unknown.nameToken}`);
  expect(/doesn't know what `Totl`/.test(unknown.headline), `headline: ${unknown.headline}`);
  expect(
    unknown.howToFix.some((line) => /spelling/.test(line)),
    "an unknown name does want the spelling check",
  );
  console.log("    free, local and unknown names each named and advised correctly");
}

console.log("[an explanation that fails leaves Python's own words]");
{
  // A rule with a bug must not lose the error: it is said as Python said it, where it is.
  pyodide.runPython("_pll_explain_error_kept = _pll_explain_error\ndef _pll_explain_error(info, run, level):\n    raise ValueError('a rule broke')\n");
  let fallback = null;
  try {
    fallback = ran("x = 1\nprint(x / 0)\n");
  } finally {
    pyodide.runPython("_pll_explain_error = _pll_explain_error_kept\ndel _pll_explain_error_kept\n");
  }
  expect(
    fallback?.headline === "division by zero" && fallback.fileName === "lab.py" && fallback.lineNumber === 2,
    `Python's words, at the line: ${JSON.stringify(fallback)}`,
  );
  expect(ran("print(1 / 0)\n")?.headline === "division by zero.", "and the rules are back afterwards");
  // In none of the student's files, the host puts the finding in the run's.
  const placed = mod.findRuntimeFinding("lab.py", "beginner", {
    errorType: "MemoryError",
    message: "",
    finding: { id: "runtime-error", errorType: "MemoryError", headline: "x", howToFix: [], fileName: null, lineNumber: null, column: null, nameToken: null, severity: "error", origin: "runtime" },
  });
  expect(placed.fileName === "lab.py" && placed.level === "beginner", `the run's file and level: ${JSON.stringify(placed)}`);
}

console.log("[a #level line that names nothing valid is an error, not silence]");
{
  // Absence stays silent, so ordinary Python runs as ordinary Python. But a
  // line that *asked* for a level and did not get one would otherwise run
  // at raw with every expected check gone and nothing said.
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
  const explain = (type, message, line) => {
    const [headline, howToFix] = JSON.parse(pllCall("_pll_syntax_wording", JSON.stringify([type, message, line])));
    return { headline, howToFix };
  };

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

console.log("[syntax errors: a function written as Pyret writes one, or with no name - only when that is all]");
{
  // As a run says them, with the program around the line.
  const raised = (source) => ran(source, "lab.py", "raw");
  const CASES = [
    ["a `-` in the name", "def foo-bar(x: int) -> int:\n    return x\n",
      "A function's name cannot have a `-` in it: Python reads `foo-bar` as `foo` minus `bar`.",
      ["Write `def foo_bar(...)`, with an underscore, and call it `foo_bar(...)` too."]],
    ["two of them, the parameters on lines of their own", "def lemonade-stand-1(\n    cups: int,\n) -> int:\n    return cups\n",
      "A function's name cannot have a `-` in it: Python reads `lemonade-stand-1` as `lemonade` minus `stand` minus `1`.",
      ["Write `def lemonade_stand_1(...)`, with underscores, and call it `lemonade_stand_1(...)` too."]],
    ["no name", "def (x: int) -> int:\n    return x\n", "This `def` has no name.",
      ["Put one between `def` and the brackets - `def function_name(...)` - with a name that says what it does."]],
    ["no name, no space", "def(x):\n    return x\n", "This `def` has no name.", null],
    ["Pyret's `fun`", "fun foo(x: int) -> int:\n    return x\n", "Python defines a function with `def`, not `fun`.", ["Write `def foo(...)`."]],
    ["`fun`, a `-`, and Pyret's `end`", "fun total-cost(x: int) -> int:\n    return x\nend\n",
      "Python defines a function with `def`, not `fun` - and a name cannot have a `-` in it.",
      ["Write `def total_cost(...)`, and call it `total_cost(...)` too.",
        "Take out the `end` on line 3 too: a Python function ends where its indented lines do."]],
    ["`fun`, with another mistake further down", "fun foo(x):\n    return (x\n", "Python defines a function with `def`, not `fun`.", null],
  ];
  for (const [what, source, headline, fix] of CASES) {
    const got = raised(source);
    expect(got.headline === headline, `${what}: ${got.headline}`);
    if (fix !== null) expect(JSON.stringify(got.howToFix) === JSON.stringify(fix), `${what}, the fix: ${JSON.stringify(got.howToFix)}`);
  }
  // Each needs that mistake and only that one: with another on the same
  // line, or a different one, Python's own words stand.
  const LEFT = [
    ["a `-` and no colon", "def foo-bar(x: int) -> int\n    return x\n"],
    ["Pyret's annotations too", "fun foo(x :: Number) -> Number:\n    x\nend\n"],
    ["a `-` in a parameter", "def foo(a-b):\n    return 1\n"],
    ["a `-` with spaces round it", "def foo - bar(x):\n    return x\n"],
    ["a call of `funny`", "funny(x) = 3\n"],
    ["a call of `funny`, with a colon", "funny(x):\n    pass\n"],
    ["a mistake under a good `def`", "def total(x):\n    return x +\n"],
  ];
  for (const [what, source] of LEFT) {
    const got = raised(source);
    expect(!/`fun`|has no name|cannot have a `-`/.test(got.headline), `${what}: ${got.headline}`);
  }
  // With no program to mend - a prompt line - the line has to parse alone.
  const explain = (line) => JSON.parse(pllCall("_pll_syntax_wording", JSON.stringify(["SyntaxError", "invalid syntax", line])));
  expect(explain("fun foo(x):")[0] === "Python defines a function with `def`, not `fun`.", `a line alone: ${explain("fun foo(x):")[0]}`);
  expect(explain("fun foo(x) = 1")[0] === "invalid syntax.", `that does not parse mended: ${explain("fun foo(x) = 1")[0]}`);
  // A good `def`, failing for where it is: there is nothing to mend in it.
  const placed = JSON.parse(pllCall("_pll_syntax_wording", JSON.stringify(["IndentationError", "unexpected indent", "    def foo(x):"])));
  expect(placed[0] === "unexpected indent.", `a good def, out of place: ${placed[0]}`);
  console.log(`    ${CASES.length} said, ${LEFT.length} left to Python, and a line on its own`);
}

console.log("[stock messages: Python's own wording replaced with the course's]");
{
  /** Build a finding the way the hosts do, from a traceback and the file. */
  const finding = (error, source) => explained(error, source, "lab.py", "beginner");

  /** A one-frame traceback pointing at `line` of `source`. */
  const raised = (source, line, fn, errorLine, facts = {}) =>
    finding(pyErrorLine(errorLine, [["<pll:bootstrap/running>", 560, "run"], ["lab.py", line, fn]], { facts }), source);
  const songFacts = { definitions: { ITunesSong: defClass(["name", "singer", "year"]) } };

  /** Nothing a student never typed should ever reach them. */
  const INTERNALS = [/__init__/, /types\.UnionType/, /__main__/, /_Rectangle/, /NoneType/];
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
    { definitions: { pen_cost: defFunction(["num_pens", "message"]) } },
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
    { definitions: { add_shipping: defFunction(["order_amt"]) } },
  );
  expect(
    tooMany.headline === "`add_shipping` takes 1 argument (`order_amt`), but got 2.",
    `too many args: ${tooMany.headline}`,
  );

  // A library function has no `def` in the file, but Python has its
  // definition, so the total is named just as it is for the student's.
  const lib = "from pll.image import circle\n\ncircle(50)\n";
  const missing = raised(
    lib,
    3,
    "<module>",
    "TypeError: circle() missing 2 required positional arguments: 'mode' and 'color'",
    { definitions: { circle: defFunction(["radius", "mode", "color"]) } },
  );
  expect(
    missing.headline === "`circle` takes 3 arguments (`radius`, `mode` and `color`), but got 1.",
    `library call: ${missing.headline}`,
  );

  // A function Python could not find the definition of: only what it named.
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
  expect(
    testArg.howToFix?.[0] ===
      "Write `def test_pen_cost():`, with nothing in the brackets, and use example values in its `assert`s instead of `n`.",
    `and what to write instead: ${JSON.stringify(testArg.howToFix)}`,
  );

  // A method of PLL's own libraries: Python names the class the student
  // never typed (`Table.scatter_plot()` for `movies.scatter_plot(...)`).
  const method = raised(
    'from pll.table import table\n\nmovies = table(["x", "y"], [[1, 2]])\nmovies.scatter_plot("x")\n',
    4,
    "<module>",
    "TypeError: Table.scatter_plot() missing 1 required positional argument: 'y'",
    { definitions: { "Table.scatter_plot": defFunction(["x", "y", "title"], ["x", "y"]) } },
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
    songFacts,
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
    songFacts,
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
    songFacts,
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
    songFacts,
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
  // A `for` failing on its value, as a run's traceback says it did.
  const rangeLen = raised(loop, 3, "total", "TypeError: 'int' object is not iterable", { instruction: "GET_ITER" });
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
  // Where the text came from is not guessed from the file reading a CSV.
  expect(
    !blank.howToFix.some((l) => /CSV/.test(l)),
    `no CSV cell guessed at: ${JSON.stringify(blank.howToFix)}`,
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
  const unionCall = raised(union, 5, "make", "TypeError: 'types.UnionType' object is not callable", {
    definitions: { Animal: defUnion(["Boa", "Armadillo"]) },
  });
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
    { definitions: { Boa: defClass(["name", "length"]) } },
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
  // is a real file in this repo, and a plain dict `KeyError` in it is not a
  // missing DataFrame column.
  const notPandas = finding(
    pyErrorLine("KeyError: 'bob'", [["pandas.py", 2]]),
    'ages = {"alice": 30}\nprint(ages["bob"])\n',
  );
  expect(
    !/no column named/.test(notPandas.headline),
    `a dict in a file named pandas.py is not a DataFrame: ${notPandas.headline}`,
  );

  // A module that is not there, said as why: each kind of reason its own.
  const missingModule = (module) =>
    finding(pyErrorLine(`ModuleNotFoundError: No module named '${module.name}'`, [["lab.py", 1]], { facts: { module } }),
      `import ${module.name}\n`);
  const said = (f) => `${f.headline}\n${f.howToFix.join("\n")}`;
  const why = {
    leftOut: missingModule({ name: "big", kind: "leftOut", why: "it is over 10 MB", close: null, package: null }),
    notLoaded: missingModule({ name: "micropip", kind: "notLoaded", package: "micropip", why: null }),
    missing: missingModule({ name: "flask", kind: "missing", why: null, package: null }),
  };
  expect(why.leftOut.headline === "`big.py` is next to your program, but it was not loaded: it is over 10 MB.", `left out: ${why.leftOut.headline}`);
  // Offline the first time, or imported in a way that could not be read
  // before the run: both are said, the connection first.
  expect(why.notLoaded.headline === "`micropip` was not loaded before your program ran." &&
    /downloads `micropip` the first time/.test(why.notLoaded.howToFix[0]) && why.notLoaded.howToFix[1].includes("add `import micropip`"),
    `not loaded: ${said(why.notLoaded)}`);
  expect(/Pyodide, which has many packages/.test(said(why.missing)), `missing: ${said(why.missing)}`);

  // -- a `case` pattern's class that nothing defines, as the program runs --
  // At advanced, where no static check stops it first: from the running
  // program, so an alias a static reading could not follow is read too.
  {
    const PETS = [
      "from dataclasses import dataclass", "", "@dataclass", "class Boa:", "    name: str", "",
      "@dataclass", "class Armadillo:", "    name: str", "", "Animal = Boa | Armadillo",
      "type Beast = Boa | Armadillo", "",
    ].join("\n");
    const caught = (annotation, pattern) =>
      ran(`${PETS}\ndef name_of(a${annotation}) -> str:\n    match a:\n        case ${pattern}:\n            return "?"\n    return ""\n\nprint(name_of(Boa("Ayisha")))\n`, "pets.py", "advanced");
    const alias = caught(": Animal", "Aardvark(b)");
    expect(
      alias?.headline === "There is no class `Aardvark`: an `Animal` is a `Boa` or an `Armadillo`." &&
        alias?.howToFix.join("|") ===
          "Match one of them: `case Boa(...)` or `case Armadillo(...)`.|If an `Aardvark` is a new kind of `Animal`, define `class Aardvark` and add it: `Animal = Boa | Armadillo | Aardvark`." &&
        alias?.lineNumber === 16,
      `the subject's variants, at the case: ${said(alias ?? { headline: "", howToFix: [] })} ${alias?.lineNumber}`,
    );
    for (const [annotation, headline] of [
      [": Beast", "There is no class `Aardvark`: a `Beast` is a `Boa` or an `Armadillo`."],
      [': "Animal"', "There is no class `Aardvark`: an `Animal` is a `Boa` or an `Armadillo`."],
      [": Boa | Armadillo", "There is no class `Aardvark`: `a` is a `Boa` or an `Armadillo`."],
      ["", "There is no class `Aardvark` for this `case` to match."],
    ]) {
      expect(caught(annotation, "Aardvark()")?.headline === headline, `a${annotation}: ${caught(annotation, "Aardvark()")?.headline}`);
    }
    expect(caught("", "Aardvark()")?.howToFix[0] === "The classes this program has are `Armadillo` and `Boa`.",
      `the classes the program has: ${JSON.stringify(caught("", "Aardvark()")?.howToFix)}`);
    expect(caught(": Animal", "Armadilo()")?.howToFix.join("|") === "Did you mean `Armadillo`?",
      `a misspelling: ${JSON.stringify(caught(": Animal", "Armadilo()")?.howToFix)}`);
    // A name that is not a pattern's class is the ordinary NameError still.
    const plain = ran(`${PETS}\ndef f(a: Animal) -> str:\n    match a:\n        case Boa(n):\n            return nme\n    return ""\n\nprint(f(Boa("x")))\n`, "pets.py", "advanced");
    expect(plain?.headline === "Python doesn't know what `nme` means.", `not a pattern: ${plain?.headline}`);
    // Nor one in a guard on the pattern's own line.
    const guard = ran(`${PETS}\ndef f(a: Animal) -> str:\n    match a:\n        case Boa(n) if n == nam:\n            return n\n    return ""\n\nprint(f(Boa("x")))\n`, "pets.py", "advanced");
    expect(guard?.headline === "Python doesn't know what `nam` means.", `a guard's name: ${guard?.headline}`);
  }

  // -- a class passed where one of its instances was wanted --------------
  const classItself = ran(
    `${song.split("\n\n\ns = ")[0]}\n\n\ndef title(s: ITunesSong) -> str:\n    return s.name\n\n\nprint(title(ITunesSong))\n`,
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
    songFacts,
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
    { definitions: { total: defFunction(["n"]) } },
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
    { definitions: { table: defFunction(["columns", "rows"]) } },
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
    { definitions: { ITunesSong: defClass(["name", "singer", "year"], false) } },
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
  // Nothing to import at a level that gives every file `dataclass`; at raw, the import.
  expect(!noDecorator.howToFix.some((l) => /import/.test(l)), `nothing to import at beginner: ${JSON.stringify(noDecorator.howToFix)}`);
  const noDecoratorRaw = explained(
    pyErrorLine("TypeError: ITunesSong() takes no arguments", [["<pll:bootstrap/running>", 560, "run"], ["lab.py", 7, "<module>"]], {
      facts: { definitions: { ITunesSong: defClass(["name", "singer", "year"], false) } },
    }),
    "class ITunesSong:\n    name: str\n    singer: str\n    year: int\n\n\ns = ITunesSong(\"a\", \"b\", 1)\n",
    "lab.py",
    "raw",
  );
  expect(
    noDecoratorRaw.howToFix.at(-1) === "Add `from dataclasses import dataclass` at the top of the file if it is not there.",
    `at raw, the import too: ${JSON.stringify(noDecoratorRaw.howToFix)}`,
  );

  // An `add_column` elsewhere in the file is not taken to be the cause.
  const discarded = raised(
    'employees = table(["name"], [["Harley"]])\nemployees.add_column("total-wage", lambda r: 1)\nemployees.select_columns(["total-wage"])\n',
    3,
    "<module>",
    'KeyError: \'the table has no column "total-wage" (it has: name).\'',
  );
  expect(
    /has no column "total-wage"/.test(discarded.headline) && discarded.howToFix.length === 0,
    `PLL's own message, and no guess: ${discarded.headline} ${JSON.stringify(discarded.howToFix)}`,
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

console.log("[name errors: the hint that fits, not the one that always fits]");
{
  const raised = (source) => ran(source, "lab.py", "raw");

  // A name an import provides. Python's own suggestion for `pd` is `id`,
  // a real built-in with nothing to do with pandas.
  const pandas = raised('movies = pd.DataFrame({"a": [1]})\n');
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
  const later = raised("height = width * 3\nwidth = 10\nprint(height)\n");
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
    'def below_1k(r):\n    return r["riders"] < 1000\n\n\nt = table(["riders"], [[5]])\nprint(t.filter(below_1k(r)))\n',
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
  const returned = raised("def rest(xs) -> NumList:\n    return xs\n\n\nNumList = int\nrest(1)\n");
  expect(
    returned.howToFix.some((l) => /`-> "NumList"`/.test(l)),
    `a return type is shown as itself: ${JSON.stringify(returned.howToFix)}`,
  );

  // An ordinary name defined later still gets "move it up", which for a
  // plain value is the right answer.
  const ordinary = raised("height = width * 3\nwidth = 10\nprint(height)\n");
  expect(
    ordinary.howToFix.some((l) => /Move the definition of `width`/.test(l)),
    `a value defined later is still moved: ${JSON.stringify(ordinary.howToFix)}`,
  );

  // A name that really is just unknown keeps the general advice.
  const unknown = raised("print(Total)\n");
  expect(
    unknown.headline === "Python doesn't know what `Total` means.",
    `an unknown name: ${unknown.headline}`,
  );
  expect(
    unknown.howToFix.some((l) => /spelling/.test(l)),
    `still mentions spelling: ${JSON.stringify(unknown.howToFix)}`,
  );

  // Read as a type, a name from another language is the type it means -
  // Python suggests nothing for `string`, or a module to import - wherever
  // in the annotation it is.
  const TYPES = [
    ["a parameter's", "def stand(cups: string) -> int:\n    return 1\n", "string", ["Write `str` instead."]],
    ["a return type", "def ok() -> boolean:\n    return True\n", "boolean", ["Write `bool` instead."]],
    ["inside brackets", "def count(xs: dict[str, integer]) -> int:\n    return 1\n", "integer", ["Write `int` instead."]],
    ["typing's, not imported", "def total(xs: List[int]) -> int:\n    return 1\n", "List", ["Write `list` instead."]],
    ["a variable's", "cups: integer = 3\n", "integer", ["Write `int` instead."]],
    ["a number", "def half(n: Number) -> int:\n    return 1\n", "Number", ["Write `float` instead.", "Or `int`, if it is always a whole number."]],
    ["a `type` alias's", "type Pair = tuple[int, string]\nprint(Pair.__value__)\n", "string", ["Write `str` instead."]],
  ];
  for (const [what, source, name, fix] of TYPES) {
    const got = raised(source);
    expect(
      got.headline === `\`${name}\` is not a type Python knows.` && JSON.stringify(got.howToFix) === JSON.stringify(fix),
      `${what}: ${got.headline} ${JSON.stringify(got.howToFix)}`,
    );
  }
  // One that is no type of any language keeps the spelling, and is not
  // told to put the type in quotes, which names the same missing thing.
  const unknownType = raised("def f(n: Foo) -> int:\n    return 1\n");
  expect(
    unknownType.headline === "Python doesn't know what `Foo` means." &&
      unknownType.howToFix.some((l) => /spelling/.test(l)) &&
      unknownType.howToFix.some((l) => /An annotation names a type/.test(l)) &&
      !unknownType.howToFix.some((l) => /quotes/.test(l)),
    `an unknown type: ${JSON.stringify(unknownType.howToFix)}`,
  );
  // And `string` that is not a type is still a name.
  const notAType = raised("print(string)\n");
  expect(
    notAType.headline === "Python doesn't know what `string` means." && notAType.howToFix.some((l) => /quotes/.test(l)),
    `outside an annotation: ${notAType.headline} ${JSON.stringify(notAType.howToFix)}`,
  );
  console.log("    an import, a later definition, a parameter, a plain typo, and types by other names");
}

console.log("[not iterable: the built-in that was given it, a `for` only where there is one]");
{
  const raised = (source) => ran(source, "lab.py", "raw");
  // [what, the program, the headline, and the first fix (or none)].
  const CASES = [
    ["`sum` given the numbers one by one", "print(sum(1, 3))\n",
      "`sum` adds up the items in a list, but `1` is a whole number.", "Put the numbers in a list: `sum([1, 3])`."],
    ["the same, the whole line", "sum(1, 3)\n", "`sum` adds up the items in a list, but `1` is a whole number.", "Put the numbers in a list: `sum([1, 3])`."],
    ["three of them", "print(sum(1, 2, 3))\n",
      "`sum` adds up the items in one list, not values given one by one.", "Put the numbers in a list: `sum([1, 2, 3])`."],
    ["`sum` given one number", "total = sum(4)\n", "`sum` adds up the items in a list, but `4` is a whole number.", "Give `sum` a list of the numbers to add."],
    ["`max` given one", "print(max(5))\n", "`max` needs a list, or two or more values, but `5` is a whole number.", null],
    ["`list` given a length", "xs = [3, 1]\nprint(list(len(xs)))\n",
      "`list` makes a list of the items of another collection, but `len(xs)` is a whole number.", null],
    ["`map`'s collection, second", "print(list(map(str, 5)))\n",
      "`map` applies a function to the items of a collection, but `5` is a whole number.", null],
    ["`zip`'s could be any", "print(list(zip([1], 5)))\n",
      "`zip` pairs up the items of lists or other collections, and one of the values it was given has no items.", null],
    ["`None` given to `sum`", "def f():\n    pass\nprint(sum(f()))\n", "`sum` adds up the items in a list, but `f(...)` gave back `None`.", null],
    // The loop failed on what `max` gave back: the `for` is the story.
    ["a `for` over what a built-in gave back", "for x in max([1, 2]):\n    print(x)\n", "A whole number is not something to loop over.",
      "`for` needs a list, a string, a range or something else with items in it."],
    ["a comprehension", "print([x for x in 5])\n", "A whole number is not something to loop over.", null],
    ["their own `sum`, with a `for` in it", "def sum(xs):\n    t = 0\n    for x in xs:\n        t += x\n    return t\nprint(sum(5))\n",
      "A whole number is not something to loop over.", null],
    // What cannot be told is not guessed at: no `for`, and no function.
    ["a built-in by another name", "add = sum\nprint(add(5))\n", "A whole number has no items to go through.",
      "Use a list, a string, a range or something else with items in it."],
    ["the program's own `sum`, which is not the built-in", "sum = sorted\nprint(sum(5))\n", "A whole number has no items to go through.", null],
    ["one that is not in the list", "print(iter(5))\n", "A whole number has no items to go through.", null],
    ["`None`, given to one of those", "print(iter(None))\n", "This value is `None`, so it has no items to go through.", null],
  ];
  for (const [what, source, headline, fix] of CASES) {
    const got = raised(source);
    expect(got.headline === headline, `${what}: ${got.headline}`);
    if (fix !== null) expect(got.howToFix[0] === fix, `${what}, the fix: ${JSON.stringify(got.howToFix)}`);
    if (!/for`|loop/.test(headline)) expect(!/`for`|loop/.test(got.howToFix.join(" ")), `${what}, no loop: ${JSON.stringify(got.howToFix)}`);
  }
  console.log(`    ${CASES.length} programs`);
}

console.log("[not callable: the name that was called; pictures as images]");
{
  const raised = (source) => ran(source, "lab.py", "raw");
  const IMAGE = "from pll.image import *\n";
  const BARE = "Brackets after a value mean a call; check whether a `*` or a comma is missing.";
  const LEAVE = (name) => `Leave off the brackets to use the value itself: \`${name}\`.`;
  // [what, the program, the headline, and the first fix (or none)].
  const CASES = [
    ["a value from the image library", `${IMAGE}empty_image()\n`, "`empty_image` is an image, not a function.", LEAVE("empty_image")],
    ["inside another call", `${IMAGE}print(beside(empty_image(), circle(5, "solid", "red")))\n`,
      "`empty_image` is an image, not a function.", LEAVE("empty_image")],
    ["a chart", 'from pll.table import *\nt = table(["x"], [[1], [2]])\nh = t.histogram("x")\nh()\n', "`h` is an image, not a function.", LEAVE("h")],
    ["given arguments", "x = 5\nprint(x(3))\n", "`x` is a whole number, not a function.", BARE],
    ["a name ending in a digit", "x2 = 4\nprint(x2(3))\n", "`x2` is a whole number, not a function.", BARE],
    ["a field", "from dataclasses import dataclass\n\n\n@dataclass\nclass P:\n    x: int\n\n\np = P(1)\np.x()\n",
      "`p.x` is a whole number, not a function.", LEAVE("p.x")],
    ["a local", "def f(n):\n    total = n\n    return total()\n\n\nf(3)\n", "`total` is a whole number, not a function.", LEAVE("total")],
    ["`None`", "x = None\nx()\n", "`x` is `None`, not a function.", LEAVE("x")],
    ["one of the student's classes", "class Elephant:\n    pass\n\n\ne = Elephant()\ne()\n", "`e` is an `Elephant`, not a function.", LEAVE("e")],
    ["a built-in's name", "sum = 0\nprint(sum([1, 2]))\n", "`sum` is a whole number, not a function.",
      "A variable named `sum` hides Python's own `sum`: give the variable a different name."],
    // What cannot be told is not guessed at: the call that failed is not
    // a name's, or the name's value is not what failed.
    ["a built-in calls it", "print(list(map(5, [1])))\n", "A whole number cannot be called like a function.", BARE],
    ["an image with no name", `${IMAGE}text("hi", 10, "red")()\n`, "An image cannot be called like a function.", BARE],
    ["what a method gave back", 's = "abc"\ns.upper()()\n', "A string cannot be called like a function.", BARE],
    ["a property, which is not run again", "class C:\n    @property\n    def n(self):\n        return 5\n\n\nc = C()\nc.n()\n",
      "A whole number cannot be called like a function.", BARE],
    ["what a call gave back", "class C:\n    n = 5\n\n\nC().n()\n", "A whole number cannot be called like a function.", BARE],
    ["given a keyword", "x = 5\nprint(x(n=3))\n", "`x` is a whole number, not a function.", BARE],
    ["a type a module names", "import datetime\nd = datetime.date(2026, 1, 1)\nd()\n", "`d` is a `date`, not a function.", LEAVE("d")],
    ["a number before brackets", "print(3(4))\n", "Brackets after `3` look like a function call, not multiplication.", null],
    // The picture classes, wherever a rule names a type.
    ["a `for` over an image", `${IMAGE}for x in empty_image:\n    pass\n`, "An image is not something to loop over.", null],
    ["square brackets", `${IMAGE}empty_image[0]\n`, "Square brackets do not work on an image.", null],
    ["no such attribute", `${IMAGE}c = circle(10, "solid", "red")\nc.append(1)\n`, "An image has no `append`.", null],
    ["two images compared", `${IMAGE}print(circle(10, "solid", "red") < square(10, "solid", "red"))\n`,
      "`<` cannot compare one image with another.", "These values have no order, so `<` has no answer for them."],
    ["two dictionaries", 'print({"a": 1} < {"b": 2})\n', "`<` cannot compare one dictionary with another.", null],
    ["an image and a number", `${IMAGE}print(circle(10, "solid", "red") * 2)\n`, "`*` does not work between an image and a whole number.", null],
    ["Python's own words", `${IMAGE}print(len(empty_image))\n`, "object of type 'Image' has no len().", null],
    ["an article for a vowel", "class Elephant:\n    pass\n\n\nfor x in Elephant():\n    pass\n", "An `Elephant` is not something to loop over.", null],
    ["and in a fix", "class Elephant:\n    pass\n\n\nElephant().trunk\n", "`Elephant` has no fields at all, so it has no `trunk`.",
      "A value that might be an `Elephant` needs a `case Elephant():` before `.trunk` is used."],
  ];
  for (const [what, source, headline, fix] of CASES) {
    const got = raised(source);
    expect(got.headline === headline, `${what}: ${got.headline}`);
    if (fix !== null) expect(got.howToFix[0] === fix, `${what}, the fix: ${JSON.stringify(got.howToFix)}`);
    const text = `${got.headline} ${got.howToFix.join(" ")}`;
    expect(!/\b_[A-Z]\w*|_Pll/.test(text), `${what} names no class of PLL's own: ${text}`);
  }
  // A class of the student's own keeps its name, underscore and all.
  const own = raised("class _Box:\n    pass\n\n\nprint(len(_Box()))\n");
  expect(own.headline === "object of type '_Box' has no len().", `a class of theirs: ${own.headline}`);
  const capture = raised("class Elephant:\n    pass\n\n\ndef f(a):\n    match a:\n        case Elephant:\n            return 1\n        case int():\n            return 2\n");
  expect(
    capture.howToFix[1] === "With them, `case Elephant():` matches only an `Elephant`; put one name inside for each field.",
    `a capture pattern's article: ${JSON.stringify(capture.howToFix)}`,
  );
  // At a prompt line, whose source is the line itself.
  pllCall("_pll_repl_eval", JSON.stringify([IMAGE, "callable-prompt", "raw"]));
  const prompt = JSON.parse(pllCall("_pll_repl_eval", JSON.stringify(["empty_image()", "callable-prompt", "raw"])));
  expect(
    prompt.error?.finding?.headline === "`empty_image` is an image, not a function.",
    `a prompt line: ${prompt.error?.finding?.headline}`,
  );
  console.log(`    ${CASES.length} programs and a prompt line`);
}

console.log("[bitwise operators: refused between numbers at beginner and intermediate]");
{
  const runOf = (source, level) => {
    runs += 1;
    return JSON.parse(pllCall("_pll_run_file", JSON.stringify([source, "bw.py", `bitwise-${runs}`, level, false])));
  };
  // [what, the program, the headline, and the first fix].
  const CASES = [
    ["`^`, which is no power", "n = 5\nprint(n ^ 2)\n",
      "`n ^ 2` gives 7: `^` is not a power in Python, but works on the binary digits of the numbers.", "For a power, write `n ** 2`."],
    ["and in place", "total = 5\ntotal ^= 2\n",
      "`total ^= 2` gives 7: `^` is not a power in Python, but works on the binary digits of the numbers.", "For a power, write `total **= 2`."],
    ["`|` between conditions", "a = True\nb = False\nprint(a | b)\n",
      '`a | b` gives True: between numbers, `|` is not "or", but works on their binary digits.', "Between two conditions, write `or`."],
    ["`&`", "print(6 & 3)\n", '`6 & 3` gives 2: between numbers, `&` is not "and", but works on their binary digits.', "Between two conditions, write `and`."],
    ["a shift", "x = 3\nprint(x << 2)\n", "`x << 2` shifts the binary digits of `x`.", "To multiply by a power of 2, write `x * 2 ** 2`."],
    ["`~`, in a function", "def f(k):\n    return ~k\n\nprint(f(5))\n",
      '`~k` gives -6: `~` is not "not", but turns over the binary digits of a number.', 'For "not", write `not k`.'],
  ];
  for (const [what, source, headline, fix] of CASES) {
    const finding = runOf(source, "beginner").error?.finding;
    expect(finding?.headline === headline && finding?.howToFix[0] === fix, `${what}: ${finding?.headline} ${JSON.stringify(finding?.howToFix)}`);
  }
  // What is not bitwise goes on as Python does it: types, sets, dictionaries, a mask's own `&`.
  const fine = runOf(
    "class Mask:\n    def __and__(self, other):\n        return 'both'\n\n" +
      "Pair = int | str\nprint(isinstance(3, Pair), {1, 2} & {2}, {1} ^ {2}, {'a': 1} | {'b': 2}, Mask() & Mask())\n",
    "intermediate",
  );
  expect(fine.stdout === "True {2} {1, 2} {'a': 1, 'b': 2} both\n", `not bitwise: ${fine.stdout} ${fine.error?.message ?? ""}`);
  // Where a set may be changed in place, `|=` changes the same set.
  const grown = runOf("def grow(s: set[int]) -> set[int]:\n    t = s\n    s |= {3}\n    return t\n\nprint(grow({1}))\n", "advanced");
  expect(grown.stdout === "{1, 3}\n", `in place: ${grown.stdout} ${grown.error?.message ?? ""}`);
  // An annotation is left as written: kept as text, it is read again later.
  const future = runOf("from __future__ import annotations\n\ndef f(x: int | None) -> int:\n    return 0 if x is None else x\n\nprint(f(None), f.__annotations__['x'])\n", "beginner");
  expect(future.stdout === "0 int | None\n", `annotations kept as text: ${future.stdout} ${future.error?.message ?? ""}`);
  // And between numbers it is allowed at advanced and raw.
  for (const level of ["advanced", "raw"]) {
    const allowed = runOf("n = 5\nprint(n ^ 2, ~n, 3 << 2)\n", level);
    expect(allowed.stdout === "7 -6 12\n", `${level}: ${allowed.stdout} ${allowed.error?.message ?? ""}`);
  }
  console.log(`    ${CASES.length} refused; types, sets, dictionaries and a mask's & untouched; advanced and raw allow it`);
}

console.log("[changing a list, a dictionary, a set or a dataclass in place: refused at beginner and intermediate]");
{
  const runOf = (source, level) => {
    runs += 1;
    return JSON.parse(pllCall("_pll_run_file", JSON.stringify([source, "mut.py", `mutation-${runs}`, level, false])));
  };
  const ALLOWED = (noun) => `Python allows changing ${noun} in place, and so does \`#level advanced\`.`;
  // [what, the program, the headline, what to write instead].
  const CASES = [
    ["append", "xs = [1]\nxs.append(2)\n", "`xs.append(2)` changes a list in place, which is not allowed at `#level beginner`.",
      "Make a new list with it on the end: `xs + [2]`."],
    ["sort, with its arguments", "xs = [3, 1]\nxs.sort(reverse=True)\n", "`xs.sort(reverse=True)` changes a list in place, which is not allowed at `#level beginner`.",
      "`sorted(xs, reverse=True)` is a new list, in order."],
    ["a method fetched and not called", "xs = [1]\nf = xs.pop\n", "`xs.pop` changes a list in place, which is not allowed at `#level beginner`.",
      "`xs[-1]` is the last item, and `xs[:-1]` a new list without it."],
    ["a method's argument", "class Box:\n    def append(self, x):\n        return x\n\nxs = [1]\nBox().append(xs.pop())\n",
      "`xs.pop()` changes a list in place, which is not allowed at `#level beginner`.", "`xs[-1]` is the last item, and `xs[:-1]` a new list without it."],
    ["pop from the middle", "xs = [5, 6, 7]\nprint(xs.pop(1))\n", "`xs.pop(1)` changes a list in place, which is not allowed at `#level beginner`.",
      "`xs[1]` is the item, and `xs[:1] + xs[2:]` a new list without it."],
    ["remove", "xs = [5, 6]\nxs.remove(5)\n", "`xs.remove(5)` changes a list in place, which is not allowed at `#level beginner`.",
      "With `i = xs.index(5)`, `xs[:i] + xs[i + 1:]` is a new list without it."],
    ["an item set", "xs = [5, 6, 7]\nxs[2] = 9\n", "`xs[2] = 9` changes a list in place, which is not allowed at `#level beginner`.",
      "`xs[:2] + [9] + xs[3:]` is a new list with it changed."],
    ["an item deleted", "xs = [5, 6, 7]\ndel xs[0]\n", "`del xs[0]` changes a list in place, which is not allowed at `#level beginner`.",
      "`xs[1:]` is a new list without it."],
    ["an item added to", "xs = [5, 6, 7]\nxs[0] += 10\n", "`xs[0] += 10` changes a list in place, which is not allowed at `#level beginner`.",
      "`[xs[0] + 10] + xs[1:]` is a new list with it changed."],
    ["a key set", 'd = {"a": 1}\nd["b"] = 2\n', '`d["b"] = 2` changes a dictionary in place, which is not allowed at `#level beginner`.',
      '`d | {"b": 2}` is a new dictionary with it changed.'],
    ["a key added to", 'd = {"a": 1}\nd["a"] *= 2 + 1\n', '`d["a"] *= 2 + 1` changes a dictionary in place, which is not allowed at `#level beginner`.',
      '`d | {"a": d["a"] * (2 + 1)}` is a new dictionary with it changed.'],
    ["a key deleted", 'd = {"a": 1}\ndel d["a"]\n', '`del d["a"]` changes a dictionary in place, which is not allowed at `#level beginner`.',
      "For a dictionary without it, start from `{}` and add each other key with `|`."],
    ["update", 'd = {"a": 1}\nd.update({"b": 2})\n', '`d.update({"b": 2})` changes a dictionary in place, which is not allowed at `#level beginner`.',
      '`d | {"b": 2}` is a new dictionary with both.'],
    ["update with a keyword", 'd = {"a": 1}\nd.update(b=2)\n', '`d.update(b=2)` changes a dictionary in place, which is not allowed at `#level beginner`.',
      '`d | {"b": 2}` is a new dictionary with both.'],
    ["update of several, made sets", "s = {1}\ns.update([2], [3])\n", "`s.update([2], [3])` changes a set in place, which is not allowed at `#level beginner`.",
      "Make a new set of all of them: `s | set([2]) | set([3])`."],
    ["extend by a range, made a list", "xs = [1]\nxs.extend(range(3))\n", "`xs.extend(range(3))` changes a list in place, which is not allowed at `#level beginner`.",
      "Make a new list of both: `xs + list(range(3))`."],
    ["insert at the front", "xs = [1, 2]\nxs.insert(0, 5)\n", "`xs.insert(0, 5)` changes a list in place, which is not allowed at `#level beginner`.",
      "Make a new list with it at that place: `[5] + xs`."],
    ["pop with a default", 'd = {"a": 1}\nd.pop("a", None)\n', '`d.pop("a", None)` changes a dictionary in place, which is not allowed at `#level beginner`.',
      '`d.get("a", None)` is the value. For a dictionary without it, start from `{}` and add each other key with `|`.'],
    ["a method through its class", "xs = [1]\nlist.append(xs, 2)\n", "`list.append(xs, 2)` changes a list in place, which is not allowed at `#level beginner`.",
      "Make a new list with it on the end: `xs + [2]`."],
    ["shuffle", "import random\n\nxs = [1, 2, 3]\nrandom.shuffle(xs)\n", "`random.shuffle(xs)` changes `xs` in place, which is not allowed at `#level beginner`.",
      "`random.sample(xs, len(xs))` is a new list of the same items, in a random order."],
    ["shuffle named on its own", "from random import shuffle\n\nxs = [1, 2, 3]\nshuffle(xs)\n", "`shuffle(xs)` changes `xs` in place, which is not allowed at `#level beginner`.",
      "`sample(xs, len(xs))` is a new list of the same items, in a random order, with `from random import sample`."],
    ["insort", "import bisect\n\nxs = [1, 3]\nbisect.insort(xs, 2)\n", "`bisect.insort(xs, 2)` changes `xs` in place, which is not allowed at `#level beginner`.",
      "`sorted(xs + [2])` is a new list with it in order."],
    ["a set's add", "s = {1}\ns.add(2)\n", "`s.add(2)` changes a set in place, which is not allowed at `#level beginner`.", "Make a new set with it: `s | {2}`."],
    ["a table's row", 't = table(["a"], [[1]])\nr = t.row(0)\nr["a"] = 2\n', '`r["a"] = 2` changes a dictionary in place, which is not allowed at `#level beginner`.', null],
    ["a field", 'from dataclasses import dataclass\n\n@dataclass\nclass Dog:\n    name: str\n    age: int\n\nd = Dog("Rex", 3)\nd.age = 4\n',
      "Setting the `age` field changes a `Dog` in place, which is not allowed at `#level beginner`.",
      "Make a new `Dog` with the change instead: `replace(d, age=4)`, with `from dataclasses import replace`."],
  ];
  for (const [what, source, headline, instead] of CASES) {
    const finding = runOf(source, "beginner").error?.finding;
    expect(finding?.errorType === "Mutation" && finding?.headline === headline, `${what}: ${finding?.headline}`);
    if (instead !== null) expect(finding?.howToFix[0] === instead, `${what}, instead: ${JSON.stringify(finding?.howToFix)}`);
    expect(/^Python allows changing .*, and so does `#level advanced`\.$/.test(finding?.howToFix.at(-1) ?? ""), `${what}, allowed elsewhere: ${JSON.stringify(finding?.howToFix)}`);
  }
  // `+=` on a list changes it; on a number it gives a new one.
  const inPlace = runOf("def grow(xs: list[int]) -> list[int]:\n    xs += [4]\n    return xs\n\ngrow([1])\n", "intermediate").error?.finding;
  expect(
    inPlace?.headline === "`xs += [4]` changes a list in place, which is not allowed at `#level intermediate`." &&
      inPlace.howToFix[0] === "`xs + [4]` is a new list, and leaves `xs` as it was." && inPlace.howToFix[1] === ALLOWED("a list"),
    `+= on a list: ${inPlace?.headline} ${JSON.stringify(inPlace?.howToFix)}`,
  );
  // Refused with no one new value to suggest: a slice, items among several
  // targets (a swap), a method not called, and what `*` hands over.
  const NO_INSTEAD = [
    ["xs = [5, 6, 7]", "xs[0:2] = [1]", "a list"],
    ["xs = [5, 6, 7]", "xs[0:2] += [1]", "a list"],
    ["xs = [5, 6, 7]", "del xs[0:2]", "a list"],
    ["xs = [5, 6, 7]", "xs[::2] = [0, 0]", "a list"],
    ["xs = [5, 6, 7]", "xs[0], xs[2] = xs[2], xs[0]", "a list"],
    ["xs = [5, 6, 7]", "a = xs[0] = 9", "a list"],
    ['d = {"a": 1}', 'k, d["a"] = "b", 2', "a dictionary"],
    ["xs = [5, 6, 7]", "f = xs.append", "a list", "xs.append"],
    ["s = {1}\nls = [[2], [3]]", "s.update(*ls)", "a set"],
    ["xs = [5, 6, 7]\nwhere = (0, 1)", "xs.insert(*where)", "a list"],
    ["xs = [5, 6, 7]", "f = list.pop", "a list", "list.pop"],
    ["xs = [5, 6, 7]", "for xs[0] in range(3):\n    pass", "a list", "for xs[0] in range(3)"],
    ["xs = [5, 6, 7]", "ys = [0 for xs[1] in range(3)]", "a list", "for xs[1] in range(3)"],
  ];
  for (const [setup, written, noun, shown = written] of NO_INSTEAD) {
    const found = runOf(`${setup}\n${written}\n`, "beginner").error?.finding;
    expect(
      found?.headline === `\`${shown}\` changes ${noun} in place, which is not allowed at \`#level beginner\`.` &&
        found.howToFix.length === 1 && found.howToFix[0] === ALLOWED(noun),
      `no one new value for ${written}: ${found?.headline} ${JSON.stringify(found?.howToFix)}`,
    );
  }
  // A library function that changes a list: refused however it is reached,
  // at the level the file is at, with no new list to suggest for a heap.
  const ALLOWED_LIST = ALLOWED("a list");
  const heaped = runOf("import heapq\n\nh = [3, 1]\nheapq.heappush(h, 2)\n", "beginner").error?.finding;
  expect(
    heaped?.headline === "`heapq.heappush(h, 2)` changes `h` in place, which is not allowed at `#level beginner`." &&
      heaped.howToFix.length === 1 && heaped.howToFix[0] === ALLOWED_LIST,
    `heappush: ${heaped?.headline} ${JSON.stringify(heaped?.howToFix)}`,
  );
  const named = runOf("from random import shuffle\n\nmix = shuffle\n", "beginner").error?.finding;
  expect(
    named?.headline === "`shuffle` changes the list it is given in place, which is not allowed at `#level beginner`.",
    `shuffle named and not called: ${named?.headline}`,
  );
  const mixed = runOf("import random\n\ndef mix(xs: list[int]) -> list[int]:\n    random.shuffle(xs)\n    return xs\n\nmix([1, 2])\n", "intermediate").error?.finding;
  expect(
    mixed?.headline === "`random.shuffle(xs)` changes `xs` in place, which is not allowed at `#level intermediate`.",
    `shuffle at intermediate: ${mixed?.headline}`,
  );
  // What only looks like one is left alone: a function of their own called
  // `shuffle`, `random.sample`, and what reads through a class.
  const lookalikes = runOf(
    "import random\n\ndef shuffle(deck: list[int]) -> list[int]:\n    return deck[::-1]\n\nxs = [1, 2, 3]\n" +
      "print(shuffle(xs), sorted(random.sample(xs, len(xs))), xs, dict.get({'a': 1}, 'a'), list.index(xs, 2))\n",
    "beginner",
  );
  expect(lookalikes.stdout === "[3, 2, 1] [1, 2, 3] [1, 2, 3] 1 1\n", `look-alikes: ${lookalikes.stdout} ${lookalikes.error?.message ?? ""}`);
  // A set has no items to set, as Python says; a class's own `__setitem__` is its own.
  const setItem = runOf("s = {1}\ns[0] = 2\n", "beginner").error?.finding;
  expect(setItem?.errorType === "TypeError", `an item of a set: ${setItem?.errorType} ${setItem?.headline}`);
  const ownItems = runOf("class Grid:\n    def __setitem__(self, k, v):\n        print(k, v)\n\ng = Grid()\ng[0], g[1] = 5, 6\n", "beginner");
  expect(ownItems.stdout === "0 5\n1 6\n", `a class's own items: ${ownItems.stdout} ${ownItems.error?.message ?? ""}`);
  // On an attribute: what it holds is refused before it changes - for a
  // dataclass's field, as setting the field is - and the rest is Python's.
  const DATACLASS = "from dataclasses import dataclass\n\n@dataclass\nclass Library:\n    books: list[str]\n\n";
  const shelved = runOf(DATACLASS + 'lib = Library([])\ntry:\n    lib.books += ["b"]\nfinally:\n    print(lib.books)\n', "beginner");
  expect(
    shelved.stdout === "[]\n" &&
      shelved.error?.finding?.headline === "Setting the `books` field changes a `Library` in place, which is not allowed at `#level beginner`." &&
      shelved.error.finding.howToFix[0] === 'Make a new `Library` with the change instead: `replace(lib, books=lib.books + ["b"])`, with `from dataclasses import replace`.',
    `+= on a field holding a list: ${shelved.stdout} ${shelved.error?.finding?.headline} ${JSON.stringify(shelved.error?.finding?.howToFix)}`,
  );
  const OWN = "class Shelf:\n    def __init__(self):\n        self.things = []\n        self.count = 0\n\n";
  const own = runOf(OWN + "    def add(self, x):\n        self.things += [x]\n\nShelf().add(1)\n", "beginner").error?.finding;
  expect(
    own?.headline === "`self.things += [x]` changes a list in place, which is not allowed at `#level beginner`." &&
      own.howToFix[0] === "`self.things + [x]` is a new list, and leaves `self.things` as it was.",
    `+= on an attribute holding a list: ${own?.headline} ${JSON.stringify(own?.howToFix)}`,
  );
  const counted2 = runOf(OWN + "    def add(self, x):\n        self.count += x\n\ns = Shelf()\ns.add(2)\nprint(s.count)\n", "beginner");
  expect(counted2.stdout === "2\n", `+= on an attribute holding a number: ${counted2.stdout} ${counted2.error?.message ?? ""}`);
  const shifted = runOf(OWN + "    def add(self, x):\n        self.count ^= x\n\nShelf().add(2)\n", "intermediate").error?.finding;
  expect(shifted?.errorType === "BitwiseOperator", `^= on an attribute: ${shifted?.errorType} ${shifted?.headline}`);
  const advancedShelf = runOf(OWN + "    def add(self, x):\n        self.things += [x]\n\ns = Shelf()\ns.add(1)\nprint(s.things)\n", "advanced");
  expect(advancedShelf.stdout === "[1]\n", `advanced, += on an attribute: ${advancedShelf.stdout} ${advancedShelf.error?.message ?? ""}`);
  // `xs += range(3)` works where `xs + range(3)` does not.
  const ranged = runOf("def grow(xs: list[int]) -> list[int]:\n    xs += range(3)\n    return xs\n\ngrow([1])\n", "intermediate").error?.finding;
  expect(ranged?.howToFix[0] === "`xs + list(range(3))` is a new list, and leaves `xs` as it was.", `+= a range: ${JSON.stringify(ranged?.howToFix)}`);
  // What it is in place of is an operation of its own: `s - t - u` would not be it.
  const takenAway = runOf("def less(s: set[int], t: set[int]) -> set[int]:\n    s -= t - {1}\n    return s\n\nless({1, 2}, {2, 3})\n", "intermediate").error?.finding;
  expect(takenAway?.howToFix[0] === "`s - (t - {1})` is a new set, and leaves `s` as it was.", `-= on a set: ${JSON.stringify(takenAway?.howToFix)}`);
  const counted = runOf("def total(xs: list[int]) -> int:\n    n = 0\n    for x in xs:\n        n += x\n    return n\n\nprint(total([1, 2, 3]))\n", "intermediate");
  expect(counted.stdout === "6\n", `+= on a number: ${counted.stdout} ${counted.error?.message ?? ""}`);
  const tallied = runOf(
    "class Tally:\n    def __init__(self):\n        self.n = 0\n\n    def __iadd__(self, k):\n        self.n = self.n + k\n        return self\n\n" +
      "def bump() -> int:\n    t = Tally()\n    t += 2\n    return t.n\n\nprint(bump())\n",
    "intermediate",
  );
  expect(tallied.stdout === "2\n", `+= on a class of one's own is its own __iadd__: ${tallied.stdout} ${tallied.error?.message ?? ""}`);
  // What gives a new value back is left alone, and so is what is not a list, a dictionary or a set.
  const reads = runOf(
    "xs = [3, 1, 2]\nd = {'a': 1}\nprint(xs.index(1), xs.count(3), sorted(xs), xs + [4], xs[::-1], d.get('a'), d | {'b': 2})\n" +
      "class Box:\n    def append(self, x):\n        return 'ok'\n\nprint(Box().append(1))\n",
    "beginner",
  );
  expect(reads.stdout === "1 1 [1, 2, 3] [3, 1, 2, 4] [2, 1, 3] 1 {'a': 1, 'b': 2}\nok\n", `left alone: ${reads.stdout} ${reads.error?.message ?? ""}`);
  // Allowed at advanced, and at raw.
  for (const level of ["advanced", "raw"]) {
    const allowed = runOf("xs = [1]\nxs.append(2)\nxs[0] = 0\ndel xs[1]\nd = {}\nd['a'] = 1\nxs[0], d['b'] = 5, 2\nprint(xs, d)\n", level);
    const reached = runOf("import random\n\nxs = [1, 2, 3]\nrandom.shuffle(xs)\nlist.append(xs, 4)\nfor xs[0] in range(3):\n    pass\nprint(len(xs), xs[0])\n", level);
    expect(reached.stdout === "4 2\n", `${level}, shuffle, a class's method and an item loop: ${reached.stdout} ${reached.error?.message ?? ""}`);
    expect(allowed.stdout === "[5] {'a': 1, 'b': 2}\n", `${level}: ${allowed.stdout} ${allowed.error?.message ?? ""}`);
  }
  console.log(`    ${CASES.length} refused, each with what to write instead; += on a number, reads and other classes left alone`);
}

console.log("[an iterator shown or printed: Python's text, and a warning that says what it is]");
{
  let iterRuns = 0;
  const runOf = (source, level) => {
    iterRuns += 1;
    return JSON.parse(pllCall("_pll_run_file", JSON.stringify([source, "iter.py", `iterator-${iterRuns}`, level, false])));
  };
  const WORKED = "its items are worked out as they are read, and can be read only once.";
  const program =
    'zip([1, 2], [3, 4])\nprint("doubled:", map(str, [1]))\nfor n in [1, 2]:\n    print(filter(None, [n]))\n' +
    "(x for x in [1])\nprint(list(zip([1], [2])))\n";
  const shown = runOf(program, "beginner");
  const warnings = shown.stderr.split("\n").filter((line) => line.startsWith("warning:"));
  expect(
    JSON.stringify(warnings) ===
      JSON.stringify([
        `warning: line 1: \`zip(...)\` gives an iterator, not a list: ${WORKED} \`list(zip(...))\` makes a list of them.`,
        `warning: line 2: \`map(...)\` gives an iterator, not a list: ${WORKED} \`list(map(...))\` makes a list of them.`,
        `warning: line 4: \`filter(...)\` gives an iterator, not a list: ${WORKED} \`list(filter(...))\` makes a list of them.`,
        `warning: line 5: This generator is an iterator, not a list: ${WORKED} \`list(...)\` of it makes a list of them.`,
      ]),
    `one warning for each line that shows one: ${JSON.stringify(warnings)}`,
  );
  expect(
    /^<zip object at 0x[0-9a-f]+>\ndoubled: <map object at 0x[0-9a-f]+>\n<filter object at 0x[0-9a-f]+>\n<filter object at 0x[0-9a-f]+>\n<generator object <genexpr> at 0x[0-9a-f]+>\n\[\(1, 2\)\]\n$/.test(shown.stdout),
    `and what is shown is Python's own: ${JSON.stringify(shown.stdout)}`,
  );
  const reversedShown = runOf("reversed([1, 2])\n", "advanced");
  expect(/^warning: line 1: `reversed\(\.\.\.\)` gives an iterator/.test(reversedShown.stderr), `advanced too: ${reversedShown.stderr}`);
  const raw = runOf('print(map(str, [1]))\n', "raw");
  expect(raw.stderr === "" && /^<map object at/.test(raw.stdout), `raw is Python: ${raw.stderr} ${raw.stdout}`);
  const toFile = runOf('import sys\nprint(zip([1], [2]), file=sys.stderr)\n', "beginner");
  expect(!/warning:/.test(toFile.stderr), `printed somewhere else, no warning: ${toFile.stderr}`);
  console.log("    once for each line, after Python's text; not at raw, nor for what is printed elsewhere");
}

console.log("[a `...` the program reaches stops it, at the student levels: code still to be written]");
{
  let dotRuns = 0;
  const runOf = (source, level) => {
    dotRuns += 1;
    return JSON.parse(pllCall("_pll_run_file", JSON.stringify([source, "dots.py", `dots-${dotRuns}`, level, false])));
  };
  const FIX = ["Write that code in place of the `...`."];
  for (const [what, source, line, headline] of [
    ["a body of `...`", 'def area(r: float) -> float:\n    """area of a circle of radius r"""\n    ...\n\nprint(area(1.0))\n', 3,
      "`area` is not written yet: the `...` here stands for code still to be written."],
    ["a `...` in an expression", "def AND(b1, b2):\n    return b1(b2, ...)\n\nprint(AND(lambda x, y: x, 3))\n", 2,
      "`AND` is not written yet: the `...` here stands for code still to be written."],
    ["a condition", 'if ...:\n    print("took the branch")\n', 1, "The `...` here stands for code still to be written."],
    ["at the top, after a function", "def helper() -> int:\n    return 1\n\nif ...:\n    print(helper())\n", 4,
      "The `...` here stands for code still to be written."],
    ["in a lambda", "g = lambda: ...\ng()\n", 1, "The `...` here stands for code still to be written."],
    ["in a lambda in a function", "def f() -> int:\n    g = lambda: ...\n    return g()\n\nf()\n", 2,
      "`f` is not written yet: the `...` here stands for code still to be written."],
    ["a key", "d = {1: 2}\nprint(d[...])\n", 2, "The `...` here stands for code still to be written."],
  ]) {
    const ran = runOf(source, "beginner");
    const found = ran.error?.finding;
    expect(
      ran.error?.errorType === "NotWrittenYet" && found?.headline === headline && JSON.stringify(found?.howToFix) === JSON.stringify(FIX) &&
        found?.lineNumber === line && ran.stdout === "",
      `${what}: ${found?.headline} at ${found?.lineNumber} ${JSON.stringify(found?.howToFix)} ${ran.stdout}`,
    );
  }
  // At `advanced` too; `raw` is Python, where `...` is a value.
  expect(runOf("def f() -> int:\n    ...\n\nf()\n", "advanced").error?.errorType === "NotWrittenYet", "advanced stops at it");
  const raw = runOf("print(...)\nif ...:\n    print('took the branch')\n", "raw");
  expect(raw.error === null && raw.stdout === "Ellipsis\ntook the branch\n", `raw: ${raw.stdout} ${raw.error?.message ?? ""}`);
  // Where `...` is part of a type, or a class has nothing in it, it is left alone.
  const types = runOf(
    "Pair = tuple[int, ...]\n\ndef first(t: tuple[int, ...], f: Callable[..., int]) -> int:\n    return f(t[0])\n\n" +
      "class Nothing: ...\n\nprint(first((4, 5), lambda n: n + 1), Pair, type(Nothing()).__name__)\n",
    "beginner",
  );
  expect(types.error === null && types.stdout === "5 tuple[int, ...] Nothing\n", `types and an empty class: ${types.stdout} ${types.error?.message ?? ""}`);
  // A function of `...` is defined, and caught by `except NotImplementedError`, as Python's own would be.
  const caught = runOf("def f() -> int:\n    ...\n\ntry:\n    f()\nexcept NotImplementedError:\n    print('not yet')\n", "intermediate");
  expect(caught.error === null && caught.stdout === "not yet\n", `caught: ${caught.stdout} ${caught.error?.message ?? ""}`);
  console.log("    in a body, an expression, a condition, a lambda and a key; not in a type or an empty class, nor at raw");
}

console.log("[annotations: the function wording only where there is a function]");
{
  const annotation = (written) =>
    wordStatic(
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
  // A number is either kind.
  const number = annotation("Number");
  expect(
    JSON.stringify(number.howToFix.slice(0, 2)) === JSON.stringify(["Write `float` instead.", "Or `int`, if it is always a whole number."]),
    `a number, either: ${JSON.stringify(number.howToFix)}`,
  );
  console.log("    `table` and `reactor` named as functions; `image` and `row` not");
}

console.log("[second review: advice that has to come from the program in hand]");
{
  const finding = (error, source, level = "raw") => explained(error, source, "lab.py", level);
  const raised = (source, line, errorLine, level = "raw", facts = {}) =>
    finding(
      pyErrorLine(errorLine, [["<pll:bootstrap/running>", 560, "run"], ["lab.py", line]], { facts }),
      source,
      level,
    );

  // The comparison hint fits what the program compared: no fixed
  // `int("999")` / `str(1000)` example.
  const noTable = raised(
    'n = 5\nif n < "apple":\n    print("x")\n',
    2,
    "TypeError: '<' not supported between instances of 'int' and 'str'",
  );
  const noTableText = noTable.howToFix.join(" ");
  expect(!/999|1000/.test(noTableText), `no fixed example values: ${noTableText}`);
  expect(/`int\(\.\.\.\)`/.test(noTableText), `the conversion is the right one: ${noTableText}`);

  const withTable = raised(
    'cars = load_table("cars.csv")\nif cars.row(0)["mpg"] < 30:\n    print("x")\n',
    2,
    "TypeError: '<' not supported between instances of 'str' and 'int'",
  );
  // Whether the file reads a CSV is not taken to say where the text came from.
  expect(
    !withTable.howToFix.some((l) => /CSV/.test(l)),
    `no CSV guessed at: ${JSON.stringify(withTable.howToFix)}`,
  );

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
    "raw",
    { definitions: { Song: defClass(["name", "year"]) } },
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
    wordStatic(
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
  const assigned = wordStatic(
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
  const finding = (error, source, level = "beginner") => explained(error, source, "student.py", level);
  const raised = (source, line, errorLine, frames = [], facts = {}) =>
    finding(
      pyErrorLine(errorLine, [["<pll:bootstrap/running>", 1, "_pll_run_file"], ["student.py", line], ...frames], {
        facts,
      }),
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
    [],
    { assigned: { age: { call: "input", line: 1 } } },
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
  expect(!/CSV/.test(text(cell)), `nor a CSV cell in one that reads a CSV: ${text(cell)}`);

  // no-columns: the example belongs in the sentence that introduces it.
  const noColumns = raised(
    't = table([["Jan", 1121]])\n',
    1,
    "TypeError: table() missing 1 required positional argument: 'rows'",
    [],
    { definitions: { table: defFunction(["columns", "rows"]) } },
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
  const item = ran('def sum_list(lst: list[float]) -> float:\n    return 0\n\n\nsum_list(["1", 2.0])\n', "student.py");
  // A `bool` for a `float` too: PLL's rule, said as one.
  const truth = ran("def half(x: float) -> float:\n    return x / 2\n\n\nhalf(True)\n", "student.py");
  expect(
    truth.howToFix.some((l) => /`True` and `False` are not accepted as numbers/.test(l)),
    `a bool is not a float here, and that is said: ${JSON.stringify(truth.howToFix)}`,
  );
  expect(
    /but item 0 is the string "1"\.$/.test(item.headline),
    `the element is described: ${item.headline}`,
  );

  // A dict's key in the quotes its value is described in, not Python's.
  const keyed = (annotation, value) =>
    ran(`def total(d: ${annotation}) -> int:\n    return 0\n\n\ntotal(${value})\n`, "student.py");
  const valueOf = keyed("dict[str, int]", '{"a": "1"}');
  expect(/the value for key "a" is the string "1"\.$/.test(valueOf.headline), `one kind of quote: ${valueOf.headline}`);
  expect(valueOf.howToFix.some((l) => l.includes('key "a"')), `in the advice too: ${JSON.stringify(valueOf.howToFix)}`);
  const keyB = keyed("dict[int, int]", '{"b": 1}');
  expect(/key "b"/.test(keyB.headline), `a key itself: ${keyB.headline}`);
  // Not a string, or quoted the way it is because of what is in it: as Python wrote it.
  const keyOne = keyed("dict[int, int]", '{1: "x"}');
  expect(/key 1 /.test(keyOne.headline), `a number key: ${keyOne.headline}`);
  const quoted = keyed("dict[str, int]", `{'say "hi"': "x"}`);
  expect(quoted.headline.includes(`key 'say "hi"'`), `a key with a quote in it: ${quoted.headline}`);

  // mut-local-not-field: the line reads the field it meant to change.
  const field = ran(
    "from dataclasses import dataclass\n\n\n@dataclass\nclass Account:\n    balance: float\n\n\ndef deposit(ac: Account, amt: float) -> None:\n    ac = ac.balance + amt\n\n\ndeposit(Account(1.0), 2.0)\n",
    "student.py",
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
  const cls = ran(
    "class ITunesSong:\n    pass\n\n\ndef song_age(s: ITunesSong) -> int:\n    return 1\n\n\nsong_age(ITunesSong)\n",
    "student.py",
  );
  expect(/itself, not one made from it\.$/.test(cls.headline), `class itself: ${cls.headline}`);

  // rx-init-string: a capital, and the handler named.
  const state = ran(
    '#level beginner\n\n\n\ndef draw_dog(x: float) -> Image:\n    return circle(x, "solid", "red")\n\n\nreactor(init="dog", to_draw=draw_dog).interact()\n',
    "student.py",
  );
  expect(
    /^The reactor calls `draw_dog` with its state/.test(state.howToFix[0] ?? ""),
    `a capital, and the handler named: ${JSON.stringify(state.howToFix)}`,
  );
  // dc-field-no-annotation: this is reported before the program runs, so
  // the NameError it would lead to is never shown - and must not be
  // referred to.
  const noType = wordStatic(
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
  const finding = (error, source, level = "beginner") => explained(error, source, "student.py", level);
  const raised = (source, line, errorLine, extra = []) =>
    finding(pyErrorLine(errorLine, [["student.py", line]], { facts: extra }), source);
  const text = (f) => `${f.headline}\n${f.howToFix.join("\n")}`;

  // One suggestion is "Did you mean", not "try one of those"; a case-only
  // difference says so; and the spelling and quotes bullets are moot.
  const one = ran("width = 1\nprint(widht)\n", "student.py");
  expect(one.howToFix.join("|") === "Did you mean `width`?", `one suggestion: ${JSON.stringify(one.howToFix)}`);
  const caseOnly = ran("class Boa:\n    pass\n\n\nx = boa\n", "student.py");
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
    { definitions: { NoInfo: defClass([], false) } },
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
  const returned = ran('def flag() -> Image:\n    return "red"\n\n\nflag()\n', "student.py");
  expect(returned.howToFix.includes("Return an `Image` from this line."), `article: ${JSON.stringify(returned.howToFix)}`);

  // Swapped values in a dataclass, as Python reports them.
  const swapped = ran(
    'from dataclasses import dataclass\n\n\n@dataclass\nclass Song:\n    name: str\n    singer: str\n    year: int\n\n\nSong("Hello", 2015, "Adele")\n',
    "student.py",
  );
  expect(/values for `singer` and `year` of `Song` look swapped/.test(swapped.headline), `swap: ${swapped.headline}`);
  expect(!/str\(\.\.\.\)/.test(text(swapped)), `no conversion advice, which would hide the swap: ${text(swapped)}`);

  // A value thrown away: the student's own expression.
  const thrown = (expression) =>
    wordStatic(
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
  const comparison = (expression, inTest) =>
    wordStatic(
      [
        {
          id: "unused-comparison",
          error_type: "UnusedValue",
          message: "x",
          line_number: 3,
          column: 4,
          name_token: null,
          scope_kind: "function",
          expression,
          in_test: inTest,
        },
      ],
      "beginner",
      "student.py",
    )[0];
  // In a test, the `assert` left out - and only that.
  const compared = comparison('pen_cost(0, "huskies") == 1', true);
  expect(
    /Did you mean `assert pen_cost\(0, "huskies"\) == 1`\?/.test(compared.howToFix[0]) && compared.howToFix.length === 1,
    `their comparison, not "assert ...": ${JSON.stringify(compared.howToFix)}`,
  );
  // In another function, the answer a Pyret function would have given back.
  const answered = comparison("x == 5", false);
  expect(
    answered.headline === "This comparison's answer is not used." &&
      JSON.stringify(answered.howToFix) ===
        JSON.stringify(["Did you mean `return x == 5`? A function gives back only what it `return`s.", "Or, to check it, `assert x == 5`."]),
    `not a test: ${answered.headline} ${JSON.stringify(answered.howToFix)}`,
  );
  // A value written out, alone: `10` as Pyret's last line would be.
  const alone = wordStatic(
    [{ id: "unused-value", error_type: "UnusedValue", line_number: 2, column: 4, name_token: null, expression: "10", constant: true }],
    "beginner",
    "student.py",
  )[0];
  expect(
    alone.headline === "This line is only the value `10`, which goes nowhere." &&
      alone.howToFix[0] === "Did you mean `return 10`? A function gives back only what it `return`s.",
    `a value alone: ${alone.headline} ${JSON.stringify(alone.howToFix)}`,
  );
  const inTest = wordStatic(
    [{ id: "unused-value", error_type: "UnusedValue", line_number: 2, column: 4, name_token: null, expression: "x + 1", in_test: true }],
    "beginner",
    "student.py",
  )[0];
  expect(
    JSON.stringify(inTest.howToFix) === JSON.stringify(["A test checks with `assert`: compare the value with what it should be."]),
    `a value thrown away in a test: ${JSON.stringify(inTest.howToFix)}`,
  );
  // A call that only gives back a new value: what it was taken to change stays as it was.
  const dropped = wordStatic(
    [{ id: "unused-value", error_type: "UnusedValue", line_number: 2, column: 4, name_token: null, expression: "sorted(xs)", unchanged: "xs" }],
    "beginner",
    "student.py",
  )[0];
  expect(
    JSON.stringify(dropped.howToFix) ===
      JSON.stringify([
        "Did you mean `return sorted(xs)`? On its own, the value is worked out and thrown away.",
        "`sorted(xs)` gives back a new value, and `xs` stays as it was.",
      ]),
    `a new value thrown away: ${JSON.stringify(dropped.howToFix)}`,
  );
  console.log("    suggestions, lengths, counts, empty classes, swaps and expressions from the program");
}

if (!passed()) {
  console.log("\nFAILED");
  process.exit(1);
}
console.log("\nALL EXPLAINER SMOKE TESTS PASSED");
