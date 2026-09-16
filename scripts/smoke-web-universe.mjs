#!/usr/bin/env node
/**
 * A world talking to a universe server, end to end in the real workbench.
 *
 * `smoke-universe` covers the client against a real socket, and
 * `smoke-repl-session` covers the driver against fakes, but only this can
 * show that `register=` in a student's file actually opens a connection
 * from the running extension, that `package(...)` reaches the server, and
 * that what the server sends back arrives at `on_receive`.
 *
 * Starts the reference server from `samples/universe_server.mjs`, so it is
 * also a check that the server we hand out works with the client we ship.
 *
 *   node scripts/smoke-web-universe.mjs
 *   VSCODE_WEB_HEADED=1 node scripts/...     # watch it
 */
import { spawn } from "node:child_process";
import { chromium } from "playwright";
const PORT = process.env.VSCODE_WEB_PORT || "3018";
// The sample registers with ws://localhost:8080, so the test has to use
// that port too - it is checking the sample as written.
const WS_PORT = "8080";
const panel = (p) => p.frameLocator("iframe.webview").frameLocator("iframe#active-frame");
let ok = true;
const expect = (c, m) => { if (!c) { console.error("  FAIL: " + m); ok = false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. The reference server students would be given.
const srvLog = [];
const universe = spawn("node", ["samples/universe_server.mjs"], {
  env: { ...process.env, PORT: WS_PORT }, stdio: ["ignore", "pipe", "pipe"], detached: true,
});
universe.stdout.on("data", (b) => srvLog.push(b.toString()));
universe.stderr.on("data", (b) => srvLog.push(b.toString()));
await sleep(1200);
console.log("1 server:", srvLog.join("").trim().split("\n")[0]);

const web = spawn("npx", ["vscode-test-web", "--browser=none", "--quality=insiders", "--coi",
  "--extensionDevelopmentPath=.", `--port=${PORT}`, "samples"],
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
await page.locator(".monaco-list-row", { hasText: "universe.py" }).first().waitFor({ state: "visible" });
await sleep(4000);
await page.locator(".monaco-list-row", { hasText: "universe.py" }).first().dblclick();
await sleep(1200);

await page.getByRole("button", { name: "PLL: Run Python File" }).click();

const card = panel(page).locator(".entry.reactor").first();
await card.waitFor({ state: "visible", timeout: 150_000 });
const link = card.locator(".rxLink");
for (let i = 0; i < 40 && (await link.innerText()) !== "connected"; i++) await sleep(500);
console.log("2 connection badge:", JSON.stringify(await link.innerText()));
expect((await link.innerText()) === "connected", "the world should report connected");
expect(/world-1 connected/.test(srvLog.join("")), "the server should have logged the world");

// 3. Outbound: an arrow key -> package(...) -> socket -> server.
await card.locator(".rxStage").click();
await page.keyboard.press("ArrowRight");
for (let i = 0; i < 20 && !/"at"/.test(srvLog.join("")); i++) await sleep(300);
const sentLine = srvLog.join("").split("\n").find((l) => /"at"/.test(l)) || "";
console.log("3 server received:", sentLine.trim());
expect(/"at":\s*\[174/.test(sentLine), `expected the moved position, got ${sentLine}`);

// 4. Inbound: another world's message -> relay -> on_receive -> state.
const other = new WebSocket(`ws://127.0.0.1:${WS_PORT}/`);
await new Promise((res) => other.addEventListener("open", res));
other.send(JSON.stringify({ at: [40, 120] }));
const value = card.locator(".rxValue");
for (let i = 0; i < 30 && !/40, 120/.test(await value.innerText()); i++) await sleep(300);
console.log("4 world state:", (await value.innerText()).slice(0, 90));
expect(/40, 120/.test(await value.innerText()), "on_receive should record the other world");

console.log(ok ? "\nsmoke-web-universe: ok" : "\nsmoke-web-universe: FAILED");
other.close();
await browser.close();
for (const p of [web, universe]) {
  try { process.kill(-p.pid, "SIGTERM"); } catch { p.kill("SIGTERM"); }
}
process.exit(ok ? 0 : 1);
