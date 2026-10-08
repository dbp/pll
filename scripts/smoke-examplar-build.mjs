#!/usr/bin/env node
/**
 * `pll examplar build`, against the built CLI.
 *
 * This is the authoring half of Examplar, and it runs the real worker: the
 * bytecode in a bundle is compiled by the Pyodide this package pins, which
 * is the whole reason bundles are built with this tool rather than a local
 * python. Driving the CLI as a child process is what checks that.
 *
 * Requires `pnpm run build`.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, passed } from "./lib/check.mjs";
import { ROOT } from "./lib/bundle.mjs";

const CLI = resolve(ROOT, "dist-cli", "cli.cjs");

const work = mkdtempSync(join(tmpdir(), "pll-examplar-"));
function write(rel, ...lines) {
  const file = join(work, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}

/** Same, but in the repo root - for the sample bundle that lives there. */
function runHere(args) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [CLI, "--no-color", ...args], { cwd: ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", rej);
    child.on("close", (code) => res({ code, stdout, stderr }));
  });
}

function run(args) {
  return new Promise((res, rej) => {
    // A cache of its own: a bundle fetched here must not land in the user's.
    const env = { ...process.env, PLL_CACHE_DIR: join(work, "cache") };
    const child = spawn(process.execPath, [CLI, "--no-color", ...args], { cwd: work, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", rej);
    child.on("close", (code) => res({ code, stdout, stderr }));
  });
}

const WHEAT = ["def shout(word):", '    return word.upper() + "!"', "", "def total(ns):", "    return sum(ns)"];
const ALT = [
  "def shout(word):",
  '    return "".join(c.upper() for c in word) + "!"',
  "",
  "def total(ns):",
  "    running = 0",
  "    for n in ns:",
  "        running = running + n",
  "    return running",
];
const NO_BANG = ["def shout(word):", "    return word.upper()", "", "def total(ns):", "    return sum(ns)"];
const SKIPS = ["def shout(word):", '    return word.upper() + "!"', "", "def total(ns):", "    return sum(ns[1:])"];

async function main() {
  if (!existsSync(CLI)) {
    console.error(`Missing ${CLI}. Run \`pnpm run build\` first.`);
    process.exit(1);
  }
  write("hw/wheats/reference.py", ...WHEAT);
  write("hw/wheats/alternative.py", ...ALT);
  // A chaff lives in a directory named after the function it breaks.
  write("hw/chaffs/shout/1.py", ...NO_BANG);
  write("hw/chaffs/total/1.py", ...SKIPS);

  console.log("\n[1] build writes a bundle of bytecode, compiled by this Pyodide");
  {
    const r = await run(["examplar", "build", "hw"]);
    expect(r.code === 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
    let bundle;
    try {
      bundle = JSON.parse(r.stdout);
    } catch {
      expect(false, `stdout should be JSON, got ${r.stdout.slice(0, 120)}`);
      return;
    }
    expect(bundle.examplar === 2, `format: ${bundle.examplar}`);
    expect(bundle.provides.join(",") === "shout,total", `provides: ${bundle.provides}`);
    expect(bundle.wheats.length === 2 && bundle.chaffs.length === 2, "two of each");
    expect(
      bundle.wheats.map((w) => w.id).join(",") === "alternative,reference",
      `wheat ids: ${bundle.wheats.map((w) => w.id)}`,
    );
    // Each chaff records the function it breaks, so the report can be
    // per function - and ids are per function, so they start over in each.
    expect(
      bundle.chaffs.map((c) => `${c.targets}/${c.id}`).join(",") === "shout/1,total/1",
      `chaff ids: ${bundle.chaffs.map((c) => `${c.targets}/${c.id}`)}`,
    );
    // The point of building here: bytecode that matches the interpreter.
    expect(/^3\.\d+\.\d+$/.test(bundle.built.python), `python: ${bundle.built.python}`);
    expect(/^[0-9a-f]{8}$/.test(bundle.built.magic), `magic: ${bundle.built.magic}`);
    // Sources must not travel in the bundle.
    const blob = JSON.stringify(bundle);
    expect(!blob.includes("def shout"), "the bundle must not contain source text");
    expect(!blob.includes("running = running"), "nor any of the implementations' code");
    console.log(
      `    python ${bundle.built.python}, magic ${bundle.built.magic}, ${blob.length} bytes, no source`,
    );
  }

  console.log("\n[2] -o writes to a file");
  {
    const r = await run(["examplar", "build", "hw", "-o", "hw.json"]);
    expect(r.code === 0, `expected exit 0, got ${r.code}`);
    expect(existsSync(join(work, "hw.json")), "the bundle should be written");
    expect(r.stdout === "", `stdout should be quiet with -o, got ${r.stdout}`);
    expect(/wrote hw\.json/.test(r.stderr), `expected a note, got ${r.stderr}`);
    console.log("    wrote hw.json");
  }

  console.log("\n[3] --verify accepts a sound bundle");
  {
    write("staff.py", 'def test_shout():', '    assert shout("hi") == "HI!"', "", "def test_total():", "    assert total([1, 2, 3]) == 6");
    const r = await run(["examplar", "build", "hw", "-o", "ok.json", "--verify", "staff.py"]);
    expect(r.code === 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
    expect(/verified\./.test(r.stderr), `expected "verified.", got ${r.stderr}`);
    expect(/chaff shout\/1: caught by test_shout/.test(r.stderr),
      `it should name each chaff by function and id, got ${r.stderr}`);
    expect(existsSync(join(work, "ok.json")), "a verified bundle is written");
    console.log("    verified and written");
  }

  console.log("\n[4] --verify refuses a chaff nothing catches");
  {
    write("weak.py", "def test_shout():", '    assert shout("hi") == "HI!"');
    const r = await run(["examplar", "build", "hw", "-o", "weak.json", "--verify", "weak.py"]);
    expect(r.code === 3, `an unsound bundle should exit 3, got ${r.code}`);
    // `total` has no test at all, so its chaffs were never run. That is a
    // failure rather than a note: `--verify` exists to prove every chaff is
    // catchable, and these are simply unproven.
    expect(/BAD +your own suite has no tests for total/.test(r.stderr),
      `expected the untested function to fail, got ${r.stderr}`);
    expect(/unproven/.test(r.stderr), "and to say why that matters");
    expect(!/chaff total/.test(r.stderr), `with no verdict on its chaffs, got ${r.stderr}`);
    expect(!existsSync(join(work, "weak.json")), "an unsound bundle must not be written");

    // With a test for `total` that is too weak, its chaff *is* run and is
    // named - that is a real gap rather than an unstarted function.
    write("weak2.py", "def test_shout():", '    assert shout("hi") == "HI!"', "",
      "def test_total():", "    assert total([]) == 0");
    const gap = await run(["examplar", "build", "hw", "-o", "gap.json", "--verify", "weak2.py"]);
    expect(gap.code === 3, `expected exit 3, got ${gap.code}`);
    expect(/BAD +chaff total\/1/.test(gap.stderr), `expected the chaff named, got ${gap.stderr}`);
    expect(/no test catches it/.test(gap.stderr), "and why it is bad");
    console.log("    an unstarted function and a real gap are reported differently");
  }

  console.log("\n[5] --verify catches a staff test that is itself wrong");
  {
    write("wrong.py", "def test_shout():", '    assert shout("hi") == "hi!"', "", "def test_total():", "    assert total([1, 2, 3]) == 6");
    const r = await run(["examplar", "build", "hw", "--verify", "wrong.py"]);
    expect(r.code === 3, `expected exit 3, got ${r.code}`);
    expect(/BAD +wheat/.test(r.stderr), `expected a wheat to be flagged, got ${r.stderr}`);
    // pytest's rewriting is what makes this message useful at all.
    expect(/assert 'HI!' == 'hi!'/.test(r.stderr), `expected the rewritten assertion, got ${r.stderr}`);
    // Phase two is gated: a suite that is wrong fails on every chaff, so
    // checking coverage would say nothing. Reported, not silent.
    expect(/shout chaffs not checked/.test(r.stderr), `expected the gate to be reported, got ${r.stderr}`);
    expect(!/ chaff shout/.test(r.stderr), `no chaff verdict should appear, got ${r.stderr}`);
    // Gated per function: `total`'s own test is fine, so its chaffs ran.
    expect(/chaff total\/1: caught by/.test(r.stderr), `total should still be scored, got ${r.stderr}`);
    console.log("    flagged the wheats, withheld shout's chaffs, scored total's");
  }

  console.log("\n[6] incoherent and missing inputs are reported");
  {
    write("bad/wheats/a.py", "def shout(w):", "    return w");
    write("bad/chaffs/shout/b.py", "def shout(w):", "    return w", "", "def extra(x):", "    return x");
    const mismatch = await run(["examplar", "build", "bad"]);
    expect(mismatch.code === 64, `expected exit 64, got ${mismatch.code}`);
    expect(/different set of names/.test(mismatch.stderr), `got ${mismatch.stderr.split("\n")[0]}`);

    write("broken/wheats/a.py", "def shout(:");
    write("broken/chaffs/shout/b.py", "def shout(w):", "    return w");
    const syntax = await run(["examplar", "build", "broken"]);
    expect(syntax.code === 64 && /does not parse/.test(syntax.stderr), `got ${syntax.stderr.split("\n")[0]}`);

    for (const [args, pattern] of [
      [["examplar", "build", "nope"], /does not exist/],
      [["examplar", "frobnicate"], /unknown examplar subcommand/],
      [["examplar"], /needs a subcommand/],
      [["examplar", "build", "hw", "-o"], /-o needs a file/],
      [["examplar", "build", "hw", "--verify"], /--verify needs a test file/],
    ]) {
      const r = await run(args);
      expect(r.code === 64, `${args.join(" ")}: expected 64, got ${r.code}`);
      expect(pattern.test(r.stderr), `${args.join(" ")}: expected ${pattern}, got ${r.stderr.split("\n")[0]}`);
    }
    const help = await run(["examplar", "--help"]);
    expect(help.code === 0 && /pll examplar build/.test(help.stdout), "examplar --help works");
    console.log("    seven input errors, and --help");
  }

  console.log("\n[6b] the chaff layout is stated, not guessed");
  {
    // The directory is how an author says which function a chaff breaks, so
    // the three ways of getting it wrong all have to say what to do.
    write("loose/wheats/a.py", "def shout(w):", "    return w");
    write("loose/chaffs/1.py", "def shout(w):", "    return w.upper()");
    const loose = await run(["examplar", "build", "loose"]);
    expect(loose.code === 64, `expected exit 64, got ${loose.code}`);
    expect(/is not inside a function's directory/.test(loose.stderr), `got ${loose.stderr.split("\n")[0]}`);
    expect(/chaffs\/<function>\/1\.py/.test(loose.stderr), "and says where it should go");

    write("stray/wheats/a.py", "def shout(w):", "    return w");
    write("stray/chaffs/shoutt/1.py", "def shout(w):", "    return w.upper()");
    const stray = await run(["examplar", "build", "stray"]);
    expect(stray.code === 64, `expected exit 64, got ${stray.code}`);
    expect(/chaffs\/shoutt is not one of the functions/.test(stray.stderr), `got ${stray.stderr.split("\n")[0]}`);

    write("barren/wheats/a.py", "def shout(w):", "    return w", "", "def total(ns):", "    return sum(ns)");
    write("barren/chaffs/shout/1.py", "def shout(w):", "    return w.upper()", "", "def total(ns):", "    return sum(ns)");
    const barren = await run(["examplar", "build", "barren"]);
    expect(barren.code === 64, `expected exit 64, got ${barren.code}`);
    expect(/total has no chaffs/.test(barren.stderr), `got ${barren.stderr.split("\n")[0]}`);
    console.log("    a loose chaff, an unknown function, and a function with none");
  }

  console.log("\n[7] global flags may precede the subcommand");
  {
    const r = await run(["examplar", "build", "hw"]);
    const quiet = await new Promise((res, rej) => {
      const child = spawn(process.execPath, [CLI, "--quiet", "--no-color", "examplar", "build", "hw"], { cwd: work });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (b) => (stdout += b.toString()));
      child.stderr.on("data", (b) => (stderr += b.toString()));
      child.on("error", rej);
      child.on("close", (code) => res({ code, stdout, stderr }));
    });
    expect(quiet.code === 0, `--quiet before the subcommand should work, got ${quiet.code}: ${quiet.stderr}`);
    expect(quiet.stdout === r.stdout, "the bundle should be identical either way");
    expect(quiet.stderr === "", `--quiet should silence the notes, got ${quiet.stderr}`);
    console.log("    `pll --quiet --no-color examplar build` behaves");
  }

  console.log("\n[8] only the suite's definitions are run, not its program");
  {
    // The phase runs with the workspace unmounted, and it runs the file once
    // per implementation, so its top-level statements are deliberately not
    // executed: `print` would go four times over, `input()` would block the
    // check forever, and `open` would fail on a file that is plainly there.
    // Only definitions load, so a verdict survives all of it.
    write(
      "noisy.py",
      'print("this should not run four times")',
      'open("definitely-missing.csv")',
      'if True:',
      '    raise SystemExit("nor should this")',
      "",
      "def test_shout():",
      '    assert shout("hi") == "HI!"',
      "",
      "def test_total():",
      "    assert total([1, 2, 3]) == 6",
    );
    const r = await run(["examplar", "build", "hw", "--verify", "noisy.py"]);
    expect(r.code === 0, `top-level statements should not break the verdict, got ${r.code}: ${r.stderr}`);
    expect(/verified\./.test(r.stderr), `expected "verified.", got ${r.stderr}`);
    expect(
      !/this should not run/.test(r.stderr) && !/this should not run/.test(r.stdout),
      "and its top-level output should not appear at all",
    );
    console.log("    a suite with a program attached still verifies");

    // A definition that cannot load here costs only itself: the tests that
    // needed it say so, and the rest still count.
    write(
      "needsfile.py",
      'DATA = open("definitely-missing.csv").read()',
      "",
      "def test_shout():",
      '    assert shout("hi") == "HI!"',
      "",
      "def test_total():",
      "    assert total(DATA) == 6",
    );
    const partial = await run(["examplar", "build", "hw", "--verify", "needsfile.py"]);
    expect(partial.code === 3, `expected exit 3, got ${partial.code}`);
    expect(/NameError/.test(partial.stderr), `expected the skipped definition to surface, got ${partial.stderr}`);
    // An error is not a pass, so it gates phase two exactly as a
    // disagreement does - the suite is not a measuring instrument until
    // every test in it runs and agrees.
    expect(/total chaffs not checked/.test(partial.stderr),
      `an error should gate too, got ${partial.stderr}`);
    expect(!/chaff total/.test(partial.stderr), `so no verdict there, got ${partial.stderr}`);
    // And only there: `test_shout` did not need `DATA`, so shout is scored.
    expect(/chaff shout\/1: caught by test_shout$/m.test(partial.stderr),
      `shout should still be scored, by its own test alone, got ${partial.stderr}`);
    console.log("    the tests that needed it are gated; the others are still scored");
  }

  console.log("\n[9] the sample bundle in samples/ is sound");
  {
    // `samples/examplar_bundle` is documentation, and documentation rots.
    // It is also the only worked example of the authoring workflow, so if
    // editing a wheat quietly makes a chaff uncatchable, that should fail
    // here rather than in front of a class.
    const staff = await runHere([
      "examplar",
      "build",
      "samples/examplar_bundle",
      "--verify",
      "samples/examplar_bundle/staff_tests.py",
    ]);
    expect(staff.code === 0, `the sample bundle should verify, got ${staff.code}: ${staff.stderr}`);
    expect(/verified\./.test(staff.stderr), `expected "verified.", got ${staff.stderr}`);
    expect(
      /providing initials, longest/.test(staff.stderr),
      `expected both functions, got ${staff.stderr.split("\n")[0]}`,
    );
    console.log(`    ${staff.stderr.split("\n")[0]}`);

    // And the student sample has to *demonstrate* a gap, since that is the
    // whole point of it - all its tests right, and some chaffs still through.
    const student = await runHere([
      "examplar",
      "build",
      "samples/examplar_bundle",
      "--verify",
      "samples/examplar.py",
    ]);
    expect(student.code === 3, `the student sample should leave a gap, got ${student.code}`);
    expect(
      !/BAD +wheat/.test(student.stderr),
      `but every test in it must be right, got ${student.stderr}`,
    );
    const uncaught = [...student.stderr.matchAll(/BAD +chaff (\S+):/g)].map((m) => m[1]);
    expect(
      uncaught.join(",") === "initials/2,initials/3,longest/1,longest/2",
      `expected two gaps per function, got ${uncaught.join(",") || "none"}`,
    );
    console.log(`    samples/examplar.py passes the wheats and misses chaffs ${uncaught.join(", ")}`);
  }

  console.log("\n[10] a student's check: the names a run has, nothing given away, nothing stuck");
  {
    // Bundles served from here, as a course's server would.
    const server = createServer((req, res) => {
      try {
        res.end(readFileSync(join(work, "site", req.url.slice(1))));
      } catch {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const bundle = async (name, wheat, chaffs) => {
      write(`${name}/wheats/reference.py`, ...wheat);
      for (const [id, lines] of Object.entries(chaffs)) write(`${name}/chaffs/${id}.py`, ...lines);
      const built = await run(["examplar", "build", name, "-o", `site/${name}.json`]);
      expect(built.code === 0, `${name} builds: ${built.stderr}`);
    };
    const student = (name, ...lines) =>
      run([write(`students/${name}.py`, `#examplar ${base}/${name}.json`, "", ...lines)]);
    mkdirSync(join(work, "site"), { recursive: true });

    // An image assignment: the implementation draws, and the test measures.
    await bundle("dots", ['def dot(r):', '    return circle(r, "solid", "red")'], {
      "dot/1": ['def dot(r):', '    return circle(r + 1, "solid", "red")'],
    });
    const dots = await student("dots", "def test_dot():", "    assert image_width(dot(5)) == 10");
    expect(/dot\n  Against correct implementations: your test passes\./.test(dots.stderr), `the libraries are there: ${dots.stderr}`);
    expect(/Against buggy implementations: caught all 1\./.test(dots.stderr), `and it is scored: ${dots.stderr}`);

    // A correct implementation's own error is not shown, and counts as a disagreement.
    const SHOUT = ['def shout(s):', '    if not s:', '        raise ValueError("shout needs at least one character")', '    return s.upper() + "!"'];
    await bundle("shouts", SHOUT, { "shout/1": ['def shout(s):', '    return s.upper()'] });
    const rejected = await student(
      "shouts",
      "import sys",
      "def test_hi():",
      '    print("checking hi")',
      '    assert shout("hi") == "HI!"',
      "def test_empty():",
      '    assert shout("") == ""',
      "def test_main():",
      '    assert sys.modules["__main__"].shout is shout',
      "def test_number():",
      '    assert int(shout("x")) == 1',
    );
    // Up to the file's own tests, which run after the check, and say what they printed.
    const card = rejected.stderr.slice(rejected.stderr.indexOf("examplar: shout"), rejected.stderr.indexOf("Tests:"));
    expect(/expects? the wrong answer:\n    test_empty\n/.test(card), `a disagreement, by name: ${card}`);
    expect(!/shout needs|X!/.test(card), `nothing the implementation said or gave back: ${card}`);
    expect(/could not run here:\n    test_number\n      ValueError\n/.test(card), `an error of their own, by its type: ${card}`);
    expect(!/test_main/.test(card), `the check is __main__: ${card}`);
    expect(!/checking hi/.test(rejected.stdout + card), `and what it printed is dropped: ${rejected.stdout}${card}`);

    // A buggy implementation that never finishes stops the check.
    await bundle("loops", SHOUT, { "shout/1": ['def shout(s):', '    while True:', '        pass'] });
    const started = Date.now();
    const stuck = await student("loops", "def test_hi():", '    assert shout("hi") == "HI!"');
    expect(
      /`test_hi` ran for more than 2 seconds against a known buggy implementation, so the check stopped\./.test(stuck.stderr),
      `the card says so: ${stuck.stderr}`,
    );
    expect(Date.now() - started < 60_000, `and the run goes on: ${Date.now() - started} ms`);
    // And so does one that will not load.
    await bundle("unloadable", SHOUT, { "shout/1": ["import nothing_here", "def shout(s):", "    return s"] });
    const broken = await student("unloadable", "def test_hi():", '    assert shout("hi") == "HI!"');
    expect(/a known buggy implementation could not be loaded/.test(broken.stderr), `not counted as caught: ${broken.stderr}`);
    // A file of theirs that is not there during the check is named.
    const helper = await student("shouts", "from helper import word", "def test_hi():", '    assert shout(word) == "HI!"');
    expect(
      /Line 3 could not run here: ModuleNotFoundError: No module named 'helper'\./.test(helper.stderr),
      `the line that needed it: ${helper.stderr}`,
    );

    // And `--verify` refuses both broken bundles before a student meets them.
    write("verify.py", "def test_hi():", '    assert shout("hi") == "HI!"');
    const verifyStuck = await run(["examplar", "build", "loops", "--verify", "verify.py"]);
    expect(verifyStuck.code === 3 && /BAD +chaff shout\/1: test_hi ran for more than 2 seconds/.test(verifyStuck.stderr),
      `a chaff that never finishes: ${verifyStuck.stderr}`);
    const verifyBroken = await run(["examplar", "build", "unloadable", "--verify", "verify.py"]);
    expect(verifyBroken.code === 3 && /BAD +chaff shout\/1: the implementation could not be loaded/.test(verifyBroken.stderr),
      `a chaff that will not load: ${verifyBroken.stderr}`);
    await new Promise((r) => server.close(r));
    console.log("    libraries present; nothing given away; stuck and broken bundles stopped");
  }

  rmSync(work, { recursive: true, force: true });
  if (!passed()) {
    console.error("\nsmoke-examplar-build: FAILED");
    process.exit(1);
  }
  console.log("\nsmoke-examplar-build: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
