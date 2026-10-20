#!/usr/bin/env node
/**
 * The `#level` line in the editor, on vscode-web, as a student meets it: the
 * keys and clicks of `src/editor/levelLine.ts`, through Chromium's input
 * pipeline, in the editor VS Code ships.
 *
 *   1. Select All, then Delete, Paste or Cut: the line stays, and one undo
 *      brings everything back
 *   2. Typing into the line, Backspace in it, and deleting it: the line
 *      stays, and what was typed lands on the line below
 *   3. A program pasted in with its own `#level` line brings it
 *   4. The CodeLens above the line opens the picker, which changes the level
 *      and removes the line; then nothing is held
 *   5. The status-bar item gives a file with no line one
 *
 *   node scripts/smoke-web-level.mjs                      # insiders
 *   VSCODE_WEB_QUALITY=stable node scripts/...            # what vscode.dev ships
 *   VSCODE_WEB_COMMIT=<hash> node scripts/...             # a build already downloaded
 *   VSCODE_WEB_URL=http://localhost:3000 node scripts/... # reuse a server
 */
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { expect, passed } from "./lib/check.mjs";

const PORT = process.env.VSCODE_WEB_PORT ?? "3014";
const URL = process.env.VSCODE_WEB_URL ?? `http://localhost:${PORT}`;
const START_SERVER = !process.env.VSCODE_WEB_URL;
const QUALITY = process.env.VSCODE_WEB_QUALITY ?? "insiders";
const COMMIT = process.env.VSCODE_WEB_COMMIT;
const HEADED = !!process.env.VSCODE_WEB_HEADED;
const HEADER = "#level beginner";

function startServer() {
  const child = spawn(
    "npx",
    [
      "vscode-test-web",
      "--browser=none",
      `--quality=${QUALITY}`,
      ...(COMMIT ? [`--commit=${COMMIT}`] : []),
      "--coi",
      "--permission=clipboard-read",
      "--permission=clipboard-write",
      "--extensionDevelopmentPath=.",
      `--port=${PORT}`,
      "samples",
    ],
    { stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  return new Promise((resolve, reject) => {
    const onData = (buf) => {
      if (buf.toString().includes("Listening on")) {
        child.stdout.off("data", onData);
        child.stderr.off("data", onData);
        resolve(child);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => reject(new Error(`vscode-test-web exited ${code} before listening`)));
    setTimeout(() => reject(new Error("vscode-test-web did not start")), 60_000);
  });
}

async function editorText(page) {
  return page.evaluate(() => {
    const lines = [...document.querySelectorAll(".monaco-editor .view-lines .view-line")];
    // Rendered top to bottom by position, not by DOM order.
    lines.sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top));
    return lines.map((el) => (el.textContent ?? "").replace(/ /g, " ")).join("\n");
  });
}

/** The editor's text once `want` holds of it, or the last seen. */
async function textWhen(page, want, timeout = 5000) {
  const until = Date.now() + timeout;
  let text = await editorText(page);
  while (!want(text) && Date.now() < until) {
    await page.waitForTimeout(100);
    text = await editorText(page);
  }
  return text;
}

async function statusBar(page) {
  return (await page.locator(".statusbar").textContent())?.replace(/\s+/g, " ") ?? "";
}

async function lens(page) {
  const found = page.locator(".codelens-decoration a");
  return (await found.count()) > 0 ? ((await found.first().textContent()) ?? "").trim() : "";
}

async function open(page, name, firstLine) {
  await page.locator(".monaco-list-row", { hasText: name }).first().dblclick();
  await page.locator(".monaco-editor .view-line", { hasText: firstLine }).first().waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForTimeout(1500);
}

/** Select All, as a student does it: the next key comes after a moment. */
async function selectAll(page) {
  await page.keyboard.press("Control+a");
  await page.waitForTimeout(250);
}

async function pickInPicker(page, label) {
  const picker = page.locator(".quick-input-widget");
  await picker.waitFor({ state: "visible" });
  await page.locator(".quick-input-widget .monaco-list-row", { hasText: label }).first().click();
  await picker.waitFor({ state: "hidden" });
}

async function main() {
  const server = START_SERVER ? await startServer() : null;
  let browser;
  try {
    browser = await chromium.launch({ headless: !HEADED, args: ["--no-sandbox"] });
    const context = await browser.newContext();
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const page = await context.newPage();
    // What the editor says of PLL's edits: one that starts and ends inside
    // lines it can tokenize wrongly, which is why they replace whole lines.
    const tokenizer = [];
    page.on("console", (message) => {
      if (message.text().includes("Token length and text length do not match")) {
        tokenizer.push(message.text().split("\n")[0]);
      }
    });
    page.setDefaultTimeout(45_000);
    await page.goto(URL, { waitUntil: "domcontentloaded" });
    await page.locator(".monaco-workbench").waitFor({ state: "visible" });
    await page.locator(".monaco-list-row", { hasText: "beginner_ok.py" }).first().waitFor({ state: "visible" });
    // Let activation and the extension host settle before opening a file.
    await page.waitForTimeout(4000);

    console.log("\n[1] Select All, then Delete, Paste or Cut");
    await open(page, "beginner_ok.py", HEADER);
    const original = await editorText(page);
    expect(original.startsWith(HEADER + "\n"), `beginner_ok.py opened: ${JSON.stringify(original)}`);
    expect((await lens(page)).includes("Level: beginner · change"), `the CodeLens: ${JSON.stringify(await lens(page))}`);
    expect((await statusBar(page)).includes("PLL: beginner"), "the status bar's level");
    await page.locator(".monaco-editor .view-line", { hasText: "answer" }).first().click();
    for (const [what, key, clipboard] of [["Delete", "Delete"], ["Paste", "Control+v", "print(9)\n"], ["Cut", "Control+x"]]) {
      if (clipboard !== undefined) {
        await page.evaluate((text) => navigator.clipboard.writeText(text), clipboard);
      }
      await selectAll(page);
      await page.keyboard.press(key);
      const want = HEADER + "\n" + (clipboard ?? "");
      const after = await textWhen(page, (t) => t === want);
      expect(after === want, `Select All, ${what}: ${JSON.stringify(after)}`);
      await page.keyboard.press("Control+z");
      const back = await textWhen(page, (t) => t === original);
      expect(back === original, `one undo after ${what}: ${JSON.stringify(back)}`);
    }

    console.log("\n[2] typing into the line, Backspace in it, and deleting it");
    const header = page.locator(".monaco-editor .view-line", { hasText: HEADER }).first();
    await header.click();
    await page.keyboard.press("End");
    await page.keyboard.type("xy");
    const typed = await textWhen(page, (t) => t.startsWith(HEADER + "\nxy\n"));
    expect(typed.startsWith(HEADER + "\nxy\n"), `typed at its end, landed below: ${JSON.stringify(typed)}`);
    expect((await statusBar(page)).includes("PLL keeps the #level line"), "and the status bar says why");
    await page.keyboard.press("Control+z");
    expect((await textWhen(page, (t) => t === original)) === original, "and one undo takes it back");
    await header.click();
    await page.keyboard.press("End");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(800);
    expect((await editorText(page)) === original, `Backspace at its end: ${JSON.stringify(await editorText(page))}`);
    await page.keyboard.press("Control+Shift+k");
    await page.waitForTimeout(800);
    expect((await editorText(page)) === original, `Ctrl+Shift+K on it: ${JSON.stringify(await editorText(page))}`);

    console.log("\n[3] a program pasted in with its own `#level` line brings it");
    await page.evaluate(() => navigator.clipboard.writeText("#level intermediate\nx = 1\n"));
    await page.locator(".monaco-editor .view-line", { hasText: "answer" }).first().click();
    await selectAll(page);
    await page.keyboard.press("Control+v");
    const pasted = await textWhen(page, (t) => t === "#level intermediate\nx = 1\n");
    expect(pasted === "#level intermediate\nx = 1\n", `pasted: ${JSON.stringify(pasted)}`);
    await page.waitForTimeout(1500);
    expect((await lens(page)).includes("Level: intermediate"), `the CodeLens follows: ${JSON.stringify(await lens(page))}`);
    expect((await statusBar(page)).includes("PLL: intermediate"), "and the status bar");

    console.log("\n[4] the CodeLens's picker changes the level, and removes the line");
    await page.locator(".codelens-decoration a").first().click();
    await pickInPicker(page, "advanced");
    const changed = await textWhen(page, (t) => t.startsWith("#level advanced\n"));
    expect(changed === "#level advanced\nx = 1\n", `changed: ${JSON.stringify(changed)}`);
    await page.waitForTimeout(1500);
    await page.locator(".codelens-decoration a").first().click();
    await pickInPicker(page, "Remove the #level line");
    const removed = await textWhen(page, (t) => t === "x = 1\n");
    expect(removed === "x = 1\n", `removed: ${JSON.stringify(removed)}`);
    await page.waitForTimeout(1000);
    expect((await statusBar(page)).includes("PLL: raw"), "the status bar: raw");
    expect((await lens(page)) === "", "and no CodeLens");
    await page.locator(".monaco-editor .view-line", { hasText: "x = 1" }).first().click();
    await selectAll(page);
    await page.keyboard.press("Delete");
    const cleared = await textWhen(page, (t) => t === "");
    expect(cleared === "", `with no line, nothing is held: ${JSON.stringify(cleared)}`);

    console.log("\n[5] the status-bar item gives a file with no line one");
    await open(page, "hello.py", "greeting");
    await page.locator(".statusbar-item", { hasText: "PLL: raw" }).first().click();
    await pickInPicker(page, "beginner");
    const given = await textWhen(page, (t) => t.startsWith(HEADER + "\n\ngreeting"));
    expect(given.startsWith(HEADER + "\n\ngreeting"), `hello.py: ${JSON.stringify(given)}`);
    expect(tokenizer.length === 0, `the editor tokenized PLL's edits wrongly: ${tokenizer.join("; ")}`);
  } finally {
    await browser?.close();
    if (server?.pid) {
      // Kill the whole group: `npx` is the child, the server its grandchild.
      try {
        process.kill(-server.pid, "SIGTERM");
      } catch {
        server.kill("SIGTERM");
      }
    }
  }
  console.log(passed() ? "\nsmoke-web-level: ok" : "\nsmoke-web-level: FAILED");
  process.exit(passed() ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
