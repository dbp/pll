#!/usr/bin/env node
/**
 * Editor keyboard copy/paste on vscode-web, as a student would do it:
 *   1. Open a file
 *   2. Select the first line
 *   3. Ctrl/Cmd+C
 *   4. Move the cursor to the end of the file
 *   5. Ctrl/Cmd+V
 *   6. The first line is still there, and also appears at the bottom
 *
 * vscode-web registers the clipboard actions with no keybinding
 * (`kbOpts: isNative ? ... : undefined`) so that Chromium's own
 * copy/paste events fire on Monaco's focused `textarea.inputarea`. This
 * test exercises that native path: Playwright's key events go through
 * Chromium's input pipeline as trusted events. The one thing it is not is
 * a physical key event from the OS.
 *
 *   node scripts/smoke-editor-clipboard.mjs                  # insiders
 *   VSCODE_WEB_QUALITY=stable node scripts/...               # what vscode.dev ships
 *   VSCODE_WEB_URL=http://localhost:3000 node scripts/...    # reuse a server
 */
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = process.env.VSCODE_WEB_PORT ?? "3013";
const URL = process.env.VSCODE_WEB_URL ?? `http://localhost:${PORT}`;
const START_SERVER = !process.env.VSCODE_WEB_URL;
const QUALITY = process.env.VSCODE_WEB_QUALITY ?? "insiders";
const HEADED = !!process.env.VSCODE_WEB_HEADED;
const FIRST_LINE = 'greeting = "Hello!"';

function startServer() {
  const child = spawn(
    "npx",
    [
      "vscode-test-web",
      "--browser=none",
      `--quality=${QUALITY}`,
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
    child.once("exit", (code) => {
      reject(new Error(`vscode-test-web exited ${code} before listening`));
    });
    setTimeout(() => reject(new Error("vscode-test-web did not start")), 30_000);
  });
}

async function editorText(page) {
  return page.evaluate(() => {
    const lines = [...document.querySelectorAll(".monaco-editor .view-line")];
    return lines.map((el) => (el.textContent ?? "").replace(/\u00a0/g, " ")).join("\n");
  });
}

async function visibleWidgets(page) {
  const texts = await page
    .locator(".suggest-widget, .action-widget, .context-view, .monaco-hover, .notifications-toasts")
    .allTextContents();
  return texts.map((t) => t.trim()).filter(Boolean);
}

async function main() {
  const server = START_SERVER ? await startServer() : null;
  let browser;
  try {
    browser = await chromium.launch({
      headless: !HEADED,
      args: ["--no-sandbox"],
    });
    const context = await browser.newContext();
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const page = await context.newPage();
    page.setDefaultTimeout(45_000);

    await page.goto(URL, { waitUntil: "domcontentloaded" });
    await page.locator(".monaco-workbench").waitFor({ state: "visible" });
    await page.locator(".monaco-list-row", { hasText: "hello.py" }).first().waitFor({
      state: "visible",
    });
    // Let activation and the extension host settle before opening a file.
    await page.waitForTimeout(4000);

    await page.locator(".monaco-list-row", { hasText: "hello.py" }).first().dblclick();
    const firstLine = page.locator(".monaco-editor .view-line", { hasText: "greeting" }).first();
    await firstLine.waitFor({ state: "visible", timeout: 20_000 });

    const before = await editorText(page);
    console.log("1 opened hello.py:", JSON.stringify(before));
    if (!before.includes(FIRST_LINE)) {
      throw new Error(`hello.py not in the editor: ${JSON.stringify(before)}`);
    }

    await firstLine.click();
    await page.waitForTimeout(400);
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    await page.waitForTimeout(400);
    console.log("2 selected first line");

    // Chromium delivers these through its input pipeline as trusted events,
    // which is what makes them exercise the browser's native copy handler.
    await page.evaluate(() => navigator.clipboard.writeText("NOT_YET"));
    await page.keyboard.press("Control+c");
    await page.waitForTimeout(400);
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    const afterCopyWidgets = await visibleWidgets(page);
    console.log("3 copied:", JSON.stringify(copied));
    console.log("   widgets after copy:", afterCopyWidgets);
    if (!copied.includes("greeting")) {
      throw new Error(
        `Ctrl+C did not copy the selection (clipboard=${JSON.stringify(copied)} widgets=${JSON.stringify(afterCopyWidgets)})`,
      );
    }

    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    const mid = await editorText(page);
    console.log("4 moved cursor to end:", JSON.stringify(mid));
    if (!mid.includes(FIRST_LINE)) {
      throw new Error(`original first line disappeared after moving: ${JSON.stringify(mid)}`);
    }

    await page.keyboard.press("Control+v");
    await page.waitForTimeout(500);
    const after = await editorText(page);
    const afterPasteWidgets = await visibleWidgets(page);
    console.log("5 pasted:", JSON.stringify(after));
    console.log("   widgets after paste:", afterPasteWidgets);

    const copies = after.split(FIRST_LINE).length - 1;
    if (copies < 2) {
      throw new Error(
        `expected the first line to appear again after paste (count=${copies}). editor=${JSON.stringify(after)} widgets=${JSON.stringify(afterPasteWidgets)}`,
      );
    }
    if (!after.includes(FIRST_LINE)) {
      throw new Error(`original line missing after paste: ${JSON.stringify(after)}`);
    }

    console.log("ok: select / copy / move / paste kept the original and inserted a copy");
  } finally {
    await browser?.close();
    if (server?.pid) {
      // Kill the whole group: `npx` is the child, the server its grandchild.
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
  // Piped stdio from the server can keep the loop alive; exit explicitly so
  // a passing run does not look like a hang.
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
