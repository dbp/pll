#!/usr/bin/env node
/**
 * Examplar end to end in the real workbench.
 *
 * `smoke-repl-session` covers the host sequencing against a fake runtime and
 * `smoke-examplar-build` covers authoring against real Pyodide, but neither
 * can show the two halves meeting: a bundle built by the CLI, published over
 * http, fetched by the extension *in a browser*, run against a student's
 * tests, and rendered as a verdict card. Three things only this can check:
 *
 *  - the bytecode a CLI-built bundle carries loads in the extension's
 *    Pyodide, which is the whole claim behind compiling it inside Pyodide;
 *  - the fetch survives the browser's rules. The web extension host is a
 *    browser, so a bundle is a *cross-origin* request: `If-None-Match` is
 *    not CORS-safelisted (so the conditional request is preflighted) and
 *    `ETag` is not an exposed response header by default (so without
 *    `Access-Control-Expose-Headers` nothing is ever cached). The server
 *    here sends what a course server has to send, and the cached badge on
 *    the second run is what proves both;
 *  - the card reaches the screen, with the pytest-rewritten assertion on a
 *    known-correct failure and *only* an id for a missed known-incorrect one.
 *
 *   node scripts/smoke-web-examplar.mjs
 *   VSCODE_WEB_HEADED=1 node scripts/...     # watch it
 *   PLL_SHOTS=/tmp/shots node scripts/...    # save each card as a png
 *
 * The card's job is to be *read*, and the wording of a verdict is not
 * something an assertion can judge - hence `PLL_SHOTS`, for looking at what
 * a change to it actually produced.
 *
 * Requires `pnpm run build`.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { chromium } from "playwright";
import { openFile } from "./webbench.mjs";
import { expect, passed } from "./lib/check.mjs";
import { ROOT } from "./lib/bundle.mjs";

const CLI = resolve(ROOT, "dist-cli", "cli.cjs");
const PORT = process.env.VSCODE_WEB_PORT || "3019";
const BUNDLE_PORT = process.env.PLL_BUNDLE_PORT || "8099";

const SHOTS = process.env.PLL_SHOTS || null;
const panel = (p) => p.frameLocator("iframe.webview").frameLocator("iframe#active-frame");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function requireFreePort(port, what) {
  const { createServer: createNetServer } = await import("node:net");
  await new Promise((resolve_, reject) => {
    const probe = createNetServer();
    probe.once("error", (err) =>
      reject(
        new Error(
          err.code === "EADDRINUSE"
            ? `port ${port} (${what}) is already in use - stop whatever is holding it and try again.`
            : String(err),
        ),
      ),
    );
    probe.once("listening", () => probe.close(() => resolve_()));
    probe.listen(port, "127.0.0.1");
  });
}

/* ---- the bundle a course would publish ------------------------------- */

// Chaffs live in a directory named after the function they break, because
// the student's report is per function. Their ids are filenames, and an id
// is the one thing a student is shown about a chaff they missed - so they
// are numbered rather than named: `no-bang` would hand over the test they
// were meant to write.
const IMPL = {
  "wheats/reference.py": [
    "def shout(word):",
    '    return word.upper() + "!"',
    "",
    "def total(ns):",
    "    return sum(ns)",
  ],
  "wheats/alternative.py": [
    "def shout(word):",
    '    return "".join(c.upper() for c in word) + "!"',
    "",
    "def total(ns):",
    "    running = 0",
    "    for n in ns:",
    "        running = running + n",
    "    return running",
  ],
  "chaffs/shout/1.py": ["def shout(word):", "    return word.upper()", "", "def total(ns):", "    return sum(ns)"],
  "chaffs/total/1.py": ["def shout(word):", '    return word.upper() + "!"', "", "def total(ns):", "    return sum(ns[1:])"],
};

const DIRECTIVE = `#examplar http://localhost:${BUNDLE_PORT}/hw.json`;

// One file per verdict, rather than editing one file in the workbench: each
// gets its own session, so the cards cannot be confused with each other.
const WORK = {
  // A finished suite, plus an implementation of their own, plus a data file
  // to read - so this also shows the workspace coming *back* after the
  // phase unmounted it.
  "good.py": [
    "#level beginner",
    DIRECTIVE,
    "",
    "def shout(word):",
    '    return word.upper() + "!"',
    "",
    "def total(ns):",
    "    return sum(ns)",
    "",
    "def test_shout():",
    '    assert shout("hi") == "HI!"',
    "",
    "def test_total():",
    "    assert total([1, 2, 3]) == 6",
    "",
    'print("data says", open("data.csv").read().strip())',
  ],
  // Tests only, and not enough of them: one chaff goes uncaught and `total`
  // has no test at all. This is the tests-first state the feature exists for.
  "weak.py": [DIRECTIVE, "", "def test_shout():", '    assert shout("hi") == "HI!"'],
  // A test that expects the wrong answer. The lesson is the assertion.
  "wrong.py": [DIRECTIVE, "", "def test_shout():", '    assert shout("hi") == "hi!"'],
  // A test that reads a data file. It cannot run during the phase, because
  // the phase unmounts the workspace - so the card has to say that rather
  // than accuse the test of expecting the wrong answer.
  "reads.py": [
    DIRECTIVE,
    "",
    "def test_shout():",
    '    assert shout("hi") == "HI!"',
    "",
    "def test_total():",
    '    rows = open("data.csv").read().split()',
    "    assert total([len(r) for r in rows]) == 6",
  ],
  "data.csv": ["a,b", "1,2"],
};

/* ---- a correctly configured course server ---------------------------- */

function startBundleServer(port, body) {
  const etag = '"v1"';
  const seen = [];
  const preflights = [];
  // Exactly the headers a course server must send for the web build. Each
  // one is load-bearing, and the comments say what breaks without it.
  const cors = {
    "Access-Control-Allow-Origin": "*",
    // Without this the *conditional* request fails its preflight, so every
    // student stays pinned to whatever they cached first.
    "Access-Control-Allow-Headers": "If-None-Match",
    // Without this `response.headers.get("etag")` reads null in a browser,
    // so no etag is stored and nothing is ever revalidated.
    "Access-Control-Expose-Headers": "ETag",
    // vscode-test-web runs cross-origin isolated (--coi).
    "Cross-Origin-Resource-Policy": "cross-origin",
  };
  const server = createServer((req, res) => {
    if (req.method === "OPTIONS") {
      preflights.push(req.headers["access-control-request-headers"] ?? "");
      res.writeHead(204, cors);
      res.end();
      return;
    }
    seen.push({ url: req.url, ifNoneMatch: req.headers["if-none-match"] ?? null });
    if (req.url !== "/hw.json") {
      res.writeHead(404, cors);
      res.end("no such bundle");
      return;
    }
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ...cors, ETag: etag });
      res.end();
      return;
    }
    res.writeHead(200, { ...cors, "Content-Type": "application/json", ETag: etag });
    res.end(body);
  });
  return new Promise((res) => server.listen(port, "127.0.0.1", () => res({ server, seen, preflights })));
}

/* ---- run --------------------------------------------------------------- */

if (!existsSync(CLI)) {
  console.error(`Missing ${CLI}. Run \`pnpm run build\` first.`);
  process.exit(1);
}
await requireFreePort(Number(BUNDLE_PORT), "bundle server");
await requireFreePort(Number(PORT), "vscode-test-web");

const tmp = mkdtempSync(join(tmpdir(), "pll-web-examplar-"));
const work = join(tmp, "work");
const write = (base, rel, lines) => {
  const file = join(base, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
};
for (const [rel, lines] of Object.entries(IMPL)) write(join(tmp, "impl"), rel, lines);
for (const [rel, lines] of Object.entries(WORK)) write(work, rel, lines);

// 1. Build the bundle with the tool course staff would use. Doing it here
//    rather than checking a fixture in is the point: the bytecode has to be
//    produced by the Pyodide this repo pins, and a fixture would rot the
//    next time that moves.
const built = await new Promise((res, rej) => {
  const child = spawn(
    process.execPath,
    [CLI, "--no-color", "examplar", "build", join(tmp, "impl"), "-o", join(tmp, "hw.json")],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let err = "";
  child.stderr.on("data", (b) => (err += b.toString()));
  child.on("error", rej);
  child.on("close", (code) => res({ code, err }));
});
if (built.code !== 0) {
  console.error(`pll examplar build failed (${built.code}):\n${built.err}`);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}
const bundleJson = readFileSync(join(tmp, "hw.json"), "utf8");
const meta = JSON.parse(bundleJson);
console.log(
  `1 built a bundle: python ${meta.built.python}, magic ${meta.built.magic}, ` +
    `${meta.wheats.length} wheat(s), ${meta.chaffs.length} chaff(s)`,
);

const bundleSrv = await startBundleServer(Number(BUNDLE_PORT), bundleJson);
console.log(`2 serving it at http://localhost:${BUNDLE_PORT}/hw.json`);

const web = spawn("npx", ["vscode-test-web", "--browser=none", "--quality=insiders", "--coi",
  "--extensionDevelopmentPath=.", `--port=${PORT}`, work],
  { stdio: ["ignore", "pipe", "pipe"], detached: true });
await new Promise((res, rej) => {
  const on = (b) => { if (b.toString().includes("Listening on")) res(); };
  web.stdout.on("data", on); web.stderr.on("data", on);
  setTimeout(() => rej(new Error("no web server")), 30000);
});

const browser = await chromium.launch({
  headless: !process.env.VSCODE_WEB_HEADED,
  args: ["--no-sandbox"],
});
const page = await (await browser.newContext()).newPage();
page.setDefaultTimeout(90_000);
await page.goto(`http://localhost:${PORT}`, { waitUntil: "domcontentloaded" });
await page.locator(".monaco-workbench").waitFor({ state: "visible" });
await sleep(4000);

/**
 * Open a file, run it, and wait for its cards.
 *
 * One card per provided function, so each assertion below can name the
 * function it is about instead of pattern-matching one wall of text.
 */
async function runAndCards(name, timeout = 150_000) {
  await openFile(page, name);
  await sleep(300);
  await page.getByRole("button", { name: "PLL: Run Python File" }).click();
  const all = panel(page).locator(".entry.examplar.ex-function");
  await all.last().waitFor({ state: "visible", timeout });
  // The lines are appended in one batch, but the trailing notes land with
  // the same paint - give the cards a beat to be whole before reading them.
  await sleep(800);
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    const file = join(SHOTS, `${name.replace(/\.py$/, "")}.png`);
    await panel(page).locator("#stream").screenshot({ path: file });
    console.log(`    [shot] ${file}`);
  }
  return {
    /** The card for one function, from this run. */
    card: (fn) =>
      panel(page)
        .locator(`.entry.examplar.ex-function:has(.exTitle:text-is("${fn}"))`)
        .last(),
    async text(fn) {
      return (
        await panel(page)
          .locator(`.entry.examplar.ex-function:has(.exTitle:text-is("${fn}"))`)
          .last()
          .innerText()
      );
    },
  };
}

// 3. A finished suite. This is also the only place the bytecode from the
//    CLI is proven to load in the extension's interpreter.
{
  const cards = await runAndCards("good.py");
  const shout = await cards.text("shout");
  const total = await cards.text("total");
  console.log("3 good.py:\n" + [shout, total].join("\n").split("\n").map((l) => "    " + l).join("\n"));
  // A card per function, headed by the function, because that is the unit
  // the student is working in.
  expect((await cards.card("shout").locator(".exSource").innerText()) === "Examplar",
    "with the feature name alongside");
  for (const [fn, text] of [["shout", shout], ["total", total]]) {
    expect(/Against correct implementations: your test passes\./.test(text),
      `${fn}: expected phase one to pass, got ${JSON.stringify(text)}`);
    expect(/Against buggy implementations: caught all 1\./.test(text),
      `${fn}: expected full coverage, got ${JSON.stringify(text)}`);
  }
  // The provenance is a tooltip, not a badge: a 304 means the bundle is
  // current rather than stale, so it is not worth a line of its own.
  expect((await cards.card("shout").locator(".exSource").getAttribute("title")) ===
    `http://localhost:${BUNDLE_PORT}/hw.json`, "the first run is a fresh fetch");

  // The phase unmounted the workspace; the program still read its data file,
  // so it came back.
  const stream = panel(page).locator("#stream");
  await stream.getByText(/data says a,b/).first().waitFor({ timeout: 60_000 });
  console.log("4 the workspace came back after the phase: data.csv was read");
}

// 5. The second run revalidates and is served from cache. This is the
//    assertion that the CORS headers above are all doing their job.
{
  await page.getByRole("button", { name: "PLL: Run Python File" }).click();
  const seen = panel(page).locator('.entry.examplar.ex-function:has(.exTitle:text-is("shout"))');
  for (let i = 0; i < 100 && (await seen.count()) < 2; i++) await sleep(500);
  const tip = await seen.last().locator(".exSource").getAttribute("title");
  console.log(`5 second run provenance: ${JSON.stringify(tip)}`);
  expect(/\(cached copy\)$/.test(tip ?? ""), `expected the cached tooltip, got ${tip}`);
  const conditional = bundleSrv.seen.filter((r) => r.ifNoneMatch === '"v1"');
  expect(conditional.length >= 1,
    `expected a conditional request, saw ${JSON.stringify(bundleSrv.seen)}`);
  expect(bundleSrv.preflights.some((h) => /if-none-match/i.test(h)),
    `expected a preflight for If-None-Match, saw ${JSON.stringify(bundleSrv.preflights)}`);
  console.log(
    `    preflight asked for ${bundleSrv.preflights.join(", ")}; ` +
      `${conditional.length} conditional request(s) -> 304`,
  );
}

// 6. Tests-first, with a gap - and a function not started at all. This is
//    the case the per-function split exists for: a global count with a
//    "but you have no tests for total" footnote was a card arguing with
//    itself.
{
  const cards = await runAndCards("weak.py");
  const shout = await cards.text("shout");
  const total = await cards.text("total");
  console.log("6 weak.py:\n" + [shout, total].join("\n").split("\n").map((l) => "    " + l).join("\n"));
  expect(/Against correct implementations: your test passes\./.test(shout),
    `the one test they wrote is right, got ${JSON.stringify(shout)}`);
  expect(/Against buggy implementations: caught all 1\./.test(shout),
    `and it catches shout's chaff, got ${JSON.stringify(shout)}`);
  // Not "caught 0 of 1", which would read as failing at something they have
  // not started.
  expect(total.split("\n").includes("No tests yet."),
    `a function with no tests says just that, got ${JSON.stringify(total)}`);
  expect(!/caught|Against/i.test(total), `and nothing else, got ${JSON.stringify(total)}`);
  // Nothing about *why* a chaff is wrong may appear.
  expect(!/assert/.test(shout + total), "no assertion may leak from a chaff");
  expect(!/sum|ns\[/.test(shout + total), "nor any of its code");

  // They have written no implementation, so their own tests are not run
  // against it - and nothing complains about that, because at this point
  // having none is the normal state.
  const stream = await panel(page).locator("#stream").innerText();
  expect(!/NameError/.test(stream), `no NameError noise, got ${JSON.stringify(stream)}`);
  console.log("7 no implementation of their own, and no complaint about it");
}

// 8. A test that expects the wrong answer.
{
  const cards = await runAndCards("wrong.py");
  const shout = await cards.text("shout");
  console.log("8 wrong.py:\n" + shout.split("\n").map((l) => "    " + l).join("\n"));
  expect(/Against correct implementations: your test expects the wrong answer:/.test(shout),
    `expected the disagreement line, got ${JSON.stringify(shout)}`);
  expect((await cards.card("shout").locator(".exFailure code").innerText()) === "test_shout",
    "the failing test should be named");
  // And *only* named. This test asserts `shout("hi") == "hi!"`, so the
  // rewritten assertion would read `assert 'HI!' == 'hi!'` - which states
  // the correct answer. A student could read the whole specification off
  // this card, one deliberately-wrong test at a time.
  expect(await cards.card("shout").locator(".exFailure pre").count() === 0,
    "no assertion may be rendered beside it");
  expect(!/HI!|assert/.test(shout), `nothing about the answer, got ${JSON.stringify(shout)}`);
  // Phase two waits for phase one, for this function.
  expect(!/caught/i.test(shout), `no coverage number belongs here, got ${JSON.stringify(shout)}`);
  expect(/Against buggy implementations: waiting until all your tests of shout pass\./.test(shout),
    `expected the phase-two note, got ${JSON.stringify(shout)}`);
  console.log("9 the wrong test is named, the answer is not, and coverage is withheld");
}

// 10. A test that opens a data file. The phase runs with the workspace
//     unmounted, so it cannot run - a different thing from being wrong,
//     which is the distinction the card has to keep. And it must hold up
//     only *its own* function.
{
  const cards = await runAndCards("reads.py");
  const shout = await cards.text("shout");
  const total = await cards.text("total");
  console.log("10 reads.py:\n" + [shout, total].join("\n").split("\n").map((l) => "    " + l).join("\n"));
  expect(/Against correct implementations: your test could not run here:/.test(total),
    `expected the could-not-run line, got ${JSON.stringify(total)}`);
  expect(!/expect.* the wrong answer/.test(total),
    "a test that raised must not be called wrong");
  expect(/FileNotFoundError/.test(await cards.card("total").locator(".exFailureWarn pre").innerText()),
    "with the error it raised");
  expect(/files next to your program are not available/.test(total),
    `expected the explanation, got ${JSON.stringify(total)}`);
  // An error is not a pass, so phase two waits for it exactly as it waits
  // for a disagreement.
  expect(/Against buggy implementations: waiting until all your tests of total pass\./.test(total),
    `coverage must wait, got ${JSON.stringify(total)}`);
  // But only for *that* function. This is what the per-function split buys:
  // a broken test of `total` does not withhold `shout`'s coverage.
  expect(/Against buggy implementations: caught all 1\./.test(shout),
    `shout must be scored regardless, got ${JSON.stringify(shout)}`);
  console.log("11 it holds up its own function's coverage, and only its own");
}

console.log(passed() ? "\nsmoke-web-examplar: ok" : "\nsmoke-web-examplar: FAILED");
await browser.close();
await new Promise((res) => bundleSrv.server.close(res));
try { process.kill(-web.pid, "SIGTERM"); } catch { web.kill("SIGTERM"); }
rmSync(tmp, { recursive: true, force: true });
process.exit(passed() ? 0 : 1);
