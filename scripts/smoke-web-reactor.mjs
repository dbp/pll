#!/usr/bin/env node
/**
 * Reactors in the real workbench: does the card actually animate, and do
 * its controls work?
 *
 * Everything below the webview is covered by `smoke-repl-session` against a
 * fake runtime, but that cannot tell you whether frames reach the screen,
 * whether the clock runs at roughly the tick rate, or whether a key press
 * reaches Python. Only a real extension host and a real webview can.
 *
 *   node scripts/smoke-web-reactor.mjs                       # starts a server
 *   VSCODE_WEB_URL=http://localhost:3000 node scripts/...    # reuse a server
 *   VSCODE_WEB_HEADED=1 node scripts/...                     # watch it
 */
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { openFile } from "./webbench.mjs";
const PORT = process.env.VSCODE_WEB_PORT || "3017";
/**
 * Refuse to start if the port is already taken. `vscode-test-web` prints
 * "Listening on" regardless, so without this a stale server from an earlier
 * run surfaces 90 seconds later as an unexplained `page.goto` timeout.
 */
async function requireFreePort(port) {
  const { createServer } = await import("node:net");
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (err) =>
      reject(
        new Error(
          err.code === "EADDRINUSE"
            ? `port ${port} is already in use - another vscode-test-web is still ` +
              `running. Stop it (or set ${"VSCODE_WEB_PORT"}) and try again.`
            : String(err),
        ),
      ),
    );
    probe.once("listening", () => probe.close(() => resolve()));
    probe.listen(port, "127.0.0.1");
  });
}

function startServer() {
  const c = spawn("npx", ["vscode-test-web", "--browser=none", "--quality=insiders", "--coi",
    "--extensionDevelopmentPath=.", `--port=${PORT}`, "samples"],
    { stdio: ["ignore", "pipe", "pipe"], detached: true });
  return new Promise((res, rej) => {
    const on = (b) => { if (b.toString().includes("Listening on")) res(c); };
    c.stdout.on("data", on); c.stderr.on("data", on);
    setTimeout(() => rej(new Error("no start")), 30000);
  });
}
const panel = (p) => p.frameLocator("iframe.webview").frameLocator("iframe#active-frame");
let ok = true;
const expect = (c, m) => { if (!c) { console.error("  FAIL: " + m); ok = false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `|| null`, not `??`: an empty VSCODE_WEB_URL means "start one".
const REUSE = process.env.VSCODE_WEB_URL || null;
if (!REUSE) await requireFreePort(Number(PORT));
const server = REUSE ? null : await startServer();
const browser = await chromium.launch({
  headless: !process.env.VSCODE_WEB_HEADED,
  args: ["--no-sandbox"],
});
const page = await (await browser.newContext()).newPage();
page.setDefaultTimeout(90_000);
await page.goto(REUSE ?? `http://localhost:${PORT}`, { waitUntil: "domcontentloaded" });
await page.locator(".monaco-workbench").waitFor({ state: "visible" });
await sleep(4000);
await openFile(page, "animation.py");
await page.getByRole("button", { name: "PLL: Run Python File" }).click();

const cards = panel(page).locator(".entry.reactor");
await cards.first().waitFor({ state: "visible", timeout: 150_000 });
await sleep(2500);
console.log("1 reactor cards:", await cards.count());
expect(await cards.count() === 3, `expected 3 cards, got ${await cards.count()}`);

// --- the animate() card should be advancing on its own ---
const anim = cards.nth(0);
const counter = anim.locator(".rxCounter");
const a1 = await counter.innerText();
await sleep(1500);
const a2 = await counter.innerText();
console.log(`2 animating: ${JSON.stringify(a1)} -> ${JSON.stringify(a2)}`);
expect(a1 !== a2, "the frame counter should advance on its own");
expect(/<svg/.test(await anim.locator(".rxStage").innerHTML()), "the stage should hold an svg");

// --- pause stops it ---
await anim.getByTitle("Pause").click();
await sleep(200);
const p1 = await counter.innerText();
await sleep(1200);
expect(p1 === await counter.innerText(), `pause should stop the counter (${p1})`);
console.log(`3 paused at ${JSON.stringify(p1)}`);

// --- rewind with the slider, then play forward again ---
const frameOf = (t) => Number((t.match(/frame (\d+)/) || [])[1]);
const before = frameOf(await counter.innerText());
await anim.locator(".rxScrub").fill(String(Math.max(0, before - 10)));
await sleep(600);
const rewound = frameOf(await counter.innerText());
console.log(`4 rewound: frame ${before} -> ${rewound}`);
expect(rewound < before, "dragging the slider back should show an earlier frame");
await anim.getByTitle("Play").click();
await sleep(1200);
const replayed = frameOf(await counter.innerText());
console.log(`5 played forward again to frame ${replayed}`);
expect(replayed > rewound, "play should advance from the rewound position");
await anim.getByTitle("Pause").click();

// --- single step ---
await sleep(300);
const s1 = frameOf(await counter.innerText());
await anim.getByTitle("One frame forward").click();
await sleep(600);
const s2 = frameOf(await counter.innerText());
console.log(`6 single step: ${s1} -> ${s2}`);
expect(s2 === s1 + 1, `step should advance exactly one frame, got ${s1} -> ${s2}`);

// --- the keyboard reactor ---
const keys = cards.nth(1);
const keyValue = keys.locator(".rxValue");
const k1 = await keyValue.innerText();
await keys.locator(".rxStage").click();
await page.keyboard.press("ArrowRight");
await sleep(700);
const k2 = await keyValue.innerText();
console.log(`7 arrow key: ${k1} -> ${k2}`);
expect(k1 !== k2, "pressing an arrow key should change the state");
expect(/\(172, 70\)/.test(k2), `expected x to move right by 12, got ${k2}`);

// --- the countdown stops itself ---
const down = cards.nth(2).locator(".rxCounter");
await cards.nth(2).locator(".rxCounter").waitFor();
for (let i = 0; i < 40 && !/stopped/.test(await down.innerText()); i++) await sleep(500);
console.log(`8 countdown: ${JSON.stringify(await down.innerText())}`);
expect(/stopped/.test(await down.innerText()), "stop_when should stop the reactor");

// --- simulate_trace printed without any clock ---
const stream = await panel(page).locator("#stream").innerText();
expect(/countdown states: \[10, 9, 8/.test(stream), "simulate_trace should have printed its trace");
console.log("9 simulate_trace output present");

// --- the prompt still works while things animate ---
const input = panel(page).locator("#input");
await input.click();
await input.fill("2 + 2");
await input.press("Enter");
await panel(page).locator("#stream").getByText("4", { exact: true }).first().waitFor({ timeout: 30_000 });
console.log("10 the prompt still works alongside running reactors");

console.log(ok ? "\nsmoke-web-reactor: ok" : "\nsmoke-web-reactor: FAILED");
await browser.close();
if (server?.pid) {
  try { process.kill(-server.pid, "SIGTERM"); } catch { server.kill("SIGTERM"); }
}
process.exit(ok ? 0 : 1);
