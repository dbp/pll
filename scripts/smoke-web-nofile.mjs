#!/usr/bin/env node
/**
 * Prompt lines with no folder open, as on vscode.dev before a student has a
 * repository: there is no file to open, so the panel's session with no file
 * is all there is.
 *
 *   node scripts/smoke-web-nofile.mjs
 *   VSCODE_WEB_HEADED=1 node scripts/...     # watch it
 */
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { expect, fail, passed } from "./lib/check.mjs";

const PORT = process.env.VSCODE_WEB_PORT || "3021";

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

await requireFreePort(Number(PORT), "vscode-test-web");

// No folder argument: the workbench opens with nothing in it.
const web = spawn(
  "npx",
  ["vscode-test-web", "--browser=none", "--quality=insiders", "--coi",
    "--extensionDevelopmentPath=.", `--port=${PORT}`],
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
  try { process.kill(-web.pid, "SIGTERM"); } catch { web.kill("SIGTERM"); }
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

  /** Type a line at the prompt, and wait for `until` to appear in the panel. */
  async function prompt(line, until) {
    const input = panel(page).locator("#input");
    await input.click();
    await input.fill(line);
    await input.press("Enter");
    const stream = panel(page).locator("#stream");
    await stream.getByText(until).first().waitFor({ timeout: 150_000 });
    return stream.innerText();
  }

  console.log("\n[1] PLL: Start REPL with no folder open");
  {
    await page.keyboard.press("Control+Shift+E");
    const noFolder = page.getByText("You have not yet opened a folder").first();
    await noFolder.waitFor({ timeout: 30_000 }).catch(() => undefined);
    expect(await noFolder.isVisible(), "the workbench has no folder open");
    await page.keyboard.press("F1");
    await page.keyboard.type("PLL: Start REPL");
    await sleep(500);
    await page.keyboard.press("Enter");
    const title = panel(page).locator("#title");
    await title.getByText("No file [beginner]").waitFor({ timeout: 60_000 });
    expect((await title.innerText()) === "No file [beginner]", `the session with no file: ${await title.innerText()}`);
  }

  console.log("\n[2] prompt lines run, at beginner");
  {
    await prompt("x = 6 * 7", "x = 6 * 7");
    const shown = await prompt("x", /^42$/);
    expect(/^42$/m.test(shown), `a prompt line's value: ${shown.slice(-200)}`);
    await prompt("def f(n: int) -> int:\n    return n\n", "return n");
    const strict = await prompt("f(True)", /not accepted as numbers/);
    expect(/not accepted as numbers/.test(strict), `beginner's rules: ${strict.slice(-300)}`);
    if (passed()) console.log("    42, and True refused for an int");
  }
} catch (err) {
  console.error(err);
  fail(String(err));
}

console.log(passed() ? "\nsmoke-web-nofile: ok" : "\nsmoke-web-nofile: FAILED");
await shutDown();
process.exit(passed() ? 0 : 1);
