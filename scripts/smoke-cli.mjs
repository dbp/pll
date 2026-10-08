#!/usr/bin/env node
/**
 * The `pll` command line, end to end against the built bundle.
 *
 * Runs the real CLI as a child process on fixtures in a temp folder, so
 * this covers what a user actually invokes: argument handling, the stream
 * split between program output and PLL's commentary, exit codes, stdin,
 * sibling files, and the two things that cannot work in a terminal.
 *
 * Requires `pnpm run build` so dist-cli/ exists.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, passed } from "./lib/check.mjs";
import { ROOT } from "./lib/bundle.mjs";

const CLI = resolve(ROOT, "dist-cli", "cli.cjs");

const work = mkdtempSync(join(tmpdir(), "pll-cli-"));
function fixture(name, ...lines) {
  const file = join(work, name);
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}

/** Run the CLI. Returns { code, stdout, stderr }. */
/**
 * Longest any fixture here should take, Pyodide boot included.
 *
 * There is a hard timeout because a `pll` that does not exit is a real
 * failure mode - the interrupt case waits on a process ending - and without
 * one the whole suite simply hangs, with nothing said about where or why.
 * Loud and with the output so far beats silent forever.
 */
const RUN_TIMEOUT_MS = 120_000;

/**
 * `signalAfter` sends `signal` once stdout contains that text, and
 * `signalAfterStderr` once stderr does - for a phase that prints nothing of
 * its own, like the tests. `signalDelay` is how long after.
 * `closeStdoutAfter` stops reading stdout once it contains that text, as
 * `| head` does. `stdoutAt` is when each piece of stdout arrived.
 * `openStdin` leaves stdin open, as a terminal's is, rather than ending it.
 * `signalAtMs` sends `signal` that long after starting, whatever has
 * happened by then.
 */
function run(
  args,
  {
    stdin = "",
    signalAfter = null,
    signalAfterStderr = null,
    signalDelay = 150,
    signal = "SIGINT",
    closeStdoutAfter = null,
    openStdin = false,
    signalAtMs = null,
  } = {},
) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI, "--no-color", ...args], {
      cwd: work,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const stdoutAt = [];
    let timer = null;
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, RUN_TIMEOUT_MS);
    if (signalAtMs !== null) timer = setTimeout(() => child.kill(signal), signalAtMs);
    child.stdout.on("data", (b) => {
      stdout += b.toString();
      stdoutAt.push({ at: Date.now(), text: b.toString() });
      if (closeStdoutAfter && stdout.includes(closeStdoutAfter)) child.stdout.destroy();
      // Signal only once the program is demonstrably running, rather than
      // on a timer that could fire before Pyodide has booted.
      if (signalAfter && stdout.includes(signalAfter) && timer === null) {
        timer = setTimeout(() => child.kill(signal), signalDelay);
      }
    });
    child.stderr.on("data", (b) => {
      stderr += b.toString();
      if (signalAfterStderr && stderr.includes(signalAfterStderr) && timer === null) {
        timer = setTimeout(() => child.kill(signal), signalDelay);
      }
    });
    child.on("error", reject);
    child.on("close", (code, sig) => {
      if (timer) clearTimeout(timer);
      clearTimeout(deadline);
      resolvePromise({ code, signal: sig, stdout, stderr, stdoutAt, timedOut });
    });
    if (stdin) child.stdin.write(stdin);
    if (!openStdin) child.stdin.end();
  });
}

/**
 * Whether to run section `number`, saying its title if so. All of them,
 * unless `PLL_SMOKE_ONLY=26,27` names some - for checking one change
 * quickly. Each section stands on its own, in files of its own.
 */
const ONLY = (process.env.PLL_SMOKE_ONLY ?? "").split(",").filter(Boolean);
function section(number, title) {
  if (ONLY.length > 0 && !ONLY.includes(String(number))) return false;
  console.log(`\n[${number}] ${title}`);
  return true;
}

async function main() {
  if (!existsSync(CLI)) {
    console.error(`Missing ${CLI}. Run \`pnpm run build\` first.`);
    process.exit(1);
  }

  if (section(1, "a raw file runs, and stdout carries only its own output")) {
    const file = fixture("plain.py", 'print("one")', 'print("two")');
    const r = await run([file]);
    expect(r.code === 0, `expected exit 0, got ${r.code}`);
    expect(r.stdout === "one\ntwo\n", `stdout should be just the program: ${JSON.stringify(r.stdout)}`);
    expect(/plain\.py \[raw\]/.test(r.stderr), "the level belongs on stderr");
    expect(!/one/.test(r.stderr), "program output must not be duplicated onto stderr");
    console.log(`    stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr.trim())}`);
  }

  if (section(2, "the level comes from the file, and blocks the run")) {
    const file = fixture("reassign.py", "#level beginner", "", "total = 1", "total = 2");
    const r = await run([file]);
    expect(r.code === 2, `blocked runs should exit 2, got ${r.code}`);
    expect(r.stdout === "", `nothing should reach stdout, got ${JSON.stringify(r.stdout)}`);
    expect(/Reassignment/.test(r.stderr), "the finding should be reported");
    expect(/not run/i.test(r.stderr), "it should say the file was not run");
    // Same file with no header is raw, so it runs.
    const raw = fixture("reassign_raw.py", "total = 1", "total = 2", "print(total)");
    const r2 = await run([raw]);
    expect(r2.code === 0 && r2.stdout === "2\n", `raw should just run, got ${r2.code} ${JSON.stringify(r2.stdout)}`);
    console.log("    beginner blocked; the same code at raw ran");
  }

  if (section(3, "a runtime error gets the friendly wording and exit 1")) {
    const file = fixture("oops.py", "total = 10", "print(Total)");
    const r = await run([file]);
    expect(r.code === 1, `expected exit 1, got ${r.code}`);
    expect(/Python doesn't know what `Total` means/.test(r.stderr), `expected the friendly NameError, got ${r.stderr}`);
    expect(/How to fix/.test(r.stderr), "the fix hints should be shown");
    console.log(`    ${r.stderr.split("\n")[1]}`);
  }

  if (section(4, "type annotations are checked, and #level raw opts out")) {
    const body = ["def add(x: int, y: int) -> int:", "    return x + y", 'print(add(2, "three"))'];
    const checked = await run([fixture("typed.py", "#level advanced", "", ...body)]);
    expect(checked.code === 1, `annotated mismatch should fail, got ${checked.code}`);
    expect(/whole number/.test(checked.stderr), `expected the rewritten wording, got ${checked.stderr}`);
    const rawRun = await run([fixture("typed_raw.py", "#level raw", "", ...body)]);
    expect(/TypeError/.test(rawRun.stderr), "raw should fail Python's own way instead");
    // At raw the annotation is not checked at all, so the failure has to be
    // about the `+` itself and never about `x`'s declared type. (Python's
    // own error is still reworded - that is not type checking.)
    expect(
      !/annotat|is not an instance of|expects/.test(rawRun.stderr),
      `raw must not check the annotation, got ${rawRun.stderr}`,
    );
    expect(
      /does not work between/.test(rawRun.stderr),
      `raw should report the operands, got ${rawRun.stderr}`,
    );
    console.log("    advanced reported the annotation; raw reported Python's TypeError");
  }

  if (section(5, "in-file tests run first, and a failure is exit 3")) {
    const good = fixture("t_ok.py", "def add(x, y):", "    return x + y", "", "def test_add():", "    assert add(2, 3) == 5", "", 'print("after")');
    const r = await run([good]);
    expect(r.code === 0, `passing tests should exit 0, got ${r.code}`);
    expect(/Tests: 1 passed/.test(r.stderr), `expected a summary, got ${r.stderr}`);
    expect(/after/.test(r.stdout), "the file should still run after its tests");

    const bad = fixture("t_bad.py", "def add(x, y):", "    return x + y", "", "def test_add():", "    assert add(2, 3) == 6");
    const r2 = await run([bad]);
    expect(r2.code === 3, `failing tests should exit 3, got ${r2.code}`);
    expect(/FAILED test_add/.test(r2.stderr), `expected the failing name, got ${r2.stderr}`);

    const skipped = await run([bad, "--no-tests"]);
    expect(skipped.code === 0, `--no-tests should not fail, got ${skipped.code}`);
    expect(!/Tests:/.test(skipped.stderr), "--no-tests should not report tests");
    console.log("    pass -> 0, fail -> 3, --no-tests -> 0");
  }

  if (section(6, "tables print as text; images and reactors do not run")) {
    const file = fixture(
      "shows.py",
      "#level intermediate",
      "",
      't = table(["name", "age"], [["Ada", 36], ["Grace", 85]])',
      "t",
      'circle(20, "solid", "red")',
      'animate(lambda n: circle(5, "solid", "blue"))',
      'print("still here")',
    );
    const r = await run([file]);
    expect(r.code === 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
    expect(/name +age/.test(r.stdout) && /Ada +36/.test(r.stdout), `expected a text table, got ${JSON.stringify(r.stdout)}`);
    expect(/\(2 rows\)/.test(r.stdout), "row count should be shown");
    expect(/\[image 40x40/.test(r.stderr), `expected an image note, got ${r.stderr}`);
    expect(/reactor needs the editor/.test(r.stderr), "expected a reactor note");
    expect(/still here/.test(r.stdout), "the program should continue past a reactor");

    const dir = join(work, "pics");
    const saved = await run([file, "--save-images", dir]);
    expect(saved.code === 0, "saving images should not change the outcome");
    expect(readdirSync(dir).some((f) => f.endsWith(".svg")), "an .svg should be written");
    expect(/<svg/.test(readFileSync(join(dir, readdirSync(dir)[0]), "utf8")), "and it should be an svg");
    console.log("    table on stdout, image + reactor noted on stderr, --save-images wrote a file");
  }

  if (section(7, "input() reads stdin, and running dry is EOFError")) {
    const file = fixture("ask.py", 'name = input("Name? ")', 'print("hi", name)');
    const r = await run([file], { stdin: "Ada\n" });
    expect(r.code === 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
    expect(/hi Ada/.test(r.stdout), `expected the answer to be used, got ${JSON.stringify(r.stdout)}`);
    const dry = await run([file]);
    expect(dry.code === 1 && /EOFError/.test(dry.stderr), `empty stdin should be EOFError, got ${dry.code}`);
    console.log("    piped a line, and an empty stdin raised EOFError");
  }

  if (section(8, "sibling files are read and written back")) {
    writeFileSync(join(work, "in.csv"), "a,b\n1,2\n", "utf8");
    const file = fixture(
      "files.py",
      'print(open("in.csv").read().strip())',
      'open("out.csv", "w").write("x,y\\n3,4\\n")',
    );
    const r = await run([file]);
    expect(r.code === 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
    expect(/a,b/.test(r.stdout), `the sibling file should be readable, got ${JSON.stringify(r.stdout)}`);
    expect(existsSync(join(work, "out.csv")), "the written file should land next to the script");
    expect(readFileSync(join(work, "out.csv"), "utf8").includes("3,4"), "with its contents");
    expect(/Saved out\.csv/.test(r.stderr), "and should be reported");
    console.log("    read in.csv, wrote out.csv next to the script");
  }

  if (section(9, "--quiet keeps only the program's output")) {
    const file = fixture("quiet.py", "#level beginner", "", 'print("just this")');
    const r = await run([file, "--quiet"]);
    expect(r.stdout === "just this\n", `stdout: ${JSON.stringify(r.stdout)}`);
    expect(r.stderr === "", `stderr should be empty, got ${JSON.stringify(r.stderr)}`);
    // Loading pytest is PLL's business, and quiet; the tests' result is not.
    const tested = fixture("quiet_tests.py", "def test_a():", "    assert 1 == 1", 'print("ran")');
    const t = await run([tested, "--quiet"]);
    expect(!/Load(ing|ed) /.test(t.stderr), `no package loading under --quiet: ${JSON.stringify(t.stderr)}`);
    expect(/Tests: 1 passed/.test(t.stderr), `but the tests' result: ${JSON.stringify(t.stderr)}`);
    // Nor without it: "Loading pytest, ..." comes with every run that has
    // tests, and says nothing a student needs.
    const loud = await run([tested]);
    expect(!/Load(ing|ed) /.test(loud.stderr), `nor without it: ${JSON.stringify(loud.stderr.slice(0, 200))}`);
    expect(/ok   test_a/.test(loud.stderr), `which lists the tests: ${JSON.stringify(loud.stderr)}`);
    console.log("    nothing but the program on either stream, and the tests' result");
  }

  if (section(10, "usage problems are reported, not crashed on")) {
    for (const [args, pattern] of [
      [[], /no file given/],
      [["--bogus", "x.py"], /unknown option --bogus/],
      [["notes.txt"], /not a \.py file/],
      [["missing.py"], /^pll: cannot open missing\.py: there is no such file$/m],
      [["x.py", "--save-images"], /--save-images needs a directory/],
      [["--save-images=", "x.py"], /--save-images needs a directory/],
      // Python's -v is verbose; here it is nothing, rather than --version.
      [["-v", "x.py"], /unknown option -v/],
      // A value is not a subcommand: this saves pictures into ./examplar.
      [["--save-images", "examplar", "missing.py"], /cannot open missing\.py/],
      [["--bogus", "examplar", "build"], /unknown option --bogus before examplar/],
      // The flag as typed, not its short form.
      [["examplar", "build", "hw3", "--out"], /--out needs a file/],
    ]) {
      const r = await run(args);
      expect(r.code === 64, `${JSON.stringify(args)} should exit 64, got ${r.code}`);
      expect(pattern.test(r.stderr), `${JSON.stringify(args)}: expected ${pattern}, got ${r.stderr.split("\n")[0]}`);
      expect(!/Exit codes/.test(r.stderr), `${JSON.stringify(args)}: a hint, not the whole usage: ${r.stderr}`);
    }
    mkdirSync(join(work, "folder.py"));
    const folder = await run(["folder.py"]);
    expect(folder.code === 64 && /folder\.py is a folder, not a file/.test(folder.stderr), `a folder: ${folder.stderr}`);
    const help = await run(["--help"]);
    expect(help.code === 0 && /pll <file\.py>/.test(help.stdout), "--help should print usage to stdout");
    for (const flag of ["--version", "-V"]) {
      const version = await run([flag]);
      expect(version.code === 0 && /^\d+\.\d+\.\d+/.test(version.stdout), `${flag}: ${version.stdout}`);
    }
    console.log("    eleven usage errors, --help, --version and -V");
  }

  if (section(11, "Ctrl+C stops a runaway program")) {
    // The same mechanism as the panel's Stop button: SIGINT writes the
    // interrupt buffer, Python raises KeyboardInterrupt at the next check.
    const file = fixture("loop.py", 'print("running", flush=True)', "while True:", "    pass");
    const r = await run([file], { signalAfter: "running" });
    expect(
      !r.timedOut,
      `pll did not exit within ${RUN_TIMEOUT_MS}ms of the interrupt. ` +
        `stdout=${JSON.stringify(r.stdout.slice(-200))} ` +
        `stderr=${JSON.stringify(r.stderr.slice(-400))}`,
    );
    expect(r.code !== null, `the process should exit on its own, got signal ${r.signal}`);
    expect(/KeyboardInterrupt/.test(r.stderr), `expected KeyboardInterrupt, got ${r.stderr.slice(0, 200)}`);
    // Something the student asked for, not something their code did wrong.
    expect(
      /The program was stopped\./.test(r.stderr) && !/while running your program/.test(r.stderr),
      `a Stop should read as one: ${r.stderr.slice(0, 300)}`,
    );
    console.log(`    interrupted; exit=${r.code}`);
  }

  if (section(12, "a failing test shows what it printed, and a friendly message")) {
    // A `print` inside a test to see what a function returned is the first
    // debugging tool a beginner is taught. The editor's card showed it; the
    // command line dropped it, so that lesson did not survive the move.
    const file = fixture(
      "day5.py",
      "#level beginner",
      "",
      "def shout(word: str) -> str:",
      "    return None",
      "",
      "def test_shout():",
      // Printed *before* the call that raises - `print(shout("hi"))` would
      // evaluate the argument first and never print anything.
      '    print("about to call shout")',
      '    assert shout("hi") == "HI!"',
    );
    const r = await run([file]);
    expect(r.code === 3, `expected exit 3, got ${r.code}: ${r.stderr}`);
    expect(/output:/.test(r.stderr), `the test's own output should be shown: ${r.stderr}`);
    expect(/about to call shout/.test(r.stderr), `including what it printed: ${r.stderr}`);
    // And typeguard's own wording must not reach the report.
    expect(
      !/is not an instance of/.test(r.stderr),
      `typeguard's wording should be rewritten: ${r.stderr}`,
    );
    expect(/should return a string/.test(r.stderr), `expected PLL's wording: ${r.stderr}`);
    // Shown as a finding is shown anywhere: its type, then where it is -
    // in `shout`, not in the test.
    expect(/TypeMismatch: `shout`/.test(r.stderr), `with the error's type: ${r.stderr}`);
    expect(/^\s+at day5\.py:4$/m.test(r.stderr), `and where it happened: ${r.stderr}`);
    console.log("    printed output shown, wording rewritten");
  }

  if (section(13, "a NameError's location has no NaN in it")) {
    // The column arrives from a Python dict, where a missing key is
    // `undefined` - which passed a `!== null` guard and was printed as
    // `n.py:1:NaN`.
    const file = fixture("nm.py", "print(Totl)");
    const r = await run([file]);
    expect(r.code === 1, `expected exit 1, got ${r.code}`);
    expect(!/NaN/.test(r.stderr), `no NaN in the location: ${r.stderr}`);
    expect(/nm\.py:1/.test(r.stderr), `the location should still be there: ${r.stderr}`);
    console.log("    location printed without NaN");
  }

  if (section(14, "to_pandas works without the file importing pandas")) {
    // The import is inside the method, so `loadPackagesFromImports` never
    // saw it and the call died with ModuleNotFoundError.
    const file = fixture(
      "pd.py",
      't = table(["name", "mpg"], [["vw", 29], ["honda", 33]])',
      "df = t.to_pandas()",
      "print(type(df).__name__, df['mpg'].mean())",
    );
    const r = await run([file]);
    expect(r.code === 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
    expect(/DataFrame 31\.0/.test(r.stdout), `expected a DataFrame: ${r.stdout}`);
    console.log("    pandas is loaded because the call is there");
  }

  if (section(15, "a NameError's column is the one in the file")) {
    // The caret's index in a traceback counts the indent Python adds when
    // it echoes the line, and Python strips the original indent first - so
    // a column read from it is wrong on every line, by different amounts.
    const flat = fixture("flat.py", "print(y)");
    const r1 = await run([flat]);
    expect(/flat\.py:1:7\b/.test(r1.stderr), `print(y) blames column 7: ${r1.stderr}`);

    const nested = fixture("deep.py", "def g():", "    if True:", "        return missing", "g()");
    const r2 = await run([nested]);
    // 8 spaces + "return " is 15 characters, so `missing` starts at 16.
    expect(/deep\.py:3:16\b/.test(r2.stderr), `an indented line blames column 16: ${r2.stderr}`);
    console.log("    columns correct at top level and indented");
  }

  if (section(16, "a warning is said and the file still runs")) {
    // A warning is about code that works - a helper nothing runs, a method
    // named but not called - so refusing to run the file over one would be
    // a bigger obstruction than the mistake.
    const warned = fixture(
      "warn.py",
      "#level beginner",
      "",
      "",
      "def check_total():",
      "    assert 1 == 1",
      "",
      "",
      'print("ran anyway")',
    );
    const r = await run([warned]);
    expect(r.code === 0, `a warning should not fail the run, got ${r.code}: ${r.stderr}`);
    expect(/ran anyway/.test(r.stdout), `and the file runs: ${JSON.stringify(r.stdout)}`);
    expect(
      /`check_total` has an `assert` in it, but nothing ever runs it/.test(r.stderr),
      `the warning is still shown: ${r.stderr}`,
    );
    expect(!/The file was not run/.test(r.stderr), `and nothing says the file was skipped: ${r.stderr}`);

    // An error still stops it.
    const blocked = fixture(
      "blocked.py",
      "#level beginner",
      "",
      "",
      "def test_total():",
      "    assert(1 + 1, 2)",
      "",
      "",
      'print("should not run")',
    );
    const r2 = await run([blocked]);
    expect(r2.code !== 0, `an error should fail the run, got ${r2.code}`);
    expect(!/should not run/.test(r2.stdout), `and the file must not run: ${r2.stdout}`);
    expect(/The file was not run\./.test(r2.stderr), `with the reason given: ${r2.stderr}`);
    console.log("    warning shown and run continued; error still stops it");
  }

  if (section(17, "code that parses but does not compile, in a file with tests")) {
    // `case Boa:` parses and fails at compile time: reported as the
    // program's syntax error, not as `pll` failing (exit 64).
    const file = fixture(
      "capture.py",
      "#level beginner",
      "from dataclasses import dataclass",
      "",
      "",
      "@dataclass",
      "class Boa:",
      "    name: str",
      "",
      "",
      "@dataclass",
      "class Armadillo:",
      "    name: str",
      "",
      "",
      "Animal = Boa | Armadillo",
      "",
      "",
      "def describe(a: Animal) -> str:",
      "    match a:",
      "        case Boa:",
      '            return "boa"',
      "        case Armadillo(n):",
      '            return "armadillo"',
      "",
      "",
      "def test_describe():",
      '    assert describe(Boa("s")) == "boa"',
    );
    const r = await run([file]);
    expect(r.code === 1, `expected exit 1, got ${r.code}`);
    expect(
      !/During handling of the above exception/.test(r.stderr),
      `no doubled traceback: ${r.stderr}`,
    );
    expect(
      !/pll: Traceback/.test(r.stderr),
      `and no crash of the command itself: ${r.stderr}`,
    );
    expect(
      /`case Boa:` needs brackets: `case Boa\(\):`/.test(r.stderr),
      `the missing brackets are named: ${r.stderr}`,
    );
    // 8 spaces + "case " is 13 characters, so `Boa` starts at 14.
    expect(/capture\.py:20:14\b/.test(r.stderr), `blamed at the case line: ${r.stderr}`);
    console.log(`    ${r.stderr.split("\n")[0]}`);
  }

  if (section(18, "a compile-time warning is said once, and not beside its own finding")) {
    // Every phase compiles the file more than once, and Python printed a
    // SyntaxWarning on every compile: four copies for a missing comma
    // between rows in a file with tests, beside a finding that already
    // explained it.
    const comma = fixture(
      "comma.py",
      "#level beginner",
      'shuttle = table(["month", "riders"], [',
      '    ["Jan", 1121]',
      '    ["Feb", 982],',
      "])",
      "",
      "",
      "def test_nothing():",
      "    assert True",
    );
    const r = await run([comma]);
    expect(!/SyntaxWarning/.test(r.stderr), `no raw SyntaxWarning: ${r.stderr}`);
    expect(
      !/perhaps you missed a comma/.test(r.stderr),
      `and not Python's wording either: ${r.stderr}`,
    );
    expect(
      /A comma is missing between two values in a list/.test(r.stderr),
      `the finding still explains it: ${r.stderr}`,
    );

    // A line that never runs has no finding, so its warning is the only
    // sign of the mistake: said once, in PLL's words, with their operand.
    const idle = fixture(
      "idle.py",
      "#level beginner",
      "",
      "",
      "def never_called():",
      "    return 3(4)",
      "",
      "",
      'print("ran")',
    );
    const r2 = await run([idle]);
    expect(r2.code === 0, `the file runs: ${r2.code} ${r2.stderr}`);
    const said = (r2.stderr.match(/warning: line 5:/g) ?? []).length;
    expect(said === 1, `said exactly once, got ${said}: ${r2.stderr}`);
    expect(/`3 \* 4`, not `3\(4\)`/.test(r2.stderr), `with their own operand: ${r2.stderr}`);
    expect(!/perhaps you missed a comma/.test(r2.stderr), `and not the misleading guess: ${r2.stderr}`);
    console.log("    none beside a finding; one, reworded, for a line that never runs");
  }

  if (section(19, "Ctrl+C during the tests ends the run there")) {
    // One Ctrl+C is enough: the looping test is stopped and the rest are
    // not run. (A second one kills pll rather than stopping it.)
    const file = fixture(
      "loops.py",
      "def test_ok():",
      "    assert True",
      "",
      "",
      "def test_forever():",
      "    while True:",
      "        pass",
      "",
      "",
      "def test_after():",
      "    assert True",
      "",
      "",
      'print("the program")',
    );
    // The tests run once the program has printed this, and finished.
    const r = await run([file], { signalAfter: "the program", signalDelay: 1000 });
    expect(!r.timedOut, `pll did not exit after Ctrl+C: ${r.stderr.slice(-400)}`);
    expect(r.code === 1, `expected exit 1, got ${r.code}: ${r.stderr}`);
    expect(/ok\s+test_ok/.test(r.stderr), `the test before it keeps its result: ${r.stderr}`);
    expect(/STOPPED test_forever \(line 5\)/.test(r.stderr), `the looping test is marked: ${r.stderr}`);
    expect(!/test_after/.test(r.stderr), `the test after it must not run: ${r.stderr}`);
    expect(
      /Stopped during the tests\. The rest of the tests were not run\./.test(r.stderr),
      `it should say what did not run: ${r.stderr}`,
    );
    expect(r.stdout === "the program\n", `the program ran first, once: ${JSON.stringify(r.stdout)}`);
    expect(!/giving up/.test(r.stderr), `one Ctrl+C should be enough: ${r.stderr}`);
    console.log(`    exit=${r.code}; ${r.stderr.trim().split("\n").at(-1)}`);
  }

  if (section(20, "Ctrl+C before the program starts runs nothing")) {
    // While Python loads: no Python is running to take the Stop, so the
    // run has to notice it itself, or the program ran anyway. And it should
    // notice before fetching the program's libraries, not after.
    const file = fixture("early.py", "#level beginner", "import numpy", 'print("the program")');
    const r = await run([file], { signalAfterStderr: "[beginner]", signalDelay: 100 });
    expect(!r.timedOut, `pll did not exit after Ctrl+C: ${r.stderr.slice(-400)}`);
    expect(r.code === 1, `expected exit 1, got ${r.code}: ${r.stderr}`);
    expect(r.stdout === "", `nothing should run: ${JSON.stringify(r.stdout)}`);
    expect(
      /Stopped before the program started\. Nothing was run\./.test(r.stderr),
      `it should say nothing ran: ${r.stderr}`,
    );
    expect(!/failed|could not/i.test(r.stderr), `and a Stop is not a failure: ${r.stderr}`);
    expect(!/Loading numpy/.test(r.stderr), `nor should it load libraries for it: ${r.stderr}`);
    // And while Python itself is still starting: said the same, at once.
    const started = Date.now();
    const loading = await run([fixture("early2.py", 'print("the program")')], { signalAtMs: 300 });
    expect(
      loading.code === 1 && loading.stdout === "" && /Stopped before the program started\. Nothing was run\./.test(loading.stderr),
      `a Ctrl+C while Python starts: ${loading.code} ${loading.stderr}`,
    );
    expect(!/at .*\.cjs|Error:/.test(loading.stderr), `with no stack: ${loading.stderr}`);
    expect(Date.now() - started < 3000, `without waiting for Python: ${Date.now() - started}ms`);
    console.log(`    exit=${r.code}; ${r.stderr.trim().split("\n").at(-1)}`);
  }

  if (section(21, "os._exit ends the program; Python itself failing is the program's failure")) {
    const exits = fixture("exits.py", "import os", 'print("before")', "os._exit(0)", 'print("after")');
    const r = await run([exits]);
    expect(r.code === 0 && r.stdout === "before\n", `ends there, like sys.exit: exit=${r.code} ${JSON.stringify(r.stdout)}`);
    // A real abort, in C: `os.abort` and `posix.abort` only end the program.
    const fatal = fixture("fatal.py", "import faulthandler", "faulthandler._sigabrt()");
    const f = await run([fatal]);
    expect(f.code === 1, `exit 1, not a usage error: ${f.code}`);
    expect(/pll: Python stopped completely\./.test(f.stderr), `said plainly: ${f.stderr.trim().split("\n").at(-1)}`);
    expect(!/Could not save files/.test(f.stderr), `with no files to copy back: ${f.stderr}`);
    console.log(`    exit=${f.code}; ${f.stderr.trim().split("\n").at(-1)}`);
  }

  if (section(22, "a program's own exit status is passed on, as python would")) {
    const cases = [
      [["import sys", "sys.exit(3)"], 3],
      [["import sys", "sys.exit()"], 0],
      [["import sys", 'sys.exit("no data file")'], 1, /^no data file$/m],
      [["raise SystemExit(True)"], 1],
      [["import sys", "sys.exit(-1)"], 255],
      [["import sys", "sys.exit(256)"], 0],
      [["import os", "os._exit(5)"], 5],
      [["import os", "os.abort()"], 134],
      // `os` takes them from `posix`, which can be called directly.
      [["import posix", "posix._exit(6)"], 6],
      [["import posix", "posix.abort()"], 134],
      // Too big to cross as a number: its low byte, as CPython's status.
      [["import sys", "sys.exit(2**53 + 1)"], 1],
      [["import sys", "sys.exit(2**64)"], 255],
      // Its tests are not run once it has ended itself, and it says so.
      [["def test_a():", "    assert 1 == 2", "", "import sys", "sys.exit(4)"], 4, /tests were not run: the program ended itself first/],
      [["def test_a():", "    assert 1 == 2", "", "import sys", "sys.exit(0)"], 0, /tests were not run/],
      [["def test_a():", "    assert 1 == 2"], 3],
      [['print("finished")'], 0],
    ];
    const seen = [];
    for (const [lines, want, stderr] of cases) {
      const r = await run([fixture(`exit_${seen.length}.py`, ...lines), "--quiet"]);
      expect(r.code === want, `${lines.at(-1)} should exit ${want}, got ${r.code}`);
      if (stderr) expect(stderr.test(r.stderr), `${lines.at(-1)} says why: ${JSON.stringify(r.stderr)}`);
      seen.push(`${lines.at(-1)}->${r.code}`);
    }
    console.log(`    ${seen.join("  ")}`);
  }

  if (section(23, "an error in another of the student's files is placed in that file")) {
    fixture("helper23.py", "def greet(name):", '    return "hi " + nme');
    const main = fixture("main23.py", "from helper23 import greet", "", 'print(greet("Ada"))');
    const r = await run([main]);
    expect(/at helper23\.py:2:20/.test(r.stderr), `the NameError is in helper23.py: ${r.stderr.split("\n").slice(1, 3).join(" | ")}`);
    fixture("broken23.py", "def f(:", "    pass");
    const importing = fixture("imports23.py", "x = 1", "import broken23");
    const b = await run([importing]);
    expect(/at broken23\.py:1:7/.test(b.stderr), `the syntax error is in broken23.py: ${b.stderr.split("\n").slice(1, 3).join(" | ")}`);
    // Explained from that file's own line, and from its own definitions.
    fixture("loops23.py", "def total(nums):", "    for x in len(nums):", "        pass");
    const looping = await run([fixture("calls23.py", "from loops23 import total", "total([1, 2])")]);
    expect(/`len\(nums\)` is a number/.test(looping.stderr), `the line read is the sibling's: ${looping.stderr}`);
    fixture("shapes23.py", "def area(w, h):", "    return w * h");
    const measuring = await run([fixture("measures23.py", "import shapes23", "print(shapes23.area(3))")]);
    expect(
      /`area` takes 2 arguments \(`w` and `h`\), but got 1/.test(measuring.stderr),
      `the definition is the sibling's: ${measuring.stderr}`,
    );
    console.log("    helper23.py:2:20, broken23.py:1:7, each explained from its own file");
  }

  if (section(24, "a file another imports is held to its own #level")) {
    // A folder of its own, away from the files the other cases leave around.
    mkdirSync(join(work, "grading"));
    fixture("grading/student24.py", "#level beginner", "total = 0", "total = 1");
    const refused = await run([fixture("grading/grader24.py", "import student24")]);
    expect(
      /ChecksFailed: `student24\.py` was not imported: the checks of `#level beginner` found a problem in it\./.test(refused.stderr) &&
        /Line 3: `total` is already assigned \(first assigned on line 2\)\./.test(refused.stderr) &&
        /at grader24\.py:1/.test(refused.stderr),
      `refused at the import, with the problem: ${refused.stderr}`,
    );
    expect(refused.code === 1, `and the run failed: ${refused.code}`);
    fixture("grading/typed24.py", "#level beginner", "def half(n: int) -> int:", "    return n / 2");
    const checked = await run([fixture("grading/grades24.py", "from typed24 import half", "print(half(3))")]);
    expect(/TypeMismatch: `half` says it returns a whole number/.test(checked.stderr) && /at typed24\.py:3/.test(checked.stderr),
      `its annotations are checked: ${checked.stderr}`);
    console.log("    refused for its checks; annotations checked in it");
  }

  if (section(25, "files past the limit are named, not dropped in silence")) {
    mkdirSync(join(work, "crowded"));
    for (let i = 0; i < 103; i++) fixture(`crowded/d${String(i).padStart(3, "0")}.csv`, "a", "1");
    const crowded = await run([fixture("crowded/a_main.py", 'print(open("d001.csv").read().split()[0])')]);
    expect(crowded.code === 0 && crowded.stdout === "a\n", `the program still runs: ${crowded.code} ${crowded.stdout}`);
    expect(
      /Not loaded: d099\.csv, d100\.csv, d101\.csv, d102\.csv - at most 100 files next to a program are\./.test(crowded.stderr),
      `and says which were left out: ${crowded.stderr}`,
    );
    mkdirSync(join(work, "busy"));
    const busy = await run([
      fixture("busy/writes.py", "for i in range(102):", '    open(f"w{i:03}.txt", "w").write("x")'),
    ]);
    expect(
      /Not saved: w100\.txt, w101\.txt - at most 100 files next to a program are\./.test(busy.stderr) &&
        readdirSync(join(work, "busy")).filter((name) => name.endsWith(".txt")).length === 100,
      `and which it wrote but could not save: ${busy.stderr.slice(-300)}`,
    );
    console.log("    the 4 past the limit named, and the 2 not saved");
  }

  if (section(26, "subfolders, bytes, deletions, and files the program never saw")) {
    const home = join(work, "project");
    mkdirSync(join(home, "helpers"), { recursive: true });
    mkdirSync(join(home, "data"));
    writeFileSync(join(home, "helpers", "shapes.py"), "#level beginner\ndef area(w: int, h: int) -> int:\n    return w / h\n");
    writeFileSync(join(home, "data", "cars.csv"), "name\nvw\n");
    writeFileSync(join(home, "latin.dat"), Buffer.from([0xff, 0x00, 0x41]));
    writeFileSync(join(home, "old.txt"), "x\n");
    writeFileSync(join(home, "history.txt"), "old\n".repeat(800_000));
    const main = fixture(
      "project/main.py",
      "import os, struct",
      'print(open("data/cars.csv").read().split()[1], os.path.basename(__file__))',
      'print(open(os.path.join(os.path.dirname(__file__), "latin.dat"), "rb").read())',
      'os.makedirs("out", exist_ok=True)',
      'open("out/nums.dat", "wb").write(struct.pack("<2i", 1, 300))',
      'os.remove("old.txt")',
      'open("history.txt", "a").write("new entry\\n")',
      "from helpers import shapes",
      "shapes.area(3, 2)",
    );
    const r = await run([main]);
    expect(r.stdout === "vw main.py\nb'\\xff\\x00A'\n", `a subfolder's file, __file__, and bytes as on disk: ${JSON.stringify(r.stdout)}`);
    expect(
      /TypeMismatch: `area` says it returns a whole number/.test(r.stderr) && /at helpers\/shapes\.py:3/.test(r.stderr),
      `a module in a subfolder is held to its own #level: ${r.stderr}`,
    );
    expect(
      readFileSync(join(home, "out", "nums.dat")).join() === "1,0,0,0,44,1,0,0",
      "binary output is saved as written, in the folder it was written to",
    );
    expect(!existsSync(join(home, "old.txt")) && /Deleted old\.txt next to main\.py\./.test(r.stderr), `a deletion is carried back: ${r.stderr}`);
    expect(
      readFileSync(join(home, "history.txt"), "utf8").length === 3_200_000 &&
        /Not loaded: history\.txt - each file can be at most 2 MB\./.test(r.stderr) &&
        /Not saved: history\.txt - it was not loaded, so saving it would replace a file the program never saw\./.test(r.stderr),
      `a file too big to load is not replaced by what the program appended: ${r.stderr}`,
    );
    const quiet = await run(["-q", main]);
    expect(/Not loaded: history\.txt/.test(quiet.stderr), `said even with -q, as a problem: ${quiet.stderr}`);
    console.log("    helpers/shapes.py at its level; out/nums.dat saved; history.txt kept");
  }

  if (section(27, "output: when it appears, where PLL's lines start, and a closed pipe")) {
    const late = await run([
      fixture("late27.py", 'print("x is", 5)', "import time", "t = time.time()", "while time.time() - t < 1.5:", "    pass", 'print("end")'),
    ]);
    const first = late.stdoutAt.find((piece) => piece.text.includes("5\n"));
    const last = late.stdoutAt.find((piece) => piece.text.includes("end"));
    expect(
      first && last && last.at - first.at > 1000,
      `a finished line is shown as it is printed, not with the next one: ${JSON.stringify(late.stdoutAt)}`,
    );
    const partial = await run([
      fixture("partial27.py", "import sys", 'sys.stderr.write("working")', 'open("p27.txt", "w").write("x")'),
    ]);
    expect(/working\nSaved p27\.txt/.test(partial.stderr), `PLL's line starts on a line of its own: ${JSON.stringify(partial.stderr)}`);
    const piped = await run([fixture("loop27.py", "while True:", '    print("y")')], { closeStdoutAfter: "y\ny\n" });
    expect(
      piped.code === 141 && !piped.timedOut && !/EPIPE|at .*\.cjs/.test(piped.stderr),
      `a closed pipe ends the run quietly, as SIGPIPE would: ${piped.code} ${piped.stderr.slice(-300)}`,
    );
    const warned = await run([fixture("warn27.py", "#level beginner", 'print("\\d digits")')]);
    expect(
      (warned.stderr.match(/invalid escape sequence/g) ?? []).length === 1 &&
        /warning: line 2: invalid escape sequence '\\d'/.test(warned.stderr),
      `a SyntaxWarning is said once: ${warned.stderr}`,
    );
    mkdirSync(join(work, "warns"));
    fixture("warns/helper27.py", "def f():", '    return "\\d"');
    const passing = await run([
      fixture("warns/main27.py", "import helper27", "def test_f():", '    print("checking f")', '    assert helper27.f() == "\\\\d"'),
    ]);
    expect(
      (passing.stderr.match(/invalid escape sequence/g) ?? []).length === 1 &&
        /warning: helper27\.py, line 2: invalid escape sequence/.test(passing.stderr),
      `one in an imported file names it: ${passing.stderr}`,
    );
    expect(/ok   test_f\n\s+checking f\n/.test(passing.stderr), `a passing test's output is shown: ${passing.stderr}`);
    const flushed = await run([
      // After a line, so that the partial one is not simply the run's first
      // output, which is always posted at once.
      fixture("flush27.py", "import time", 'print("start")', 'print("working", end="", flush=True)', "t = time.time()", "while time.time() - t < 1.5:", "    pass", 'print(" done")'),
    ]);
    const working = flushed.stdoutAt.find((piece) => piece.text.includes("working"));
    const done = flushed.stdoutAt.find((piece) => piece.text.includes("done"));
    expect(working && done && done.at - working.at > 1000, `flush() shows a partial line at once: ${JSON.stringify(flushed.stdoutAt)}`);
    console.log("    lines on time, on their own line, once; a closed pipe exits 141");
  }

  if (section(28, "stdin is read exactly, and Ctrl+C reaches input() and time.sleep")) {
    const reader = fixture("read28.py", "import sys", "data = sys.stdin.read()", "print(len(data), repr(data[-5:]))");
    const exact = await run([reader], { stdin: "line\n".repeat(5000) + "end" });
    expect(exact.stdout === "25003 'e\\nend'\n", `all of it, with no newline added: ${JSON.stringify(exact.stdout)}`);
    // A program that handles the end of its input: a Stop is not that.
    const asking = await run([fixture("ask28.py", "try:", '    x = input("? ")', "except EOFError:", '    print("got eof")', 'print("got", x)')], {
      openStdin: true,
      signalAfter: "? ",
      signalDelay: 300,
    });
    expect(
      asking.code === 1 && !asking.timedOut && /KeyboardInterrupt/.test(asking.stderr) && !/got/.test(asking.stdout),
      `one Ctrl+C at input() stops the program: ${asking.code} ${asking.stderr}`,
    );
    expect(
      /^KeyboardInterrupt[^\n]*\n\s+at ask28\.py:2\b/m.test(asking.stderr) && !/EOFError/.test(asking.stderr),
      `raised by the read, not after an end of input: ${asking.stderr}`,
    );
    const started = Date.now();
    const sleeping = await run(
      [fixture("sleep28.py", "import time", 'print("sleeping", flush=True)', "time.sleep(30)", 'print("woke")')],
      { signalAfter: "sleeping", signalDelay: 300 },
    );
    expect(
      sleeping.code === 1 && Date.now() - started < 20_000 && /at sleep28\.py:3/.test(sleeping.stderr),
      `and one in time.sleep, at once, at the sleep: ${sleeping.code} ${Date.now() - started}ms ${sleeping.stderr}`,
    );
    expect(/The program was stopped/.test(sleeping.stderr), `said as a Stop: ${sleeping.stderr}`);
    const caught = await run(
      [
        fixture(
          "caught28.py",
          "import time",
          "try:",
          '    print("looping", flush=True)',
          "    while True:",
          "        time.sleep(0.01)",
          "except KeyboardInterrupt:",
          '    print("caught it")',
          "",
          "def test_a():",
          "    assert True",
        ),
      ],
      { signalAfter: "looping", signalDelay: 300 },
    );
    expect(
      caught.code === 1 && /caught it/.test(caught.stdout) && /Stopped\. The tests were not run\./.test(caught.stderr) && !/Tests:/.test(caught.stderr),
      `a Stop the program catches still ends the run, before its tests: ${caught.code} ${caught.stderr}`,
    );
    console.log("    25003 characters read; input() and sleep stopped by one Ctrl+C");
  }

  if (section(29, "sources as Python reads them; pytest's marks; messages as CPython words them")) {
    writeFileSync(join(work, "bom29.py"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('#level beginner\nprint("bom")\n')]));
    const bom = await run(["bom29.py"]);
    expect(bom.code === 0 && bom.stdout === "bom\n" && /bom29\.py \[beginner\]/.test(bom.stderr), `a byte-order mark is dropped: ${bom.stderr}`);
    writeFileSync(join(work, "latin29.py"), Buffer.from('# -*- coding: latin-1 -*-\nprint("caf\xe9")\n', "latin1"));
    const latin = await run(["latin29.py"]);
    expect(latin.stdout === "café\n", `a declared encoding is read as that: ${JSON.stringify(latin.stdout)}`);
    writeFileSync(join(work, "bad29.py"), Buffer.from('print("caf\xe9")\n', "latin1"));
    const bad = await run(["bad29.py"]);
    expect(bad.code === 1 && /bad29\.py is not saved as UTF-8 \(byte 0xe9 on line 1\)/.test(bad.stderr), `an undeclared one is refused: ${bad.stderr}`);
    const marks = await run([
      fixture(
        "marks29.py",
        "import pytest",
        "def test_raises():",
        '    raise KeyboardInterrupt("mine")',
        '@pytest.mark.skip(reason="not yet")',
        "def test_skip():",
        "    assert False",
        '@pytest.mark.skipif(True, reason="never here")',
        "def test_skipif():",
        "    assert False",
        '@pytest.mark.xfail(reason="known bug")',
        "def test_xfail():",
        "    assert 1 == 2",
        "@pytest.mark.xfail(strict=True)",
        "def test_xpass_strict():",
        "    assert True",
        "def test_xfail_call():",
        '    pytest.xfail("not done")',
      ),
    ]);
    expect(/Tests: 1 failed, 1 error, 4 skipped/.test(marks.stderr), `marks are kept: ${marks.stderr}`);
    expect(/ERROR test_raises[^\n]*\n\s+KeyboardInterrupt: mine/.test(marks.stderr), `a test's own KeyboardInterrupt is its error, not a Stop: ${marks.stderr}`);
    expect(/skip test_skip \(line 5\)\n\s+not yet/.test(marks.stderr) && /skip test_skipif/.test(marks.stderr), `skipped, with why: ${marks.stderr}`);
    expect(/expected to fail: known bug, and did\./.test(marks.stderr) && /expected to fail: not done\./.test(marks.stderr), `xfail: ${marks.stderr}`);
    expect(/FAILED test_xpass_strict[^\n]*\n\s+expected to fail, but passed\./.test(marks.stderr), `a strict xfail that passes fails: ${marks.stderr}`);
    const own = await run([fixture("own29.py", 'raise ValueError("bad input")')]);
    expect(/^ValueError: bad input$/m.test(own.stderr), `a message the student wrote is not added to: ${own.stderr}`);
    const missing = await run([fixture("errno29.py", 'open("nowhere.csv")')]);
    expect(/\[Errno 2\] No such file or directory: 'nowhere\.csv'/.test(missing.stderr), `CPython's errno: ${missing.stderr}`);
    console.log("    BOM, coding line and refusal; skip, skipif, xfail; own message; Errno 2");
  }

  if (section(30, "Python that cannot start, tables, and the package itself")) {
    // A copy of the CLI whose `pyodide` resolves to nothing usable.
    const lonely = join(work, "lonely");
    mkdirSync(join(lonely, "node_modules", "pyodide"), { recursive: true });
    writeFileSync(join(lonely, "node_modules", "pyodide", "package.json"), '{"name":"pyodide","main":"missing.js"}');
    for (const file of ["cli.cjs", "worker.cjs"]) writeFileSync(join(lonely, file), readFileSync(join(ROOT, "dist-cli", file)));
    const started = await new Promise((resolveRun) => {
      const child = spawn(process.execPath, [join(lonely, "cli.cjs"), fixture("start30.py", 'print("x")')], { cwd: work });
      let stderr = "";
      child.stderr.on("data", (b) => (stderr += b));
      child.on("close", (code) => resolveRun({ code, stderr }));
    });
    expect(
      started.code === 64 && (started.stderr.match(/Python could not start/g) ?? []).length === 1 && !/at .*\.cjs/.test(started.stderr),
      `said once, exit 64, no stack: ${started.code} ${started.stderr}`,
    );
    const table = await run([fixture("table30.py", "#level advanced", 'table(["name", "n"], [["José", 1], ["李华", 22], ["e\u0301x", 3]])')]);
    expect(
      table.stdout.split("\n").slice(2, 5).join("|") === "José  1|李华  22|e\u0301x    3",
      `cells padded by what a terminal shows: ${JSON.stringify(table.stdout)}`,
    );
    const manifest = JSON.parse(readFileSync(join(ROOT, "dist-cli", "package.json"), "utf8"));
    expect(manifest.files.includes("LICENSE") && existsSync(join(ROOT, "dist-cli", "LICENSE")), `the licence is shipped: ${manifest.files}`);
    expect(manifest.bin["pll-python"] === "./cli.cjs" && manifest.bin.pll === "./cli.cjs", `both commands: ${JSON.stringify(manifest.bin)}`);
    for (const file of ["cli.cjs", "worker.cjs"]) {
      expect(!/sourceMappingURL/.test(readFileSync(join(ROOT, "dist-cli", file), "utf8")), `${file} names no map it does not ship`);
    }
    expect(!readdirSync(join(ROOT, "dist-cli")).some((name) => name.endsWith(".tgz")), "no tarball left from an earlier version");
    console.log("    no Python: one line, 64; José and 李华 aligned; LICENSE, both commands, no maps");
  }

  rmSync(work, { recursive: true, force: true });
  if (!passed()) {
    console.error("\nsmoke-cli: FAILED");
    process.exit(1);
  }
  console.log("\nsmoke-cli: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
