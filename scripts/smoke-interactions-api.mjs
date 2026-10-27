#!/usr/bin/env node
/**
 * PLL's API for other extensions (`src/editor/api.ts`): the interactions
 * panel as its webview sees it. The real `InteractionsView` runs against a
 * stub `vscode` and a recorded webview, so this checks what the panel sends
 * and what the API passes on: every message but `focusInput`, whether or not
 * the webview has loaded, appends batched as the webview gets them, and each
 * change of visibility.
 */
import { importSource } from "./lib/bundle.mjs";
import { expect, passed } from "./lib/check.mjs";

const VSCODE_STUB = `
export class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (listener) => {
      this.listeners.push(listener);
      return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== listener)) };
    };
  }
  fire(value) {
    for (const listener of [...this.listeners]) listener(value);
  }
  dispose() {
    this.listeners = [];
  }
}
export class Uri {
  constructor(path) {
    this.path = path;
  }
  static joinPath(base, ...parts) {
    return new Uri([base.path, ...parts].join("/"));
  }
  static file(path) {
    return new Uri(path);
  }
  toString() {
    return "file://" + this.path;
  }
}
export const window = {
  showInformationMessage: async () => undefined,
  showSaveDialog: async () => undefined,
};
export const workspace = { fs: { writeFile: async () => undefined } };
export const commands = { executeCommand: async () => undefined };
`;

const { InteractionsView, makeApi } = await importSource(
  'export { InteractionsView } from "./src/editor/panel/view";\n' + 'export { makeApi } from "./src/editor/api";',
  { vscodeStub: VSCODE_STUB },
);

/** Let the view's 16 ms append batch go out. */
const batched = () => new Promise((resolve) => setTimeout(resolve, 40));

/** A webview view as VS Code hands one over, recording what it is sent. */
function fakeWebviewView() {
  const handlers = { message: null, visibility: null, dispose: null };
  const view = {
    visible: true,
    posted: [],
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-resource:",
      asWebviewUri: (uri) => uri,
      postMessage: async (msg) => {
        view.posted.push(msg);
        return true;
      },
      onDidReceiveMessage: (listener) => {
        handlers.message = listener;
        return { dispose() {} };
      },
    },
    onDidChangeVisibility: (listener) => {
      handlers.visibility = listener;
      return { dispose() {} };
    },
    onDidDispose: (listener) => {
      handlers.dispose = listener;
      return { dispose() {} };
    },
    show() {},
    /** The panel shown or hidden, as VS Code says it. */
    setVisible(visible) {
      view.visible = visible;
      handlers.visibility();
    },
    ready: () => handlers.message({ type: "ready" }),
    close: () => handlers.dispose(),
  };
  return view;
}

const STATE = { title: "hello.py [beginner]", prompt: "primary", status: null, awaitingInput: false, inputPrefix: "" };
const FILE = "file:///home/ana/hw3/hello.py";

/** A session manager that only answers `shown`. */
const repl = (shown) => ({ shown: () => shown });

console.log("\n[1] every message to the webview is an event, before the webview loads too");
{
  const view = new InteractionsView({ path: "/ext" });
  const api = makeApi(view, repl(null));
  const seen = [];
  api.interactions.onDidChange((change) => seen.push(change));

  expect(api.version === 1, "the API says its version");
  expect(api.interactions.current().visible === false, "a panel never opened isn't visible");
  view.show([{ kind: "banner", text: "hello.py" }], STATE, FILE);
  view.append({ kind: "stdout", text: "hi\n" });
  view.append({ kind: "result", repr: "3" });
  await batched();
  view.updateReactor("r1", { frame: "<svg/>" });
  view.setState({ ...STATE, status: "Running..." });
  view.focusInput();
  view.clear();
  const types = seen.map((c) => c.type);
  expect(
    JSON.stringify(types) === JSON.stringify(["show", "appendMany", "reactorPatch", "state", "clear"]),
    `the events, in order and without focusInput: ${types}`,
  );
  expect(seen[0].file === FILE && seen[0].entries.length === 1, "show names the session's file and carries its entries");
  expect(seen[1].entries.length === 2, "appends go out as the webview gets them, batched");
  expect(seen[2].id === "r1" && seen[2].patch.frame === "<svg/>", "a reactor patch, as sent");
  console.log(`    ${seen.length} events`);
}

console.log("\n[2] a show drops the appends still waiting, which it already holds");
{
  const view = new InteractionsView({ path: "/ext" });
  const seen = [];
  makeApi(view, repl(null)).interactions.onDidChange((change) => seen.push(change.type));
  view.append({ kind: "stdout", text: "old\n" });
  view.show([{ kind: "stdout", text: "old\n" }], STATE, null);
  await batched();
  expect(JSON.stringify(seen) === JSON.stringify(["show"]), `only the show: ${seen}`);
}

console.log("\n[3] visibility, from the webview view");
{
  const view = new InteractionsView({ path: "/ext" });
  const api = makeApi(view, repl({ file: FILE, entries: [{ kind: "stdout", text: "hi\n" }], state: STATE }));
  const seen = [];
  api.interactions.onDidChange((change) => change.type === "visible" && seen.push(change.visible));
  const webview = fakeWebviewView();
  view.resolveWebviewView(webview);
  webview.ready();
  expect(api.interactions.current().visible, "visible once resolved on screen");
  webview.setVisible(false);
  expect(!api.interactions.current().visible, "hidden");
  webview.setVisible(true);
  webview.close();
  expect(JSON.stringify(seen) === JSON.stringify([true, false, true, false]), `visibility events: ${seen}`);
  expect(!api.interactions.current().visible, "a closed panel isn't visible");

  const current = api.interactions.current();
  expect(current.file === FILE && current.entries.length === 1 && current.state.title === STATE.title, "current() is the session shown");
}

console.log("\n[4] the webview still gets what it did");
{
  const view = new InteractionsView({ path: "/ext" });
  const webview = fakeWebviewView();
  view.resolveWebviewView(webview);
  webview.ready();
  view.show([], STATE, FILE);
  view.focusInput();
  view.append({ kind: "stdout", text: "x\n" });
  await batched();
  const types = webview.posted.map((m) => m.type);
  expect(JSON.stringify(types) === JSON.stringify(["show", "focusInput", "appendMany"]), `the webview's messages: ${types}`);
}

console.log("\n[5] nothing shown yet");
{
  const current = makeApi(new InteractionsView({ path: "/ext" }), repl(null)).interactions.current();
  expect(current.file === null && current.entries.length === 0 && current.state.status === null, "an empty panel");
}

if (!passed()) process.exit(1);
console.log("\nsmoke-interactions-api: passed");
