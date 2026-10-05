#!/usr/bin/env node
/**
 * Stopping a runaway program in the real workbench, as a student would:
 *   1. Open a file whose loop prints forever
 *   2. PLL: Run Python File
 *   3. The Stop button appears in the interactions panel
 *   4. Click it
 *   5. The program ends with KeyboardInterrupt
 *
 * This is the only test that covers the click itself. The mechanism is
 * proved by `smoke-interrupt`; what this guards against is a loop that
 * prints flooding the extension host with live output faster than it can
 * drain, so that the Stop is never processed - which only shows up with a
 * real webview and a real extension host.
 *
 *   node scripts/smoke-web-stop.mjs                          # starts a server
 *   VSCODE_WEB_URL=http://localhost:3000 node scripts/...    # reuse a server
 *   VSCODE_WEB_HEADED=1 node scripts/...                     # watch it
 */
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { openFile } from "./webbench.mjs";

const PORT = process.env.VSCODE_WEB_PORT ?? "3014";
const URL = process.env.VSCODE_WEB_URL ?? `http://localhost:${PORT}`;
const START_SERVER = !process.env.VSCODE_WEB_URL;
const QUALITY = process.env.VSCODE_WEB_QUALITY ?? "insiders";
const HEADED = !!process.env.VSCODE_WEB_HEADED;
const SAMPLE = "runaway.py";
/**
 * How long a Stop may take to land, measured from the click. Generous: the
 * signal itself is a memory write and the interpreter checks between
 * bytecodes, so anything near this means the extension host is starved.
 */
const STOP_LATENCY_BUDGET_MS = 3000;
/**
 * How long to let output pile up before pressing Stop.
 *
 * Not optional padding: several of the costs here grow with total output
 * rather than with its rate, so clicking Stop immediately passes while the
 * feature is still unusable after a few seconds. A soak is what exposed
 * `_pll_displays` accumulating a multi-million entry list in live mode.
 */
const SOAK_MS = Number(process.env.STOP_SOAK_MS ?? 4000);

function startServer() {
  const child = spawn(
    "npx",
    [
      "vscode-test-web",
      "--browser=none",
      `--quality=${QUALITY}`,
      "--coi",
      "--extensionDevelopmentPath=.",
      `--port=${PORT}`,
      "samples",
    ],
    { stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  return new Promise((resolve, reject) => {
    const onData = (buf) => {
      const text = buf.toString();
      process.stdout.write(text);
      if (text.includes("Listening on")) {
        child.stdout.off("data", onData);
        child.stderr.off("data", onData);
        resolve(child);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) =>
      reject(new Error(`vscode-test-web exited ${code} before listening`)),
    );
    setTimeout(() => reject(new Error("vscode-test-web did not start")), 30_000);
  });
}

/** The interactions view lives in a webview: an outer iframe, then an inner one. */
function panel(page) {
  return page.frameLocator("iframe.webview").frameLocator("iframe#active-frame");
}

async function main() {
  const server = START_SERVER ? await startServer() : null;
  let browser;
  try {
    browser = await chromium.launch({ headless: !HEADED, args: ["--no-sandbox"] });
    const page = await (await browser.newContext()).newPage();
    page.setDefaultTimeout(60_000);

    await page.goto(URL, { waitUntil: "domcontentloaded" });
    await page.locator(".monaco-workbench").waitFor({ state: "visible" });
    // Let activation and the extension host settle before running anything.
    await page.waitForTimeout(4000);
    await openFile(page, SAMPLE);
    await page.locator(".monaco-editor .view-line", { hasText: "while True" }).first().waitFor();
    console.log(`1 opened ${SAMPLE}`);

    await page.getByRole("button", { name: "PLL: Run Python File" }).click();
    console.log("2 clicked PLL: Run Python File (Pyodide boots on first run)");

    // Visible only while a program is running, so this also proves the
    // affordance appears at the right time.
    const stop = panel(page).locator("#stop");
    await stop.waitFor({ state: "visible", timeout: 120_000 });
    console.log("3 Stop button is visible while the loop runs");

    // Wait for the program to be *printing* before starting the clock. The
    // Stop button appears as soon as the session is busy, which on a first
    // run is while Pyodide is still booting - soak from there and the
    // latency below measures the boot, not the click. That is exactly how
    // this failed once: 1 entry node after a 4s soak, and a "3466ms" stop
    // that was really a program which had not started yet.
    await panel(page)
      .locator("#stream")
      .getByText("hello", { exact: false })
      .first()
      .waitFor({ state: "visible", timeout: 120_000 });
    console.log("   program is printing; starting the soak");

    // The whole point: does a click get through while output is pouring in,
    // and *promptly*? "It stops eventually" is the bug, not the fix - a
    // KeyboardInterrupt lands at the next bytecode check, so the only thing
    // that can delay it is the host being too busy to process the click.
    console.log(`   letting output accumulate for ${SOAK_MS}ms first`);
    await page.waitForTimeout(SOAK_MS);
    const nodes = await panel(page)
      .locator("#stream")
      .evaluate((el) => el.childElementCount, undefined, { timeout: 20_000 });
    console.log(`4 panel holds ${nodes} entry nodes after the soak`);
    if (nodes <= 100) {
      throw new Error(
        `the soak should have flooded the panel, got ${nodes} node(s) - the ` +
          "latency below would be measuring something other than a busy host",
      );
    }

    const clickedAt = Date.now();
    await stop.click();
    console.log("5 clicked Stop");

    const stream = panel(page).locator("#stream");
    await stream
      .getByText("KeyboardInterrupt", { exact: false })
      .first()
      .waitFor({ state: "visible", timeout: 60_000 });
    const stoppedAfter = Date.now() - clickedAt;
    console.log(`6 the program stopped with KeyboardInterrupt after ${stoppedAfter}ms`);
    if (stoppedAfter > STOP_LATENCY_BUDGET_MS) {
      throw new Error(
        `Stop took ${stoppedAfter}ms, budget is ${STOP_LATENCY_BUDGET_MS}ms - the host is ` +
          "too busy rendering output to process the click",
      );
    }

    await stop.waitFor({ state: "hidden", timeout: 30_000 });
    console.log("7 Stop disappeared once the program ended");

    const text = await stream.innerText();
    if (!/Output stopped after \d+ lines/.test(text)) {
      throw new Error("expected the output-truncation notice in the panel");
    }
    console.log("8 output was capped with a notice, so the panel stayed usable");

    // Responsive afterwards: the prompt takes a new submission.
    const input = panel(page).locator("#input");
    await input.waitFor({ state: "visible" });
    await input.click();
    await input.fill("1 + 1");
    await input.press("Enter");
    await stream.getByText("2", { exact: true }).first().waitFor({ timeout: 30_000 });
    console.log("9 the prompt still works after stopping");

    console.log("\nsmoke-web-stop: ok");
  } finally {
    await browser?.close();
    if (server?.pid) {
      try {
        process.kill(-server.pid, "SIGTERM");
      } catch {
        server.kill("SIGTERM");
      }
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 2000);
        server.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
