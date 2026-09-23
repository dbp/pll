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
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const CLI = resolve(ROOT, "dist-cli", "cli.cjs");

let ok = true;
function expect(cond, msg) {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    ok = false;
  }
}

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

function run(args, { stdin = "", signalAfter = null, signal = "SIGINT" } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI, "--no-color", ...args], {
      cwd: work,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timer = null;
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, RUN_TIMEOUT_MS);
    child.stdout.on("data", (b) => {
      stdout += b.toString();
      // Signal only once the program is demonstrably running, rather than
      // on a timer that could fire before Pyodide has booted.
      if (signalAfter && stdout.includes(signalAfter) && timer === null) {
        timer = setTimeout(() => child.kill(signal), 150);
      }
    });
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", reject);
    child.on("close", (code, sig) => {
      if (timer) clearTimeout(timer);
      clearTimeout(deadline);
      resolvePromise({ code, signal: sig, stdout, stderr, timedOut });
    });
    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
  });
}

async function main() {
  if (!existsSync(CLI)) {
    console.error(`Missing ${CLI}. Run \`pnpm run build\` first.`);
    process.exit(1);
  }

  console.log("\n[1] a raw file runs, and stdout carries only its own output");
  {
    const file = fixture("plain.py", 'print("one")', 'print("two")');
    const r = await run([file]);
    expect(r.code === 0, `expected exit 0, got ${r.code}`);
    expect(r.stdout === "one\ntwo\n", `stdout should be just the program: ${JSON.stringify(r.stdout)}`);
    expect(/plain\.py \[raw\]/.test(r.stderr), "the level belongs on stderr");
    expect(!/one/.test(r.stderr), "program output must not be duplicated onto stderr");
    console.log(`    stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr.trim())}`);
  }

  console.log("\n[2] the level comes from the file, and blocks the run");
  {
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

  console.log("\n[3] a runtime error gets the friendly wording and exit 1");
  {
    const file = fixture("oops.py", "total = 10", "print(Total)");
    const r = await run([file]);
    expect(r.code === 1, `expected exit 1, got ${r.code}`);
    expect(/Python doesn't know what `Total` means/.test(r.stderr), `expected the friendly NameError, got ${r.stderr}`);
    expect(/How to fix/.test(r.stderr), "the fix hints should be shown");
    console.log(`    ${r.stderr.split("\n")[1]}`);
  }

  console.log("\n[4] type annotations are checked, and #level raw opts out");
  {
    const body = ["def add(x: int, y: int) -> int:", "    return x + y", 'print(add(2, "three"))'];
    const checked = await run([fixture("typed.py", "#level advanced", "", ...body)]);
    expect(checked.code === 1, `annotated mismatch should fail, got ${checked.code}`);
    expect(/whole number/.test(checked.stderr), `expected the rewritten wording, got ${checked.stderr}`);
    const rawRun = await run([fixture("typed_raw.py", "#level raw", "", ...body)]);
    expect(/TypeError/.test(rawRun.stderr), "raw should fail Python's own way instead");
    expect(!/whole number/.test(rawRun.stderr), "raw must not type-check");
    console.log("    advanced reported the annotation; raw reported Python's TypeError");
  }

  console.log("\n[5] in-file tests run first, and a failure is exit 3");
  {
    const good = fixture("t_ok.py", "def add(x, y):", "    return x + y", "", "def test_add():", "    assert add(2, 3) == 5", "", 'print("after")');
    const r = await run([good]);
    expect(r.code === 0, `passing tests should exit 0, got ${r.code}`);
    expect(/tests: 1 passed/.test(r.stderr), `expected a summary, got ${r.stderr}`);
    expect(/after/.test(r.stdout), "the file should still run after its tests");

    const bad = fixture("t_bad.py", "def add(x, y):", "    return x + y", "", "def test_add():", "    assert add(2, 3) == 6");
    const r2 = await run([bad]);
    expect(r2.code === 3, `failing tests should exit 3, got ${r2.code}`);
    expect(/FAILED test_add/.test(r2.stderr), `expected the failing name, got ${r2.stderr}`);

    const skipped = await run([bad, "--no-tests"]);
    expect(skipped.code === 0, `--no-tests should not fail, got ${skipped.code}`);
    expect(!/tests:/.test(skipped.stderr), "--no-tests should not report tests");
    console.log("    pass -> 0, fail -> 3, --no-tests -> 0");
  }

  console.log("\n[6] tables print as text; images and reactors do not run");
  {
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

  console.log("\n[7] input() reads stdin, and running dry is EOFError");
  {
    const file = fixture("ask.py", 'name = input("Name? ")', 'print("hi", name)');
    const r = await run([file], { stdin: "Ada\n" });
    expect(r.code === 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
    expect(/hi Ada/.test(r.stdout), `expected the answer to be used, got ${JSON.stringify(r.stdout)}`);
    const dry = await run([file]);
    expect(dry.code === 1 && /EOFError/.test(dry.stderr), `empty stdin should be EOFError, got ${dry.code}`);
    console.log("    piped a line, and an empty stdin raised EOFError");
  }

  console.log("\n[8] sibling files are read and written back");
  {
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

  console.log("\n[9] --quiet keeps only the program's output");
  {
    const file = fixture("quiet.py", "#level beginner", "", 'print("just this")');
    const r = await run([file, "--quiet"]);
    expect(r.stdout === "just this\n", `stdout: ${JSON.stringify(r.stdout)}`);
    expect(r.stderr === "", `stderr should be empty, got ${JSON.stringify(r.stderr)}`);
    console.log("    nothing but the program on either stream");
  }

  console.log("\n[10] usage problems are reported, not crashed on");
  {
    for (const [args, pattern] of [
      [[], /no file given/],
      [["--bogus", "x.py"], /unknown option/],
      [["notes.txt"], /not a \.py file/],
      [["missing.py"], /Cannot read/],
      [["x.py", "--save-images"], /needs a directory/],
    ]) {
      const r = await run(args);
      expect(r.code === 64, `${JSON.stringify(args)} should exit 64, got ${r.code}`);
      expect(pattern.test(r.stderr), `${JSON.stringify(args)}: expected ${pattern}, got ${r.stderr.split("\n")[0]}`);
    }
    const help = await run(["--help"]);
    expect(help.code === 0 && /pll <file\.py>/.test(help.stdout), "--help should print usage to stdout");
    const version = await run(["--version"]);
    expect(version.code === 0 && /^\d+\.\d+\.\d+/.test(version.stdout), `--version: ${version.stdout}`);
    console.log("    five usage errors, --help and --version");
  }

  console.log("\n[11] Ctrl+C stops a runaway program");
  {
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
    console.log(`    interrupted; exit=${r.code}`);
  }

  rmSync(work, { recursive: true, force: true });
  if (!ok) {
    console.error("\nsmoke-cli: FAILED");
    process.exit(1);
  }
  console.log("\nsmoke-cli: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
