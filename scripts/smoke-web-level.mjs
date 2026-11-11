#!/usr/bin/env node
/**
 * The `#level` line in the editor, on vscode-web, as a student meets it: the
 * keys and clicks of `src/editor/levelLine.ts`, through Chromium's input
 * pipeline, in the editor VS Code ships.
 *
 *   1. The line has a lock in the gutter, and hovering over it says where
 *      the level is changed. Select All, then Delete, Paste or Cut: the
 *      line stays, and one undo brings everything back
 *   2. Typing into the line, Backspace in it, and deleting it: the line
 *      stays, and what was typed lands on the line below, in its order
 *   3. A program pasted in with its own `#level` line brings it
 *   4. The status-bar item opens the picker, which changes the level and
 *      removes the line; then nothing is held
 *   5. The status-bar item gives a file with no line one
 *   6. A new file: its `#level` line typed, and Enter at its end - with LF
 *      line breaks and with CRLF, Windows's, which the editor gives any
 *      line break PLL writes
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

/** The lines with PLL's lock in the gutter beside them, in the editor with focus. */
async function locks(page) {
  return page.evaluate(() => {
    const editor = document.querySelector(".part.editor .monaco-editor.focused") ?? document.querySelector(".part.editor .monaco-editor");
    const icons = [...(editor?.querySelectorAll(".margin *") ?? [])].filter((el) =>
      getComputedStyle(el).backgroundImage.includes("level-lock"),
    );
    const lines = [...(editor?.querySelectorAll(".view-lines .view-line") ?? [])];
    return icons.map((icon) => {
      const line = lines.find((l) => Math.abs(l.getBoundingClientRect().top - icon.getBoundingClientRect().top) < 3);
      return (line?.textContent ?? "?").replace(/ /g, " ");
    });
  });
}

/** What hovering over the text of the line that reads `text` shows, or "" for no hover. */
async function hoverOver(page, text) {
  await page.locator(".monaco-editor .view-line", { hasText: text }).first().locator("span span").first().hover();
  const hover = page.locator(".monaco-hover", { hasText: "PLL keeps this line" }).first();
  const shown = await hover
    .waitFor({ state: "visible", timeout: 5000 })
    .then(async () => ((await hover.textContent()) ?? "").replace(/\s+/g, " ").trim())
    .catch(() => "");
  await page.keyboard.press("Escape");
  return shown;
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

/** Run a command by its title from the palette, and pick `choice` in the list it shows, if given. */
async function command(page, title, choice) {
  await page.keyboard.press("F1");
  const input = page.locator(".quick-input-widget input");
  await input.waitFor({ state: "visible" });
  await input.fill(">" + title);
  await page.waitForTimeout(400);
  await page.keyboard.press("Enter");
  if (choice !== undefined) {
    await page.waitForTimeout(600);
    await input.fill(choice);
    await page.waitForTimeout(400);
    await page.keyboard.press("Enter");
  }
  await page.locator(".quick-input-widget").waitFor({ state: "hidden" });
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
    expect((await lens(page)) === "", `no CodeLens: ${JSON.stringify(await lens(page))}`);
    expect((await statusBar(page)).includes("PLL: beginner"), "the status bar's level");
    expect(JSON.stringify(await locks(page)) === JSON.stringify([HEADER]), `a lock beside the line only: ${JSON.stringify(await locks(page))}`);
    const said = await hoverOver(page, HEADER);
    expect(
      said === "PLL keeps this line. To change the level, click PLL: beginner in the status bar, at the bottom right of the window.",
      `hovering over the line: ${JSON.stringify(said)}`,
    );
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
    await page.keyboard.type("x");
    const typed = await textWhen(page, (t) => t.startsWith(HEADER + "\nx\n"));
    expect(typed.startsWith(HEADER + "\nx\n"), `typed at its end, landed below: ${JSON.stringify(typed)}`);
    expect((await statusBar(page)).includes("PLL keeps the #level line"), "and the status bar says why");
    await page.keyboard.press("Control+z");
    expect((await textWhen(page, (t) => t === original)) === original, "and one undo takes it back");
    // A second key comes before the first is put back, or after: either
    // way the two stay in the order they were typed. Each key put back on
    // its own is undone on its own.
    for (const pause of [0, 5, 10, 20, 40]) {
      await header.click();
      await page.keyboard.press("End");
      await page.keyboard.type("x");
      await page.waitForTimeout(pause);
      await page.keyboard.type("y");
      const both = await textWhen(page, (t) => t.startsWith(HEADER + "\nxy\n"));
      expect(both.startsWith(HEADER + "\nxy\n"), `a second key ${pause} ms later, in order: ${JSON.stringify(both)}`);
      for (let undo = 0; undo < 2 && (await editorText(page)) !== original; undo++) {
        const before = await editorText(page);
        await page.keyboard.press("Control+z");
        await textWhen(page, (t) => t !== before, 1000);
      }
      expect((await editorText(page)) === original, `and undo takes them back: ${JSON.stringify(await editorText(page))}`);
    }
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
    expect((await statusBar(page)).includes("PLL: intermediate"), "the status bar follows");

    console.log("\n[4] the status-bar item's picker changes the level, and removes the line");
    await page.locator(".statusbar-item", { hasText: "PLL: intermediate" }).first().click();
    await pickInPicker(page, "advanced");
    const changed = await textWhen(page, (t) => t.startsWith("#level advanced\n"));
    expect(changed === "#level advanced\nx = 1\n", `changed: ${JSON.stringify(changed)}`);
    await page.waitForTimeout(1500);
    expect((await hoverOver(page, "#level advanced")).includes("click PLL: advanced"), "the hover follows the level");
    await page.locator(".statusbar-item", { hasText: "PLL: advanced" }).first().click();
    await pickInPicker(page, "Remove the #level line");
    const removed = await textWhen(page, (t) => t === "x = 1\n");
    expect(removed === "x = 1\n", `removed: ${JSON.stringify(removed)}`);
    await page.waitForTimeout(1000);
    expect((await statusBar(page)).includes("PLL: raw"), "the status bar: raw");
    expect((await locks(page)).length === 0, `and no lock: ${JSON.stringify(await locks(page))}`);
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

    console.log("\n[6] a new file: its `#level` line typed, and Enter at its end, with LF and with CRLF");
    // The new file's own editor: the page has others, the one VS Code opens
    // untitled at the start among them.
    const textOf = (uri) =>
      page.evaluate((u) => {
        const editor = [...document.querySelectorAll(".part.editor .monaco-editor")].find((e) => e.getAttribute("data-uri") === u);
        const lines = [...(editor?.querySelectorAll(".view-lines .view-line") ?? [])];
        lines.sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top));
        return lines.map((el) => (el.textContent ?? "").replace(/\u00a0/g, " ")).join("\n");
      }, uri);
    for (const eol of ["LF", "CRLF"]) {
      await command(page, "File: New Untitled Text File");
      await command(page, "Change Language Mode", "Python");
      await command(page, "Change End of Line Sequence", eol);
      const uri = await page.evaluate(() => document.querySelector(".part.editor .monaco-editor.focused")?.getAttribute("data-uri"));
      await page.keyboard.type("#level intermediate");
      await page.waitForTimeout(800);
      expect((await statusBar(page)).includes("PLL: intermediate"), `${eol}: PLL holds the new file's line: ${uri}`);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(300);
      const entered = await textOf(uri);
      await page.waitForTimeout(1000);
      const later = await textOf(uri);
      expect(
        entered === "#level intermediate\n" && later === entered,
        `${eol}: one line break, and no more after it: ${JSON.stringify(entered)} then ${JSON.stringify(later)}`,
      );
      await command(page, "View: Revert and Close Editor");
    }
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
