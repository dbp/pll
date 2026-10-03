#!/usr/bin/env node
/**
 * The interactions panel, both halves at once: the real `InteractionsView`
 * runs here, its HTML - CSP, nonce and all - is loaded into Chromium, and
 * messages go between them the way VS Code carries them. The entries come
 * from the host's own producers, so a change in a shape on one side and
 * not the other fails here rather than as a blank card.
 *
 * Needs Playwright's Chromium (`pnpm run setup:browser`).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { expect, passed } from "./lib/check.mjs";
import { importSource, ROOT } from "./lib/bundle.mjs";

const ORIGIN = "https://pll-webview.test";

/** Just enough `vscode` for the view: paths, and no save dialog. */
const VSCODE_STUB = `
export const Uri = {
  file: (path) => ({ path, fsPath: path }),
  joinPath: (base, ...parts) => ({ path: [base.path, ...parts].join("/") }),
};
export const commands = { executeCommand: async () => undefined };
export const window = {};
export const workspace = {};
`;

const {
  InteractionsView,
  buildExamplarEntries,
  findRuntimeFinding,
  pythonErrorFrom,
  serializeFinding,
} = await importSource(
  `
export { InteractionsView } from "./src/common/interactionsView";
export { buildExamplarEntries } from "./src/common/examplarPhase";
export { findRuntimeFinding } from "./src/common/analyzers/registry";
export { pythonErrorFrom } from "./src/common/errors/pythonError";
export { serializeFinding } from "./src/common/analyzers/findingLocation";
`,
  { vscodeStub: VSCODE_STUB },
);

/* ---- What the session shows, made the way the host makes it ---------- */

const CODE = "def add(xs: list, item: str) -> list:\n    return xs + item\n";
const finding = serializeFinding(
  findRuntimeFinding(
    CODE,
    "t.py",
    "beginner",
    pythonErrorFrom({
      error_type: "TypeError",
      error_message: 'can only concatenate list (not "str") to list',
      error_file: "t.py",
      line_number: 2,
    }),
  ),
);
const testReport = {
  kind: "testReport",
  fileName: "t.py",
  passed: 1,
  failed: 1,
  skipped: 0,
  errors: 1,
  tests: [
    { name: "test_ok", outcome: "passed", lineNumber: 7, message: null, stdout: null },
    { name: "test_fail", outcome: "failed", lineNumber: 9, message: "assert 3 == 4", stdout: null },
    {
      name: "test_add",
      outcome: "error",
      lineNumber: 4,
      message: "TypeError: can only concatenate",
      stdout: null,
      finding,
    },
  ],
};
// One function whose tests are right but miss a planted bug, and one
// whose test is wrong. The wrong test's assertion states the right answer,
// so it must not reach the card.
const examplar = buildExamplarEntries(
  { url: "https://example.test/hw.json", json: "", cached: false },
  {
    ok: true,
    provides: ["add", "double"],
    attribution: { test_add_one: ["add"], test_double: ["double"] },
    wheats: [
      {
        id: "reference",
        loaded: true,
        tests: {
          test_add_one: { outcome: "pass", message: null },
          test_double: { outcome: "fail", message: "assert 6 == 7" },
        },
      },
    ],
    chaffs: [
      { id: "1", targets: "add", loaded: true, tests: { test_add_one: { outcome: "fail", message: "x" } } },
      { id: "2", targets: "add", loaded: true, tests: { test_add_one: { outcome: "pass", message: null } } },
    ],
    chaffs_skipped: ["double"],
  },
);
const session = {
  title: "t.py [beginner]",
  entries: [
    { kind: "banner", text: "Running t.py" },
    testReport,
    { kind: "finding", finding },
    ...examplar,
  ],
  prompt: "primary",
  busy: false,
};

/* ---- The host half --------------------------------------------------- */

const toHost = [];
const opened = [];
let showOnReady = false;
const view = new InteractionsView({ path: "/ext" });
view.setHandlers({
  onSubmit: (code) => toHost.push({ type: "submit", code }),
  onInterrupt() {},
  onClearRequested() {},
  onReactorControl: (id, action, index) => toHost.push({ type: "reactorControl", id, action, index }),
  onReactorInput() {},
  onOpenLocation: (fileName, line, column) => opened.push({ fileName, line, column }),
  onViewReady() {
    toHost.push({ type: "ready" });
    if (!showOnReady) return false;
    view.showSession(session);
    return true;
  },
});

const browser = await chromium.launch();
const page = await browser.newPage();
const problems = [];
page.on("pageerror", (err) => problems.push(String(err)));
// A CSP violation is reported here; nothing else in the page logs.
page.on("console", (msg) => {
  if (msg.type() === "error") problems.push(msg.text());
});

// Messages are delivered in order, as VS Code delivers them.
let delivery = Promise.resolve();
let receive = () => {};
const webview = {
  options: {},
  html: "",
  cspSource: ORIGIN,
  asWebviewUri: (uri) => ({ toString: () => ORIGIN + uri.path }),
  postMessage(msg) {
    delivery = delivery.then(() => page.evaluate((m) => window.postMessage(m, "*"), msg));
    return Promise.resolve(true);
  },
  onDidReceiveMessage(cb) {
    receive = cb;
    return { dispose() {} };
  },
};
view.resolveWebviewView({ webview, onDidDispose: () => ({ dispose() {} }), show() {} });

await page.exposeFunction("__pllToHost", (msg) => receive(msg));
// `acquireVsCodeApi`, with its state kept across a reload the way VS Code
// keeps it. An init script runs before the page's own and is not subject
// to its CSP, so the policy under test is the view's alone.
await page.addInitScript(() => {
  window.acquireVsCodeApi = () => ({
    postMessage: (msg) => window.__pllToHost(msg),
    getState: () => JSON.parse(sessionStorage.getItem("pll-state") ?? "null"),
    setState: (s) => sessionStorage.setItem("pll-state", JSON.stringify(s)),
  });
});
await page.route(`${ORIGIN}/**`, (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path === "/view.html") {
    return route.fulfill({ contentType: "text/html", body: webview.html });
  }
  const file = path.replace(/^\/ext\//, "");
  const type = file.endsWith(".css") ? "text/css" : "text/javascript";
  return route.fulfill({ contentType: type, body: readFileSync(resolve(ROOT, file), "utf8") });
});

const settle = async () => {
  await delivery;
  await page.waitForTimeout(50);
  await delivery;
};

try {
  console.log("\n[1] a fresh view says it is ready, and shows the empty message");
  await page.goto(`${ORIGIN}/view.html`);
  await settle();
  const empty = await page.evaluate(() => ({
    mode: document.body.className,
    text: document.getElementById("empty")?.innerText ?? "",
  }));
  expect(toHost.filter((m) => m.type === "ready").length === 1, "one ready");
  expect(empty.mode.includes("mode-empty"), `empty mode: ${empty.mode}`);
  expect(/Open a Python file/.test(empty.text), `the empty message: ${JSON.stringify(empty.text)}`);

  console.log("\n[2] a session's entries are drawn from the host's own shapes");
  view.showSession(session);
  await settle();
  const drawn = await page.evaluate(() => {
    const box = document.querySelector(".entry.testReport .testFinding");
    return {
      title: document.getElementById("title")?.textContent,
      boxText: box?.innerText ?? null,
      entryText: document.querySelector(".entry.finding")?.innerText ?? null,
      rawMessages: [...document.querySelectorAll(".testMsg")].map((m) => m.textContent),
      examplar: [...document.querySelectorAll(".entry.examplar")].map((card) => ({
        title: card.querySelector(".exTitle")?.textContent,
        source: card.querySelector(".exSource")?.title,
        blocks: [...card.querySelectorAll(".exLine, .exFailure")].map((b) => `${b.className}|${b.textContent}`),
      })),
    };
  });
  expect(drawn.title === "t.py [beginner]", `title: ${drawn.title}`);
  expect(drawn.boxText !== null && drawn.boxText === drawn.entryText,
    `a test's finding reads as a finding entry does:\n${drawn.boxText}\n---\n${drawn.entryText}`);
  expect(drawn.boxText?.includes(finding.headline), "the explanation, not Python's message");
  expect(drawn.rawMessages.join("|") === "assert 3 == 4",
    `only the failed assert is shown raw: ${JSON.stringify(drawn.rawMessages)}`);
  const [addCard, doubleCard] = drawn.examplar;
  expect(drawn.examplar.map((c) => c.title).join(",") === "add,double",
    `a card per function: ${JSON.stringify(drawn.examplar.map((c) => c.title))}`);
  expect(addCard?.source === "https://example.test/hw.json", `the bundle as the tooltip: ${addCard?.source}`);
  drawn.examplar.forEach((c, i) =>
    expect(c.blocks.length === examplar[i].body.length, `every block drawn: ${JSON.stringify(c.blocks)}`));
  expect(addCard?.blocks.some((b) => b.startsWith("exLine exWarn") && /missed 2\b/.test(b)),
    `the missed chaff by its id: ${JSON.stringify(addCard?.blocks)}`);
  expect(doubleCard?.blocks.some((b) => b.startsWith("exFailure exFailureBad") && b.endsWith("|test_double")),
    `the wrong test by name: ${JSON.stringify(doubleCard?.blocks)}`);
  expect(!drawn.examplar.some((c) => c.blocks.some((b) => /assert 6 == 7/.test(b))),
    "the wrong test's assertion is not shown");
  console.log(`    ${drawn.examplar.flatMap((c) => c.blocks).join("\n    ")}`);

  console.log("\n[3] clicking a location asks the host to open it");
  await page.click(".entry.finding .loc a");
  await page.click(".entry.testReport .testRow .loc >> nth=0");
  await settle();
  expect(JSON.stringify(opened[0]) === JSON.stringify({ fileName: "t.py", line: 2, column: null }),
    `the finding's location: ${JSON.stringify(opened[0])}`);
  expect(JSON.stringify(opened[1]) === JSON.stringify({ fileName: "t.py", line: 7, column: null }),
    `the first test's line: ${JSON.stringify(opened[1])}`);

  console.log("\n[4] appends in a burst arrive as one message, in order");
  for (const text of ["a\n", "b\n", "c\n"]) view.append({ kind: "stdout", text });
  await page.waitForTimeout(100);
  await settle();
  const tail = await page.evaluate(() =>
    [...document.querySelectorAll("#stream .entry")].slice(-3).map((e) => e.textContent).join(""));
  expect(tail === "a\nb\nc\n", `the three lines, in order: ${JSON.stringify(tail)}`);

  console.log("\n[5] the prompt sends code, and only its history is saved");
  await page.fill("#input", "1 + 1");
  await page.press("#input", "Enter");
  await settle();
  const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem("pll-state")));
  expect(toHost.some((m) => m.type === "submit" && m.code === "1 + 1"), "the host got the code");
  expect(JSON.stringify(saved) === JSON.stringify({ history: ["1 + 1"] }),
    `nothing but history saved: ${JSON.stringify(saved)}`);

  console.log("\n[6] a reload is redrawn by the host, not from the view's own copy");
  // With nothing to show, the reloaded view must be empty: what it had
  // before is not its to restore.
  await page.reload();
  await settle();
  const afterReload = await page.evaluate(() => ({
    mode: document.body.className,
    entries: document.querySelectorAll("#stream .entry").length,
  }));
  expect(afterReload.mode.includes("mode-empty") && afterReload.entries === 0,
    `empty until the host says otherwise: ${JSON.stringify(afterReload)}`);
  showOnReady = true;
  await page.reload();
  await settle();
  const replayed = await page.evaluate(() => document.querySelectorAll("#stream .entry").length);
  expect(replayed === session.entries.length, `the host's replay: ${replayed} of ${session.entries.length}`);
  await page.focus("#input");
  await page.press("#input", "ArrowUp");
  const recalled = await page.inputValue("#input");
  expect(recalled === "1 + 1", `history survives the reload: ${JSON.stringify(recalled)}`);

  console.log("\n[7] a message that is not one of the view's is ignored");
  const openedBefore = opened.length;
  const sentBefore = toHost.length;
  await page.evaluate(() => {
    window.__pllToHost({ type: "openLocation", fileName: "t.py", line: "2" });
    window.__pllToHost({ type: "reactorControl", id: "r1", action: "seek", index: "3" });
    window.__pllToHost({ type: "submit" });
    window.__pllToHost({ type: "nonsense" });
    window.__pllToHost("ready");
    window.__pllToHost({ type: "reactorControl", id: "r1", action: "seek", index: 3 });
  });
  await settle();
  expect(opened.length === openedBefore, `a line that is not a number opens nothing: ${JSON.stringify(opened.slice(openedBefore))}`);
  const arrived = toHost.slice(sentBefore);
  expect(JSON.stringify(arrived) === JSON.stringify([{ type: "reactorControl", id: "r1", action: "seek", index: 3 }]),
    `only the well-formed one arrives: ${JSON.stringify(arrived)}`);

  expect(problems.length === 0, `no script errors or CSP violations: ${problems.join("; ")}`);
} finally {
  view.dispose();
  await browser.close();
}

console.log(passed() ? "\nsmoke-webview: ok" : "\nsmoke-webview: FAILED");
process.exit(passed() ? 0 : 1);
