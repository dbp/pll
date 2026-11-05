#!/usr/bin/env node
/**
 * Bundles: `#bundle <name> <url>` lines, and `pll bundle build`.
 *
 * The directive is read without Pyodide. The rest runs the real CLI as a
 * child process against a local server, as smoke-cli does: building a
 * bundle, a program using one by its name with no import, its name to the
 * static checks, an error raised inside one, a mistake in the student's own
 * function that one called, what is said when one can't be had, Examplar's
 * check of a file that has one, and the copy kept for a run without a
 * network.
 *
 * Requires `pnpm run build` so dist-cli/ exists.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, passed } from "./lib/check.mjs";
import { importSource, ROOT } from "./lib/bundle.mjs";

const CLI = resolve(ROOT, "dist-cli", "cli.cjs");

/** Longest one run may take, Pyodide's start included. */
const RUN_TIMEOUT_MS = 120_000;

const work = mkdtempSync(join(tmpdir(), "pll-bundle-"));
const cache = join(work, "cache");

function fixture(name, ...lines) {
  const file = join(work, name);
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}

/** Run the CLI, with its cache in the temp folder. Returns { code, stdout, stderr }. */
function run(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI, "--no-color", ...args], {
      cwd: work,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PLL_CACHE_DIR: cache },
    });
    let stdout = "";
    let stderr = "";
    const deadline = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(deadline);
      resolvePromise({ code, stdout, stderr });
    });
    child.stdin.end();
  });
}

/** A server for `files`, a map from path to body, with an ETag for each. */
function startServer(files) {
  const server = createServer((req, res) => {
    const body = files.get(req.url);
    if (body === undefined) {
      res.writeHead(404);
      res.end("nope");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json", ETag: `"${body.length}"` });
    res.end(body);
  });
  return new Promise((res) =>
    server.listen(0, "127.0.0.1", () => res({ server, base: `http://127.0.0.1:${server.address().port}` })),
  );
}

async function main() {
  if (!existsSync(CLI)) {
    console.error(`Missing ${CLI}. Run \`pnpm run build\` first.`);
    process.exit(1);
  }
  const { parseBundleDirectives } = await importSource(`export { parseBundleDirectives } from "./src/run/bundles";`);

  console.log("\n[1] the directive: names, addresses, and a comment that only uses the word");
  {
    const found = parseBundleDirectives(
      ["#level beginner", "#bundle mystery https://c.example/m.json", "# bundle shapes https://c.example/s.json", "", "print(1)"].join("\n"),
    );
    expect(found.problems.length === 0, `no problems: ${JSON.stringify(found.problems)}`);
    expect(found.bundles.map((b) => b.name).join() === "mystery,shapes", `names: ${JSON.stringify(found.bundles)}`);
    expect(found.bundles[0].line === 2 && found.bundles[0].url === "https://c.example/m.json", "its line and address");
    const joy = parseBundleDirectives("# bundle of joy\n");
    expect(joy.bundles.length === 0 && joy.problems.length === 0, "a comment that only uses the word is no directive");
    expect(
      parseBundleDirectives("x = 1  #bundle m https://c.example/m.json\n").bundles.length === 0,
      "only a whole line counts",
    );
    expect(
      parseBundleDirectives("#bundle local http://localhost:8000/m.json\r\n").bundles.length === 1,
      "plain http is allowed for localhost, and a CRLF line counts",
    );
    const bad = parseBundleDirectives(
      [
        "#bundle 9x https://c.example/a.json",
        "#bundle class https://c.example/b.json",
        "#bundle m https://c.example/c.json",
        "#bundle m https://c.example/d.json",
        "#bundle n http://c.example/e.json",
        "#bundle o ftp://c.example/f.json",
      ].join("\n"),
    );
    expect(bad.bundles.map((b) => b.name).join() === "m", `only m is usable: ${JSON.stringify(bad.bundles)}`);
    expect(bad.problems.map((p) => p.line).join() === "1,2,4,5,6", `problem lines: ${JSON.stringify(bad.problems)}`);
    expect(/`9x` can't name a bundle/.test(bad.problems[0].message), bad.problems[0].message);
    expect(/`class` can't name a bundle/.test(bad.problems[1].message), bad.problems[1].message);
    expect(/line 3 already names a bundle `m`/.test(bad.problems[2].message), bad.problems[2].message);
    expect(/must use https/.test(bad.problems[3].message), bad.problems[3].message);
    expect(/must be an https address/.test(bad.problems[4].message), bad.problems[4].message);
  }

  console.log("\n[2] pll bundle build: bytecode, without the author's tests");
  const source = fixture(
    "mystery.py",
    "#level intermediate",
    "import pytest",
    "",
    "@dataclass",
    "class Point:",
    "    x: int",
    "    y: int",
    "",
    "def twice_plus(n: int) -> int:",
    '    """the answer"""',
    "    return n * 2 + 1",
    "",
    "def flip(p: Point) -> Point:",
    "    return Point(p.y, p.x)",
    "",
    "def initial(s):",
    "    return s[0]",
    "",
    "def apply(f, x):",
    "    return f(x)",
    "",
    "def test_twice_plus():",
    "    assert twice_plus(3) == pytest.approx(7)",
  );
  const built = await run(["bundle", "build", source, "-o", join(work, "mystery.json")]);
  expect(built.code === 0, `build exits 0, got ${built.code}: ${built.stderr}`);
  expect(
    /built for Python 3\.\d+\.\d+, at #level intermediate: defines Point, twice_plus, flip, initial, apply\n/.test(built.stderr),
    `what it built: ${built.stderr}`,
  );
  const bundle = JSON.parse(readFileSync(join(work, "mystery.json"), "utf8"));
  expect(bundle.bundle === 1 && bundle.level === "intermediate" && typeof bundle.pyc === "string", "its shape");
  expect(!bundle.defines.includes("test_twice_plus"), `the author's tests are left out: ${bundle.defines}`);
  const toStdout = await run(["bundle", "build", source]);
  expect(toStdout.code === 0 && JSON.parse(toStdout.stdout).pyc === bundle.pyc, "without -o it goes to stdout");
  const broken = await run(["bundle", "build", fixture("broken.py", "def f(:")]);
  expect(broken.code === 64 && /broken\.py does not parse/.test(broken.stderr), `a syntax error: ${broken.stderr}`);
  const nested = await run([
    "bundle",
    "build",
    fixture("nested.py", "#bundle other https://c.example/o.json", "def f():", "    return other.g()"),
  ]);
  expect(nested.code === 64 && /can't use another bundle/.test(nested.stderr), `a bundle in a bundle: ${nested.stderr}`);
  const usage = await run(["bundle"]);
  expect(usage.code === 64 && /bundle needs a subcommand/.test(usage.stderr), `no subcommand: ${usage.stderr}`);
  const boom = await run(["bundle", "build", fixture("boom.py", "print(boom)"), "-o", join(work, "boom.json")]);
  expect(boom.code === 0, `a bundle whose top level raises still builds: ${boom.stderr}`);
  // An Examplar bundle too, for [8].
  mkdirSync(join(work, "ex", "wheats"), { recursive: true });
  mkdirSync(join(work, "ex", "chaffs", "f"), { recursive: true });
  fixture("ex/wheats/reference.py", "def f(n: int) -> int:", "    return n * 2 + 1");
  fixture("ex/chaffs/f/1.py", "def f(n: int) -> int:", "    return n * 2");
  const examplar = await run(["examplar", "build", join(work, "ex"), "-o", join(work, "examplar.json")]);
  expect(examplar.code === 0, `the Examplar bundle builds: ${examplar.stderr}`);

  const files = new Map([
    ["/mystery.json", readFileSync(join(work, "mystery.json"), "utf8")],
    ["/boom.json", readFileSync(join(work, "boom.json"), "utf8")],
    ["/examplar.json", readFileSync(join(work, "examplar.json"), "utf8")],
    ["/old.json", JSON.stringify({ ...bundle, built: { python: "3.12.1", magic: "cb0d0d0a" } })],
    ["/page.json", "<html>sign in</html>"],
  ]);
  const { server, base } = await startServer(files);
  const student = fixture(
    "student.py",
    "#level beginner",
    `#bundle mystery ${base}/mystery.json`,
    "",
    "print(mystery.twice_plus(5))",
    "print(mystery.flip(mystery.Point(1, 2)))",
    "",
    "def test_it():",
    "    assert mystery.twice_plus(0) == 1",
  );
  try {
    console.log("\n[3] a program uses a bundle by its name, with no import");
    {
      const r = await run([student]);
      expect(r.code === 0, `exit 0, got ${r.code}: ${r.stderr}`);
      expect(r.stdout === "11\nPoint(x=2, y=1)\n", `its output: ${JSON.stringify(r.stdout)}`);
      expect(/1 passed/.test(r.stderr), `its own test: ${r.stderr}`);
    }

    console.log("\n[4] its name to the static checks: given, so not to be reused or imported");
    {
      const line = `#bundle mystery ${base}/mystery.json`;
      const reused = await run([fixture("reused.py", "#level beginner", line, "", "mystery = 3")]);
      expect(
        reused.code === 2 &&
          /`mystery` is already defined: the `#bundle` line on line 2 gives it to this file\./.test(reused.stderr),
        `reused: ${reused.stderr}`,
      );
      const imported = await run([fixture("imported.py", "#level beginner", line, "import mystery", "", "print(1)")]);
      expect(
        imported.code === 2 &&
          /`mystery` needs no import: the `#bundle` line on line 2 gives it to this file\./.test(imported.stderr) &&
          /Delete this import\./.test(imported.stderr),
        `imported: ${imported.stderr}`,
      );
      const param = await run([
        fixture("param.py", "#level beginner", line, "", "def f(mystery: int) -> int:", "    return mystery", "", "print(f(2))"),
      ]);
      expect(param.code === 2 && /, and this parameter hides it\./.test(param.stderr), `a parameter: ${param.stderr}`);
      for (const level of ["advanced", "raw"]) {
        const header = level === "raw" ? [] : [`#level ${level}`];
        const r = await run([fixture(`${level}.py`, ...header, line, "", "print(mystery.twice_plus(1))")]);
        expect(r.code === 0 && r.stdout === "3\n", `at ${level}: ${r.code} ${JSON.stringify(r.stdout)} ${r.stderr}`);
      }
    }

    console.log("\n[5] an error inside a bundle's function is said to be there");
    {
      const inside = await run([
        fixture("inside.py", "#level beginner", `#bundle mystery ${base}/mystery.json`, "", 'print(mystery.twice_plus("a"))'),
      ]);
      expect(inside.code === 1, `exit 1, got ${inside.code}`);
      expect(/TypeError: Inside `twice_plus`: /.test(inside.stderr), `the headline: ${inside.stderr}`);
      expect(/at inside\.py:4/.test(inside.stderr), `at the student's call: ${inside.stderr}`);
      expect(/comes from a bundle, whose code you can't see/.test(inside.stderr), `the fix: ${inside.stderr}`);
      expect(!/str\(\.\.\.\)/.test(inside.stderr), `no fixes for code that is not theirs: ${inside.stderr}`);
      // The subscript on their line is not the one that failed.
      const indexed = await run([
        fixture(
          "indexed.py",
          "#level beginner",
          `#bundle mystery ${base}/mystery.json`,
          "",
          'words = ["", "b"]',
          "print(mystery.initial(words[0]))",
        ),
      ]);
      expect(
        /IndexError: Inside `initial`: A string has no item at that position\./.test(indexed.stderr),
        `a string, not \`words\`: ${indexed.stderr}`,
      );
    }

    console.log("\n[6] a mistake in their own function is theirs, though a bundle's function called it");
    {
      const line = `#bundle mystery ${base}/mystery.json`;
      const returned = await run([
        fixture("returned.py", "#level beginner", line, "", "def shout(s: str) -> str:", "    return len(s)", "", 'print(mystery.apply(shout, "hi"))'),
      ]);
      expect(
        returned.code === 1 &&
          /TypeMismatch: `shout` says it returns a string \(`str`\), but this line returns a whole number \(`int`\)\./.test(
            returned.stderr,
          ) &&
          /at returned\.py:5/.test(returned.stderr),
        `its result, at its return: ${returned.stderr}`,
      );
      expect(
        /Convert the returned value with `str\(\.\.\.\)`/.test(returned.stderr) && !/Inside|from a bundle/.test(returned.stderr),
        `the fixes a direct call gets: ${returned.stderr}`,
      );
      const given = await run([
        fixture("given.py", "#level beginner", line, "", "def shout(n: int) -> str:", "    return str(n)", "", 'print(mystery.apply(shout, "hi"))'),
      ]);
      expect(
        given.code === 1 &&
          /TypeMismatch: `shout` expects `n` to be a whole number \(`int`\), but got a string \(`str`\)\./.test(given.stderr),
        `its parameter: ${given.stderr}`,
      );
      expect(
        /`apply` calls `shout` for you, so `n` is whatever it hands over/.test(given.stderr) && !/Inside/.test(given.stderr),
        `called as a library's function calls it: ${given.stderr}`,
      );
      const arity = await run([
        fixture("arity.py", "#level beginner", line, "", "def shout(s: str, t: str) -> str:", "    return s + t", "", 'print(mystery.apply(shout, "hi"))'),
      ]);
      expect(
        arity.code === 1 && /TypeError: `shout` takes 2 arguments \(`s` and `t`\), but got 1\./.test(arity.stderr),
        `its parameters: ${arity.stderr}`,
      );
      expect(
        /`apply` calls `shout` for you, with 1 value, so give it 1 parameter\./.test(arity.stderr) && !/Inside/.test(arity.stderr),
        `how many it is given: ${arity.stderr}`,
      );
    }

    console.log("\n[7] a bundle that can't be had stops the run, at its line");
    for (const [name, url, said] of [
      ["unreachable.py", "http://127.0.0.1:4/nothing.json", /could not load the bundle `mystery`: could not reach/],
      ["missing.py", `${base}/missing.json`, /could not load the bundle `mystery`: .*returned 404/],
      ["page.py", `${base}/page.json`, /did not return a bundle\./],
      ["wrong-kind.py", `${base}/examplar.json`, /did not return a bundle\./],
      ["old.py", `${base}/old.json`, /built for Python 3\.12\.1, and PLL runs Python 3\.\d+\.\d+: build it again/],
      ["raised.py", `${base}/boom.json`, /its code stopped with NameError: name 'boom' is not defined/],
    ]) {
      const r = await run([fixture(name, "#level beginner", `#bundle mystery ${url}`, "", "print(1)")]);
      expect(r.code === 2, `${name}: exit 2, got ${r.code}`);
      expect(/Line 2: /.test(r.stderr) && said.test(r.stderr), `${name}: ${r.stderr}`);
      expect(/The file was not run\./.test(r.stderr) && r.stdout === "", `${name}: not run`);
    }
    const builtin = await run([fixture("builtin.py", "#level beginner", `#bundle list ${base}/mystery.json`, "", "print(1)")]);
    expect(builtin.code === 2 && /`list` is the name of a Python built-in/.test(builtin.stderr), `a built-in's name: ${builtin.stderr}`);

    console.log("\n[8] Examplar's check gives the student's tests the bundle, as the program has it");
    {
      const r = await run([
        fixture(
          "both.py",
          "#level beginner",
          `#examplar ${base}/examplar.json`,
          `#bundle mystery ${base}/mystery.json`,
          "",
          "def f(n: int) -> int:",
          "    return n * 2 + 1",
          "",
          "def test_f():",
          "    assert f(3) == mystery.twice_plus(3)",
        ),
      ]);
      expect(r.code === 0, `exit 0, got ${r.code}: ${r.stderr}`);
      expect(/Against correct implementations: your test passes\./.test(r.stderr), `on the wheat: ${r.stderr}`);
      expect(/Against buggy implementations: caught all 1\./.test(r.stderr), `on the chaff: ${r.stderr}`);
    }
  } finally {
    server.close();
  }

  console.log("\n[9] without the server, the copy from the last run is used");
  {
    const r = await run([student]);
    expect(r.code === 0 && r.stdout === "11\nPoint(x=2, y=1)\n", `offline: ${r.code} ${JSON.stringify(r.stdout)} ${r.stderr}`);
    expect(/The bundle `mystery`: could not reach .*; using the cached copy/.test(r.stderr), `the note: ${r.stderr}`);
  }

  rmSync(work, { recursive: true, force: true });
  if (!passed()) {
    console.error("\nsmoke-bundle: FAILED");
    process.exit(1);
  }
  console.log("\nsmoke-bundle: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
