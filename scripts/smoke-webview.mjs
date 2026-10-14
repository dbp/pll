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
export const window = { showSaveDialog: async () => undefined };
export const workspace = {};
`;

const {
  InteractionsView,
  buildExamplarEntries,
  findRuntimeFinding,
  serializeFinding,
} = await importSource(
  `
export { InteractionsView } from "./src/editor/panel/view";
export { buildExamplarEntries } from "./src/run/examplar";
export { findRuntimeFinding } from "./src/run/finding";
export { serializeFinding } from "./src/run/finding";
`,
  { vscodeStub: VSCODE_STUB },
);

/* ---- What the session shows, made the way the host makes it ---------- */

const CODE = "def add(xs: list, item: str) -> list:\n    return xs + item\n";
const finding = serializeFinding(
  findRuntimeFinding("t.py", "beginner", {
    errorType: "TypeError",
    message: 'can only concatenate list (not "str") to list',
    // As Python explains it (`explain/stock.py`).
    finding: {
      id: "stock-message",
      errorType: "TypeError",
      headline: "A list and a string cannot be added together.",
      howToFix: ["`+` joins a list to another list. To add one item, put it inside brackets: `xs + [item]`."],
      fileName: "t.py",
      lineNumber: 2,
      column: null,
      nameToken: null,
      severity: "error",
      origin: "runtime",
    },
  }),
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
    chaffsSkipped: ["double"],
  },
);
const session = {
  entries: [
    { kind: "banner", text: "Running t.py" },
    testReport,
    { kind: "finding", finding },
    ...examplar,
  ],
  state: { title: "t.py [beginner]", prompt: "primary", status: null, awaitingInput: false, inputPrefix: "" },
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
    if (showOnReady) view.show(session.entries, session.state);
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

const fromView = [];
await page.exposeFunction("__pllToHost", (msg) => {
  fromView.push(msg);
  receive(msg);
});
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
  console.log("\n[1] a fresh view says it is ready, and waits for the host's session");
  await page.goto(`${ORIGIN}/view.html`);
  await settle();
  const empty = await page.evaluate(() => ({
    mode: document.body.className,
    text: document.getElementById("empty")?.innerText ?? "",
  }));
  expect(toHost.filter((m) => m.type === "ready").length === 1, "one ready");
  expect(empty.mode.includes("mode-waiting"), `waiting: ${empty.mode}`);
  expect(empty.text === "", `with nothing to say yet: ${JSON.stringify(empty.text)}`);

  console.log("\n[2] a session's entries are drawn from the host's own shapes");
  view.show(session.entries, session.state);
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

  console.log("\n[5b] the input row follows the state: busy, waiting for input(), and idle");
  {
    const row = () =>
      page.evaluate(() => ({
        disabled: document.getElementById("input").disabled,
        stop: !document.getElementById("stop").hidden,
        status: document.getElementById("status").textContent,
        prompt: document.getElementById("prompt").textContent,
        title: document.getElementById("title").textContent,
      }));
    const state = { title: "t.py [raw]", prompt: "primary", status: "Running...", awaitingInput: false, inputPrefix: "" };
    view.setState(state);
    await settle();
    const busy = await row();
    expect(busy.disabled && busy.stop && busy.status === "Running..." && busy.title === "t.py [raw]",
      `running: no typing, Stop offered, the status said: ${JSON.stringify(busy)}`);
    view.setState({ ...state, status: "Waiting for input...", awaitingInput: true, inputPrefix: "Name: " });
    await settle();
    const waiting = await row();
    expect(!waiting.disabled && !waiting.stop && waiting.prompt === "Name: ",
      `input() takes a line, after its own prompt: ${JSON.stringify(waiting)}`);
    view.setState({ ...state, status: null, prompt: "continuation" });
    await settle();
    const idle = await row();
    expect(!idle.disabled && !idle.stop && idle.status === "" && idle.prompt === "...",
      `idle, in the middle of a block: ${JSON.stringify(idle)}`);
    view.setState({ ...state, status: null });
    await settle();
  }

  console.log("\n[6] a reload is redrawn by the host, not from the view's own copy");
  // With nothing to show, the reloaded view must be empty: what it had
  // before is not its to restore.
  await page.reload();
  await settle();
  const afterReload = await page.evaluate(() => ({
    mode: document.body.className,
    entries: document.querySelectorAll("#stream .entry").length,
  }));
  expect(afterReload.mode.includes("mode-waiting") && afterReload.entries === 0,
    `waiting until the host says otherwise: ${JSON.stringify(afterReload)}`);
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

  console.log("\n[8] a table card lines numbers up by type, and Save CSV sends the whole table");
  {
    view.append({
      kind: "table",
      columns: ["code", "amount"],
      rows: [["9", "12999.99"], ["100", "2.0"]],
      rowCount: 300,
      shownCount: 2,
      truncated: true,
      numeric: [false, true],
      csv: "code,amount\n9,12999.99\n100,2.0\n",
      csvRows: 300,
      source: "t.py",
    });
    await settle();
    const card = await page.evaluate(() => {
      const table = [...document.querySelectorAll(".entry.table")].at(-1);
      return {
        right: [...table.querySelectorAll("tbody td")].map((td) => td.classList.contains("num")),
        title: table.querySelector("button")?.title,
      };
    });
    // Text that looks like a number stays on the left: it is text.
    expect(JSON.stringify(card.right) === "[false,true,false,true]", `aligned by what Python holds: ${JSON.stringify(card.right)}`);
    expect(/full table/.test(card.title ?? ""), `the whole table: ${card.title}`);
    const sentBefore = fromView.length;
    await page.click(".entry.table >> nth=-1 >> button");
    await settle();
    const saved = fromView.slice(sentBefore).find((m) => m.type === "saveCsv");
    expect(saved?.csv === "code,amount\n9,12999.99\n100,2.0\n", `Python's CSV, not the cells shown: ${JSON.stringify(saved)}`);
  }

  console.log("\n[9] a reactor card is redrawn by each patch, and ticks while it is drawn and plays");
  {
    view.append({
      kind: "reactor", id: "rx1", title: "counter", tickRate: 0.02, ticking: true, wantsKeys: false, wantsMouse: false,
      register: null, frame: '<svg id="one"/>', index: 0, length: 1, atEnd: true, stopped: false,
      valueRepr: "0", playing: false, connection: "none",
    });
    await page.waitForTimeout(100);
    view.updateReactor("rx1", { frame: '<svg id="two"/>', index: 1, length: 2, valueRepr: "1" });
    await settle();
    const card = await page.evaluate(() => {
      const el = [...document.querySelectorAll(".entry.reactor")].at(-1);
      return {
        picture: el?.querySelector(".rxStage svg")?.id,
        value: el?.querySelector(".rxValue")?.textContent,
        counter: el?.querySelector(".rxCounter")?.textContent,
      };
    });
    expect(card.picture === "two" && card.value === "1" && card.counter === "frame 1 of 1",
      `the new frame, its value and its place: ${JSON.stringify(card)}`);

    // Its clock is the card's: it ticks while the card plays, and only while it is drawn.
    const ticks = () => toHost.filter((m) => m.type === "reactorControl" && m.id === "rx1" && m.action === "tick").length;
    const still = ticks();
    await page.waitForTimeout(150);
    expect(ticks() === still, `not playing, no ticks: ${ticks() - still}`);
    view.updateReactor("rx1", { playing: true });
    await page.waitForTimeout(200);
    const playing = ticks();
    expect(playing - still >= 3, `playing, a tick every 20ms: ${playing - still}`);
    view.updateReactor("rx1", { playing: false });
    await page.waitForTimeout(60);
    const paused = ticks();
    await page.waitForTimeout(150);
    expect(ticks() === paused, `paused, none: ${ticks() - paused}`);
    view.updateReactor("rx1", { playing: true });
    await page.waitForTimeout(60);
    view.show([], { title: "other.py", prompt: "primary", status: null, awaitingInput: false, inputPrefix: "" });
    await page.waitForTimeout(60);
    const away = ticks();
    await page.waitForTimeout(150);
    expect(ticks() === away, `another session shown, none: ${ticks() - away}`);
  }

  console.log("\n[10] a line typed at the prompt is shown where it was typed, so the next can be lined up under it");
  {
    // The echoed code starts where the input box does, under either
    // prompt: one character to the right, and every indent after it is off by one.
    view.append({ kind: "echo", prompt: ">>>", code: "def foo():" });
    view.append({ kind: "echo", prompt: "...", code: "    return 1" });
    const lefts = async (prompt) => {
      view.setState({ title: "other.py", prompt, status: null, awaitingInput: false, inputPrefix: "" });
      await settle();
      return page.evaluate(() => ({
        input: document.getElementById("input").getBoundingClientRect().left,
        echoes: [...document.querySelectorAll(".entry.echo .code")].slice(-2).map((c) => c.getBoundingClientRect().left),
        shown: [...document.querySelectorAll(".entry.echo")].slice(-2).map((e) => e.innerText),
      }));
    };
    for (const prompt of ["primary", "continuation"]) {
      const at = await lefts(prompt);
      expect(at.echoes.length === 2 && at.echoes.every((left) => Math.abs(left - at.input) < 0.5),
        `under the ${prompt} prompt, the echoed code starts with the input: ${JSON.stringify(at)}`);
    }
  }

  expect(problems.length === 0, `no script errors or CSP violations: ${problems.join("; ")}`);
} finally {
  view.dispose();
  await browser.close();
}

console.log(passed() ? "\nsmoke-webview: ok" : "\nsmoke-webview: FAILED");
process.exit(passed() ? 0 : 1);
