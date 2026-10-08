#!/usr/bin/env node
/**
 * `load_table` and `load_image` in the real workbench, from files and from
 * a URL.
 *
 * Both work on the command line, and `smoke-tables` / `smoke-images` cover
 * the Python under Node - but two of the four paths only exist in a
 * browser, and neither was exercised by any of that:
 *
 *  - A **local picture** reaches Pyodide through the editor's own collector
 *    (`workspaceFiles.ts`, over `vscode.workspace.fs`), which is a
 *    different code path from the CLI's `cli/files.ts`. Both had to learn
 *    to carry bytes instead of decoding them as text.
 *  - A **URL** is fetched with synchronous `XMLHttpRequest`, and the real
 *    one decodes with `x-user-defined`, remapping every byte above 0x7f to
 *    U+F780-U+F7FF for `_pll_fetch_bytes` to mask back. The desktop
 *    polyfill *ignores* that request and returns one character per byte, so
 *    the mask is a no-op there: every command-line test passed without the
 *    mapping ever running. A PNG's first byte is 0x89, squarely inside the
 *    remapped range.
 *
 * So the checks here are about bytes surviving, not just about sizes
 * looking plausible.
 *
 *   node scripts/smoke-web-load.mjs
 *   VSCODE_WEB_HEADED=1 node scripts/...     # watch it
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { openFile } from "./webbench.mjs";
import { expect, fail, passed } from "./lib/check.mjs";
import { ROOT } from "./lib/bundle.mjs";

const PORT = process.env.VSCODE_WEB_PORT || "3020";
const DATA_PORT = process.env.PLL_DATA_PORT || "8234";

const panel = (p) => p.frameLocator("iframe.webview").frameLocator("iframe#active-frame");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function requireFreePort(port, what) {
  const { createServer: net } = await import("node:net");
  await new Promise((resolve_, reject) => {
    const probe = net();
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

/**
 * Report a picture's real bytes, by pulling the data URI back out of the
 * SVG. Sizes alone only prove the header arrived; this proves all of it did.
 */
const REPORT_BYTES = [
  "import base64",
  "def report(label, pic):",
  "    svg = pic.to_svg()",
  "    blob = svg.split('base64,')[1].split('\"')[0]",
  "    raw = base64.b64decode(blob)",
  "    print(label, image_width(pic), image_height(pic), len(raw), raw[:8] == b'\\x89PNG\\r\\n\\x1a\\n')",
  "",
].join("\n");

await requireFreePort(Number(DATA_PORT), "data server");
await requireFreePort(Number(PORT), "vscode-test-web");

const png = readFileSync(resolve(ROOT, "media/icon.png"));
const CSV = 'city,temp\nBoston,51\n"Providence, RI",52\n';

const work = mkdtempSync(join(tmpdir(), "pll-web-load-"));
copyFileSync(resolve(ROOT, "media/icon.png"), join(work, "cat.png"));
writeFileSync(join(work, "badge.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"/>');
writeFileSync(join(work, "cars.csv"), CSV);
writeFileSync(
  join(work, "local.py"),
  [
    REPORT_BYTES,
    'report("png", load_image("cat.png"))',
    'badge = load_image("badge.svg")',
    'print("svg", image_width(badge), image_height(badge))',
    'print("composed", image_width(beside(scale(0.05, load_image("cat.png")), badge)))',
    't = load_table("cars.csv")',
    'print("csv", t.columns(), t.row(1))',
    "try:",
    '    load_image("absent.png")',
    "except FileNotFoundError as e:",
    '    print("missing", "no file called" in str(e))',
    "",
  ].join("\n"),
);
writeFileSync(join(work, "exits.py"), 'import os\nprint("before", 1)\nos._exit(0)\nprint("after", 1)\n');
writeFileSync(join(work, "fatal.py"), "import faulthandler\nfaulthandler._sigabrt()\n");
writeFileSync(join(work, "again.py"), 'print("again", 1 + 1)\n');
// Its own file: one that already ran still shows that output, which a wait
// for the new run's line would find before the new run has started.
writeFileSync(join(work, "renewed.py"), 'print("renewed", 2 + 2)\n');
writeFileSync(
  join(work, "remote.py"),
  [
    REPORT_BYTES,
    `report("png", load_image("http://127.0.0.1:${DATA_PORT}/cat.png"))`,
    `t = load_table("http://127.0.0.1:${DATA_PORT}/w.csv")`,
    'print("csv", t.columns(), t.row(1))',
    "",
  ].join("\n"),
);

// Only `Allow-Origin` and `Resource-Policy` are needed: these are plain GETs
// with no custom request header, so nothing is preflighted and no response
// header has to be exposed. (An Examplar bundle differs - it sends
// `If-None-Match` and reads `ETag`.)
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Cross-Origin-Resource-Policy": "cross-origin",
};
const data = createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (req.url === "/cat.png") {
    res.writeHead(200, { ...cors, "Content-Type": "image/png" });
    res.end(png);
    return;
  }
  res.writeHead(200, { ...cors, "Content-Type": "text/csv" });
  res.end(CSV);
});
await new Promise((r) => data.listen(Number(DATA_PORT), "127.0.0.1", r));

const web = spawn(
  "npx",
  ["vscode-test-web", "--browser=none", "--quality=insiders", "--coi",
    "--extensionDevelopmentPath=.", `--port=${PORT}`, work],
  { stdio: ["ignore", "pipe", "pipe"], detached: true },
);
await new Promise((res, rej) => {
  const on = (b) => { if (b.toString().includes("Listening on")) res(); };
  web.stdout.on("data", on); web.stderr.on("data", on);
  setTimeout(() => rej(new Error("no web server")), 30000);
});

let browser = null;
// Always: a failure that leaves the workbench running makes the *next* run
// die on a port check instead of reporting what actually broke.
async function shutDown() {
  try { await browser?.close(); } catch { /* already gone */ }
  await new Promise((r) => data.close(r));
  try { process.kill(-web.pid, "SIGTERM"); } catch { web.kill("SIGTERM"); }
  rmSync(work, { recursive: true, force: true });
}
process.on("exit", () => {
  try { process.kill(-web.pid, "SIGKILL"); } catch { /* already gone */ }
});

browser = await chromium.launch({
  headless: !process.env.VSCODE_WEB_HEADED,
  args: ["--no-sandbox"],
});

try {
  const page = await (await browser.newContext()).newPage();
  page.setDefaultTimeout(90_000);
  await page.goto(`http://localhost:${PORT}`, { waitUntil: "domcontentloaded" });
  await page.locator(".monaco-workbench").waitFor({ state: "visible" });
  await sleep(4000);

  /**
   * Run a file and return the lines it printed, keyed by first word.
   *
   * Races the line we are waiting for against anything that looks like a
   * failure. Without that, a run that raises never prints the awaited line
   * and the test spends 150 seconds timing out on a locator - which says
   * nothing about what went wrong. Losing the bytes makes `load_image`
   * raise, so that is exactly how this fails when it fails.
   */
  async function runFile(name, until) {
    await openFile(page, name);
    await page.getByRole("button", { name: "PLL: Run Python File" }).click();
    const stream = panel(page).locator("#stream");
    await Promise.race([
      stream.getByText(until).first().waitFor({ timeout: 150_000 }),
      stream
        .getByText(/Error|Traceback|not a picture|could not/i)
        .first()
        .waitFor({ timeout: 150_000 }),
    ]);
    await sleep(800);
    const text = await stream.innerText();
    const out = { __all__: text };
    for (const line of text.split("\n")) {
      const [head, ...rest] = line.trim().split(" ");
      if (head) out[head] = rest.join(" ");
    }
    return out;
  }

  console.log("\n[1] files beside the program");
  {
    const got = await runFile("local.py", /^missing/);
    // width height bytes signature-ok
    expect(got.png === `512 512 ${png.byteLength} True`,
      `a local png must arrive byte for byte. Panel said:\n${got.__all__}`);
    expect(got.svg === "40 30", `an svg is read from its attributes: ${got.svg}`);
    expect(got.composed === "66", `it composes like any other picture: ${got.composed}`);
    // Every cell is text, as Pyret's `load-table` gives it, and the quoted
    // comma has to survive.
    expect(got.csv === "['city', 'temp'] {'city': 'Providence, RI', 'temp': '52'}",
      `csv columns: ${got.csv}`);
    expect(got.missing === "True", `a missing file says so plainly: ${got.missing}`);
    if (passed()) console.log(`    png ${png.byteLength} bytes intact, svg sized, csv as text`);
  }

  console.log("\n[2] the same two over http, where a browser decodes the bytes");
  {
    const got = await runFile("remote.py", /^csv/);
    // The assertion this file exists for: a browser hands back
    // `x-user-defined` text, and 0x89 is in the range that remaps.
    expect(got.png === `512 512 ${png.byteLength} True`,
      `a fetched png must survive the browser's decoding. Panel said:\n${got.__all__}`);
    expect(got.csv === "['city', 'temp'] {'city': 'Providence, RI', 'temp': '52'}",
      `csv over http: ${got.csv}`);
    if (passed()) console.log(`    png ${png.byteLength} bytes intact over http, csv parsed`);
  }

  console.log("\n[3] os._exit ends the program, and Python carries on");
  {
    const exited = await runFile("exits.py", /^before/);
    expect(exited.before === "1" && exited.after === undefined, `it ends there: ${exited.__all__}`);
    const again = await runFile("again.py", /^again/);
    expect(again.again === "2", `the next file runs: ${again.__all__}`);
    if (passed()) console.log("    ended at os._exit; the next file ran");
  }

  console.log("\n[4] a Python that can no longer run is replaced, and every file says so");
  {
    const fatal = await runFile("fatal.py", /Python stopped completely/);
    expect(!/Internal error/.test(fatal.__all__), `said plainly: ${fatal.__all__}`);
    // A file that ran before is told too, or its next prompt line would
    // fail with a NameError and no reason.
    await openFile(page, "local.py");
    await sleep(800);
    const other = await panel(page).locator("#stream").innerText();
    expect(/Python stopped completely/.test(other), `local.py is told: ${other.slice(-300)}`);
    const renewed = await runFile("renewed.py", /^renewed/);
    expect(renewed.renewed === "4", `a new Python runs the next file: ${renewed.__all__}`);
    if (passed()) console.log("    replaced; local.py told; the next file ran");
  }
} catch (err) {
  console.error(err);
  fail(String(err));
}

console.log(passed() ? "\nsmoke-web-load: ok" : "\nsmoke-web-load: FAILED");
await shutDown();
process.exit(passed() ? 0 : 1);
