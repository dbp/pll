#!/usr/bin/env node
/**
 * Smoke test for `ReplSession`, the host-side session manager.
 *
 * `vscode` is aliased to a small stub and the Python runtime / interactions
 * view are recorders, so this exercises the parts that are pure logic:
 * per-file sessions, the multi-line prompt buffer, static-check gating,
 * stream line batching, the `input()` handshake, and sibling-file syncing.
 */
import { build } from "esbuild";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

let ok = true;
function expect(cond, msg) {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    ok = false;
  }
}
/** Let the session's internal promise chain settle. */
const settle = () => new Promise((r) => setTimeout(r, 5));

/* ---------------------------------------------------------------- */
/* A `vscode` stub with just enough surface for the modules imported */
/* ---------------------------------------------------------------- */

const VSCODE_STUB = `
class Uri {
  constructor(scheme, path) {
    this.scheme = scheme;
    this.path = path;
  }
  static file(p) {
    return new Uri("file", p);
  }
  static joinPath(base, ...parts) {
    let segments = base.path.split("/").filter((s) => s.length > 0);
    for (const part of parts) {
      for (const piece of part.split("/")) {
        if (piece === "" || piece === ".") continue;
        if (piece === "..") segments.pop();
        else segments.push(piece);
      }
    }
    return new Uri(base.scheme, "/" + segments.join("/"));
  }
  toString() {
    return this.scheme + ":" + this.path;
  }
}

/** In-memory folder contents, keyed by uri string. Tests drive this. */
export const files = new Map();
export const written = new Map();
let activeEditorListener = null;

export const FileType = { File: 1, Directory: 2 };
export const UIKind = { Desktop: 1, Web: 2 };
export const ConfigurationTarget = { Global: 1, Workspace: 2 };
export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2 };
export const OverviewRulerLane = { Right: 4 };
export const TextEditorSelectionChangeKind = { Keyboard: 1, Mouse: 2 };
export class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}
export class Range {
  constructor(a, b, c, d) {
    if (typeof a === "number") {
      this.start = new Position(a, b);
      this.end = new Position(c, d);
    } else {
      this.start = a;
      this.end = b;
    }
  }
}
export class Diagnostic {
  constructor(range, message, severity) {
    this.range = range;
    this.message = message;
    this.severity = severity;
  }
}
export { Uri };

export const window = {
  activeTextEditor: undefined,
  onDidChangeActiveTextEditor(cb) {
    activeEditorListener = cb;
    return { dispose() { activeEditorListener = null; } };
  },
  onDidChangeTextEditorSelection() {
    return { dispose() {} };
  },
  onDidChangeVisibleTextEditors() {
    return { dispose() {} };
  },
  visibleTextEditors: [],
  createTextEditorDecorationType: () => ({ dispose() {} }),
  showTextDocument: async () => undefined,
  showSaveDialog: async () => undefined,
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  setStatusBarMessage: () => undefined,
  registerWebviewViewProvider: () => ({ dispose() {} }),
};

export const workspace = {
  textDocuments: [],
  getConfiguration: () => ({ get: () => undefined, update: async () => undefined }),
  fs: {
    async readDirectory(folder) {
      const prefix = folder.toString() + "/";
      const out = [];
      for (const key of files.keys()) {
        if (key.startsWith(prefix) && !key.slice(prefix.length).includes("/")) {
          out.push([key.slice(prefix.length), FileType.File]);
        }
      }
      return out;
    },
    async readFile(uri) {
      const found = files.get(uri.toString());
      if (found === undefined) throw new Error("ENOENT " + uri.toString());
      return new TextEncoder().encode(found);
    },
    async writeFile(uri, data) {
      written.set(uri.toString(), new TextDecoder().decode(data));
      files.set(uri.toString(), new TextDecoder().decode(data));
    },
  },
};

export const languages = {
  createDiagnosticCollection: () => ({
    set() {}, delete() {}, dispose() {},
  }),
};
export const commands = { executeCommand: async () => undefined };
export const env = { clipboard: { readText: async () => "", writeText: async () => undefined } };
export const extensions = { getExtension: () => undefined };

/** Test hook: pretend the user focused a different editor. */
export function __setActiveEditor(editor) {
  window.activeTextEditor = editor;
  if (activeEditorListener) activeEditorListener(editor);
}
`;

async function load() {
  const tmp = mkdtempSync(join(ROOT, ".smoke-"));
  writeFileSync(join(tmp, "vscode.mjs"), VSCODE_STUB);
  writeFileSync(
    join(tmp, "entry.mjs"),
    `
export { ReplSession, STOP_TIMEOUT_MS, MAX_STREAM_LINES_PER_RUN } from "../src/common/replSession";
export * as vscodeStub from "./vscode.mjs";
`,
  );
  await build({
    entryPoints: [join(tmp, "entry.mjs")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: join(tmp, "out.mjs"),
    loader: { ".py": "text" },
    alias: { vscode: join(tmp, "vscode.mjs") },
    absWorkingDir: ROOT,
  });
  const mod = await import(pathToFileURL(join(tmp, "out.mjs")).href);
  rmSync(tmp, { recursive: true, force: true });
  return mod;
}

const { ReplSession, STOP_TIMEOUT_MS, MAX_STREAM_LINES_PER_RUN, vscodeStub } = await load();
const { Uri, __setActiveEditor, files, written } = vscodeStub;

/* ---------------------------------------------------------------- */
/* Recorders                                                        */
/* ---------------------------------------------------------------- */

function makeView() {
  const view = {
    entries: [],
    prompt: "primary",
    busy: false,
    status: undefined,
    title: "",
    awaitingInput: false,
    inputPrefix: "",
    registered: [],
    reactorPatches: [],
    focusedInput: 0,
    handlers: null,
    setHandlers(h) {
      view.handlers = h;
    },
    reveal: async () => undefined,
    showSession(state) {
      view.title = state.title;
      view.entries = [...state.entries];
      view.prompt = state.prompt;
      view.busy = state.busy;
      view.status = state.status;
      view.awaitingInput = !!state.awaitingInput;
      view.inputPrefix = state.inputPrefix ?? "";
    },
    setTitle(t) {
      view.title = t;
    },
    append(entry) {
      view.entries.push(entry);
    },
    clear() {
      view.entries = [];
    },
    setPrompt(kind) {
      view.prompt = kind;
    },
    setBusy(busy, status) {
      view.busy = busy;
      view.status = status;
    },
    updateReactor(id, patch) {
      view.reactorPatches.push([id, patch]);
      for (const entry of view.entries) {
        if (entry.kind === "reactor" && entry.id === id) Object.assign(entry, patch);
      }
    },
    setAwaitingInput(awaiting, prefix) {
      view.awaitingInput = awaiting;
      view.inputPrefix = prefix ?? "";
    },
    focusInput() {
      view.focusedInput += 1;
    },
    registerFile(name, uri) {
      view.registered.push([name, uri.toString()]);
    },
  };
  return view;
}

function makeDiagnostics() {
  return {
    calls: [],
    clear(uri) {
      this.calls.push(["clear", uri.toString()]);
    },
    setFinding(uri, _doc, finding) {
      this.calls.push(["setFinding", uri.toString(), finding.id]);
    },
    setFindings(uri, _doc, findings) {
      this.calls.push(["setFindings", uri.toString(), findings.length]);
    },
    dispose() {},
  };
}

/**
 * Scriptable runtime. `script.events(kind, request)` returns the events a
 * run should emit; `script.findings` is what staticAnalyze returns. A
 * function under a method's own name (`script.runTests`, say) replaces that
 * method, for a test that has to hold one step of a run open.
 */
function makeRuntime(script = {}) {
  const calls = [];
  let stdinHandler = null;
  const runtime = {
    calls,
    get stdinHandler() {
      return stdinHandler;
    },
    async examplarRun(testSource, bundle) {
      calls.push(["examplarRun", testSource, bundle]);
      if (script.examplarRun) return script.examplarRun(testSource, bundle);
      if (script.examplarThrows) throw new Error("boom");
      return script.examplarResult ?? { ok: true, provides: [], wheats: [], chaffs: [] };
    },
    async examplarBuild(sources) {
      calls.push(["examplarBuild", sources]);
      return { ok: true };
    },
    async reactorStep(reactorId, event) {
      calls.push(["reactorStep", reactorId, event]);
      return script.reactorStep?.(reactorId, JSON.parse(event)) ?? { ok: true };
    },
    async reactorSeek(reactorId, index) {
      calls.push(["reactorSeek", reactorId, index]);
      return script.reactorSeek?.(reactorId, index) ?? { ok: true };
    },
    async reactorDispose(reactorId) {
      calls.push(["reactorDispose", reactorId]);
    },
    interrupt() {
      calls.push(["interrupt"]);
      // `script.noInterruptChannel` mimics a host with no SharedArrayBuffer.
      return !script.noInterruptChannel;
    },
    async initialize() {
      calls.push(["initialize"]);
      if (script.initFails) throw new Error("pyodide unavailable");
    },
    async runFile(request, onEvent) {
      calls.push(["runFile", request.code, request.sessionKey]);
      for (const event of (script.events?.("runFile", request) ?? [])) {
        if (typeof event === "function") await event(onEvent);
        else onEvent(event);
      }
    },
    async replEval(request, onEvent) {
      calls.push(["replEval", request.code, request.sessionKey]);
      for (const event of (script.events?.("replEval", request) ?? [])) {
        if (typeof event === "function") await event(onEvent);
        else onEvent(event);
      }
    },
    async checkReplComplete(code) {
      calls.push(["checkReplComplete", code]);
      // Good enough for the prompt: a trailing colon or open bracket
      // continues, as does a line inside an indented block.
      const lines = code.split("\n");
      const last = lines[lines.length - 1];
      if (/[:\[({]\s*$/.test(code) || /^\s+\S/.test(last)) {
        return { status: "incomplete" };
      }
      return { status: "complete" };
    },
    async hasTests(code) {
      calls.push(["hasTests"]);
      if (script.hasTestsFails) throw new Error("cannot inspect");
      return /def test_/.test(code);
    },
    async ensurePytest() {
      calls.push(["ensurePytest"]);
      if (script.ensurePytest) return script.ensurePytest();
      if (script.pytestFails) throw new Error("no pytest wheel");
    },
    async runTests(request, onEvent) {
      calls.push(["runTests", request.fileName]);
      if (script.runTests) return script.runTests(request, onEvent);
      onEvent({
        kind: "testReport",
        fileName: request.fileName,
        passed: 1,
        failed: 0,
        skipped: 0,
        errors: 0,
        tests: [{ name: "test_ok", outcome: "passed", lineNumber: 2, message: null, stdout: null }],
      });
      onEvent({ kind: "done" });
    },
    async ensurePackages(code) {
      calls.push(["ensurePackages", code]);
      if (script.ensurePackages) return script.ensurePackages(code);
      if (script.packagesFail) throw new Error("network down");
    },
    async staticAnalyze(request) {
      calls.push(["staticAnalyze", request.fileName, request.level, request.sessionKey]);
      if (script.staticAnalyze) return script.staticAnalyze(request);
      return script.findings ?? [];
    },
    async mountWorkspaceFiles(files) {
      calls.push(["mountWorkspaceFiles", files.map((f) => f.name).join("|")]);
      if (script.mountWorkspaceFiles) return script.mountWorkspaceFiles(files);
    },
    async collectWorkspaceFiles() {
      calls.push(["collectWorkspaceFiles"]);
      return script.changedFiles ?? [];
    },
    setStdinHandler(handler) {
      stdinHandler = handler;
    },
    dispose() {},
  };
  return runtime;
}

function makeDoc(name, code = "") {
  const uri = Uri.file(`/work/${name}`);
  return {
    uri,
    languageId: "python",
    lineCount: code.split("\n").length,
    getText: () => code,
    lineAt: (i) => ({
      text: code.split("\n")[i] ?? "",
      range: new vscodeStub.Range(i, 0, i, 0),
    }),
  };
}

/** Build a session manager with recorders, focused on `doc`. */
/**
 * Fake universe transport. Tests drive it through the returned record:
 * `sockets` is every connection attempt, each with the handlers the session
 * installed and the messages it has sent.
 */
function makeUniverse() {
  const sockets = [];
  const connectUniverse = (url, handlers) => {
    const socket = {
      url,
      handlers,
      sent: [],
      closed: false,
      send(json) { socket.sent.push(json); },
      close() { socket.closed = true; },
    };
    sockets.push(socket);
    return socket;
  };
  return { sockets, connectUniverse };
}

async function harness(script = {}, doc = makeDoc("hello.py")) {
  __setActiveEditor(doc ? { document: doc } : undefined);
  const runtime = makeRuntime(script);
  const { sockets, connectUniverse } = makeUniverse();
  // In-memory bundle store; `script.bundles` seeds it per test.
  const bundles = new Map(Object.entries(script.bundles ?? {}));
  const bundleStore = {
    read: (url) => Promise.resolve(bundles.get(url)),
    write: (url, entry) => {
      bundles.set(url, entry);
      return Promise.resolve();
    },
  };
  const view = makeView();
  const diagnostics = makeDiagnostics();
  const repl = new ReplSession({ runtime, view, diagnostics, connectUniverse, bundleStore });
  await settle();
  return { repl, runtime, view, diagnostics, doc, sockets, bundles };
}

/**
 * An error event, as the runtime builds one from `_pll_error_info`: `frames`
 * is `[file, line, function]` per frame, outermost first, and a frame is the
 * student's unless its file is `<exec>`.
 */
function errorEvent({ type, message, file, line, column = null, frames = [], facts = {} }) {
  return {
    kind: "error",
    fileName: file,
    error: {
      errorType: type,
      message,
      traceback: `${type}: ${message}`,
      fileName: file,
      lineNumber: line,
      column,
      nameToken: facts.name ?? null,
      frames: frames.map(([fileName, frameLine, functionName = null]) => ({
        fileName,
        line: frameLine,
        column: null,
        functionName,
        user: fileName !== "<exec>",
      })),
      facts,
    },
  };
}

const texts = (view, kind) =>
  view.entries.filter((e) => e.kind === kind).map((e) => e.text ?? e.code ?? e.repr);
const kinds = (view) => view.entries.map((e) => e.kind);

/* ---------------------------------------------------------------- */
/* Tests                                                            */
/* ---------------------------------------------------------------- */

console.log("\n[1] a prompt line is echoed, run, and its output batched by line");
{
  const { repl, view, runtime } = await harness({
    events: () => [
      { kind: "stdout", text: "ab" },
      { kind: "stdout", text: "cd\nef" },
      { kind: "result", repr: "7" },
      { kind: "done" },
    ],
  });
  view.handlers.onSubmit("1 + 6");
  await settle();
  console.log(`    entries: ${kinds(view).join(", ")}`);
  expect(kinds(view).join(",") === "echo,stdout,stdout,result", "echo, batched stdout, result");
  expect(view.entries[0].prompt === ">>>", "primary prompt should be echoed");
  expect(texts(view, "echo")[0] === "1 + 6", "the submitted code should be echoed");
  // "ab" + "cd\nef" is one complete line then a partial one, flushed at the result.
  expect(
    texts(view, "stdout").join("|") === "abcd|ef",
    'stdout should be batched into lines, got "' + texts(view, "stdout").join("|") + '"',
  );
  expect(view.busy === false, "the session should not be left busy");
  expect(
    runtime.calls.some((c) => c[0] === "replEval" && c[1] === "1 + 6"),
    "the line should reach replEval",
  );
  repl.dispose();
}

console.log("\n[2] an incomplete line opens a continuation buffer, a blank line runs it");
{
  const { repl, view, runtime } = await harness({ events: () => [{ kind: "done" }] });
  view.handlers.onSubmit("if True:");
  await settle();
  expect(view.prompt === "continuation", "an open block should switch to the ... prompt");
  expect(
    !runtime.calls.some((c) => c[0] === "replEval"),
    "an incomplete snippet must not be evaluated yet",
  );

  view.handlers.onSubmit("    x = 1");
  await settle();
  expect(view.prompt === "continuation", "an indented body should stay on the ... prompt");
  expect(view.entries.at(-1).prompt === "...", "continuation lines echo with ...");

  view.handlers.onSubmit("");
  await settle();
  const evaluated = runtime.calls.filter((c) => c[0] === "replEval");
  console.log(`    evaluated: ${JSON.stringify(evaluated.map((c) => c[1]))}`);
  expect(evaluated.length === 1, "the blank line should run the buffered snippet");
  expect(
    evaluated[0][1] === "if True:\n    x = 1",
    "the snippet should be the joined lines, got " + JSON.stringify(evaluated[0][1]),
  );
  expect(view.prompt === "primary", "the prompt should return to >>>");
  repl.dispose();
}

console.log("\n[3] Ctrl+C during a continuation abandons the buffer");
{
  const { repl, view, runtime } = await harness({ events: () => [{ kind: "done" }] });
  view.handlers.onSubmit("for i in [1]:");
  await settle();
  view.handlers.onInterrupt();
  await settle();
  expect(
    view.entries.some((e) => e.kind === "banner" && e.text === "KeyboardInterrupt"),
    "interrupting should show a KeyboardInterrupt banner",
  );
  expect(view.prompt === "primary", "the prompt should reset to >>>");
  view.handlers.onSubmit("2");
  await settle();
  const evaluated = runtime.calls.filter((c) => c[0] === "replEval");
  expect(
    evaluated.length === 1 && evaluated[0][1] === "2",
    "the abandoned lines must not be prepended to the next snippet",
  );
  repl.dispose();
}

console.log("\n[4] a multi-line paste is processed one line at a time");
{
  const { repl, view, runtime } = await harness({ events: () => [{ kind: "done" }] });
  view.handlers.onSubmit("x = 1\ny = 2");
  await settle();
  const evaluated = runtime.calls.filter((c) => c[0] === "replEval").map((c) => c[1]);
  console.log(`    evaluated: ${JSON.stringify(evaluated)}`);
  expect(evaluated.join("|") === "x = 1|y = 2", "each pasted line runs on its own");
  expect(texts(view, "echo").join("|") === "x = 1|y = 2", "each line should be echoed");
  repl.dispose();
}

console.log("\n[5] beginner static findings block the file and become diagnostics");
{
  const doc = makeDoc("beginner.py", "#level beginner\nx = 1\nx = 2\n");
  const { repl, view, runtime, diagnostics } = await harness(
    {
      findings: [
        {
          id: "reassignment",
          error_type: "Reassignment",
          message: "x is assigned twice",
          line_number: 3,
          column: 0,
          name_token: "x",
          scope_kind: "module",
          first_line_number: 2,
          first_column: 0,
        },
      ],
    },
    doc,
  );
  await repl.runFile(doc.getText(), "beginner.py", doc);
  await settle();
  console.log(`    entries: ${kinds(view).join(", ")}`);
  expect(
    !runtime.calls.some((c) => c[0] === "runFile"),
    "a blocked file must not be executed",
  );
  expect(
    view.entries.some((e) => e.kind === "finding" && e.finding.errorType === "Reassignment"),
    "the finding should be shown in the interactions view",
  );
  expect(
    /^Static analysis found \d+ problems?\. The file was not run\.$/.test(view.entries.at(-1).text),
    "the banner should say the file was not executed, got " + view.entries.at(-1).text,
  );
  expect(
    diagnostics.calls.some((c) => c[0] === "setFindings" && c[2] === 1),
    "file findings should also become editor diagnostics",
  );
  expect(view.title === "beginner.py [beginner]", "the header should show the level, got " + view.title);
  expect(view.busy === false, "a blocked run should not leave the session busy");
  expect(
    runtime.calls.find((c) => c[0] === "staticAnalyze")[3] === undefined,
    "a file analysis should not pass a sessionKey",
  );
  repl.dispose();
}

console.log("\n[6] prompt findings stay in the view and carry the session key");
{
  const doc = makeDoc("beginner.py", "#level beginner\n");
  const { repl, view, runtime, diagnostics } = await harness(
    {
      findings: [
        {
          id: "shadowing-builtin",
          error_type: "Shadowing",
          message: "list shadows a builtin",
          line_number: 1,
          column: 0,
          name_token: "list",
          scope_kind: "module",
        },
      ],
    },
    doc,
  );
  // A run establishes the level the prompt then uses.
  await repl.runFile("#level beginner\n", "beginner.py", doc);
  await settle();
  const before = diagnostics.calls.length;
  view.handlers.onSubmit("list = [1]");
  await settle();
  expect(
    /^Static analysis found \d+ problems?\. Your input was not run\.$/.test(view.entries.at(-1).text),
    "the prompt banner should say the input was not executed, got " + view.entries.at(-1).text,
  );
  expect(
    !runtime.calls.some((c) => c[0] === "replEval"),
    "a blocked snippet must not be evaluated",
  );
  expect(
    diagnostics.calls.length === before,
    "snippet findings must not be mapped onto the .py file",
  );
  const replAnalyze = runtime.calls.filter((c) => c[0] === "staticAnalyze").at(-1);
  console.log(`    staticAnalyze: ${JSON.stringify(replAnalyze)}`);
  expect(replAnalyze[1] === "<repl>", "the snippet should be analyzed as <repl>");
  expect(replAnalyze[2] === "beginner", "the prompt should use the last run's level");
  expect(typeof replAnalyze[3] === "string", "the snippet analysis should pass a sessionKey");
  repl.dispose();
}

console.log("\n[7] a file with no header is raw and skips static analysis");
{
  const doc = makeDoc("plain.py", "print(1)\n");
  const { repl, view, runtime } = await harness({ events: () => [{ kind: "done" }] }, doc);
  await repl.runFile("print(1)\n", "plain.py", doc);
  await settle();
  expect(
    !runtime.calls.some((c) => c[0] === "staticAnalyze"),
    "no header means raw, which has no checks",
  );
  expect(runtime.calls.some((c) => c[0] === "runFile"), "the file should run");
  expect(view.title === "plain.py [raw]", "header should show raw, got " + view.title);
  repl.dispose();
}

console.log("\n[8] a runtime NameError becomes a friendly finding");
{
  const doc = makeDoc("oops.py", "print(total)\n");
  const { repl, view, runtime, diagnostics } = await harness(
    {
      events: () => [
        errorEvent({
          type: "NameError",
          message: "name 'total' is not defined",
          file: "oops.py",
          line: 1,
          frames: [["oops.py", 1]],
          facts: { name: "total" },
        }),
        { kind: "done" },
      ],
    },
    doc,
  );
  await repl.runFile("print(total)\n", "oops.py", doc);
  await settle();
  const finding = view.entries.find((e) => e.kind === "finding");
  console.log(`    headline: ${finding?.finding.headline}`);
  expect(!!finding, "a NameError should produce a finding entry, not a raw error");
  expect(
    finding.finding.headline.includes("total"),
    "the headline should name the unresolved name",
  );
  expect(
    finding.finding.location?.label === "oops.py:1",
    "the finding should link to the file location, got " + finding.finding.location?.label,
  );
  expect(
    diagnostics.calls.some((c) => c[0] === "setFinding"),
    "the finding should also become an editor diagnostic",
  );
  expect(
    !view.entries.some((e) => e.kind === "rawError"),
    "the raw traceback should not also be shown",
  );
  repl.dispose();
}

console.log("\n[9] an error with no analyzer of its own is still a finding");
{
  // It used to fall through to the raw traceback, which in PLL means
  // frames from PLL's own machinery (`File "<exec>", line 560, in table`)
  // and, for pandas, dozens of lines from inside pandas. The message a
  // student needs is the last line; a traceback through the implementation
  // only buries it.
  // Deliberately an error no analyzer claims: every rewording task adds
  // rules, and this test is about what happens to whatever is left over.
  const code = "x = 1\nprint(x / 0)\n";
  const doc = makeDoc("boom.py", code);
  const { repl, view } = await harness(
    {
      events: () => [
        errorEvent({
          type: "ZeroDivisionError",
          message: "division by zero",
          file: "boom.py",
          line: 2,
          frames: [["<exec>", 779, "_pll_run_file"], ["boom.py", 2]],
        }),
        { kind: "done" },
      ],
    },
    doc,
  );
  await repl.runFile(code, "boom.py", doc);
  await settle();
  expect(
    !view.entries.some((e) => e.kind === "rawError"),
    "no error should reach a student as a raw traceback",
  );
  const finding = view.entries.find((e) => e.kind === "finding")?.finding;
  expect(finding !== undefined, "it should arrive as a finding");
  expect(
    finding.errorType === "ZeroDivisionError",
    `Python's own type is kept: ${finding.errorType}`,
  );
  expect(/division by zero/.test(finding.headline), `headline: ${finding.headline}`);
  // Located in the student's file, from the innermost frame that is theirs -
  // not the `<exec>` frame above it. The view gets the serialized form, so
  // the location arrives as a label rather than as separate fields.
  expect(finding.location?.line === 2,
    `blamed on the student's line, got ${JSON.stringify(finding.location)}`);
  expect(finding.location?.fileName === "boom.py",
    `in their file, got ${JSON.stringify(finding.location)}`);
  console.log(`    ${finding.errorType}: ${finding.headline} (${finding.location.label})`);
  repl.dispose();
}

console.log("\n[10] tests run before the file, and their report is shown");
{
  const code = "def add(a, b):\n    return a + b\n\ndef test_add():\n    assert add(1, 2) == 3\n";
  const doc = makeDoc("tests.py", code);
  const { repl, view, runtime } = await harness({ events: () => [{ kind: "done" }] }, doc);
  await repl.runFile(code, "tests.py", doc);
  await settle();
  const order = runtime.calls.map((c) => c[0]).filter((c) => c === "runTests" || c === "runFile");
  console.log(`    order: ${order.join(" -> ")}`);
  expect(order.join(",") === "runTests,runFile", "tests should run before the file");
  expect(
    runtime.calls.some((c) => c[0] === "ensurePytest"),
    "pytest should be loaded when the file has tests",
  );
  expect(
    view.entries.some((e) => e.kind === "testReport" && e.passed === 1),
    "the pass/fail card should be shown",
  );
  repl.dispose();
}

console.log("\n[11] a file with no tests never loads pytest");
{
  const doc = makeDoc("plain.py", "print(1)\n");
  const { repl, runtime } = await harness({ events: () => [{ kind: "done" }] }, doc);
  await repl.runFile("print(1)\n", "plain.py", doc);
  await settle();
  expect(
    !runtime.calls.some((c) => c[0] === "ensurePytest"),
    "pytest should not be loaded for a file without tests",
  );
  repl.dispose();
}

console.log("\n[12] a failed pytest load degrades to running the file");
{
  const code = "def test_x():\n    assert True\n";
  const doc = makeDoc("tests.py", code);
  const { repl, view, runtime } = await harness(
    { pytestFails: true, events: () => [{ kind: "done" }] },
    doc,
  );
  await repl.runFile(code, "tests.py", doc);
  await settle();
  expect(
    view.entries.some((e) => e.kind === "banner" && /Could not load pytest/.test(e.text)),
    "the failure should be explained in the view",
  );
  expect(!runtime.calls.some((c) => c[0] === "runTests"), "tests should be skipped");
  expect(runtime.calls.some((c) => c[0] === "runFile"), "the file should still run");
  repl.dispose();
}

console.log("\n[13] packages are only loaded for code that imports something");
{
  const { repl, view, runtime } = await harness({ events: () => [{ kind: "done" }] });
  view.handlers.onSubmit("1 + 1");
  await settle();
  expect(
    !runtime.calls.some((c) => c[0] === "ensurePackages"),
    "a plain prompt line should not pay a package round-trip",
  );
  view.handlers.onSubmit("import pandas as pd");
  await settle();
  expect(
    runtime.calls.some((c) => c[0] === "ensurePackages"),
    "an import should trigger a package load",
  );
  repl.dispose();
}

console.log("\n[14] sibling files are mounted before a run and written back after");
{
  files.clear();
  written.clear();
  files.set("file:/work/cars.csv", "name,mpg\nvw,29\n");
  // A picture is mounted too, for `load_image("cat.png")`.
  files.set("file:/work/photo.png", "binary-ish");
  // ...but an executable is not.
  files.set("file:/work/tool.exe", "nope");
  const doc = makeDoc("files.py", "print(1)\n");
  const { repl, view, runtime } = await harness(
    {
      events: () => [{ kind: "done" }],
      changedFiles: [{ name: "out.csv", contents: "a,b\n1,2\n" }],
    },
    doc,
  );
  await repl.runFile("print(1)\n", "files.py", doc);
  await settle();
  const mount = runtime.calls.find((c) => c[0] === "mountWorkspaceFiles");
  console.log(`    mounted: ${mount[1]}`);
  expect(
    mount[1] === "cars.csv|photo.png",
    "data files and pictures should be sent, and nothing else, got " + mount[1],
  );
  expect(
    written.get("file:/work/out.csv") === "a,b\n1,2\n",
    "changed files should be written next to the script",
  );
  expect(
    view.entries.some((e) => e.kind === "banner" && e.text === "Saved out.csv next to files.py."),
    "a banner should name what was saved",
  );
  repl.dispose();
  files.clear();
  written.clear();
}

console.log("\n[15] an untitled buffer has no folder to sync");
{
  written.clear();
  const doc = makeDoc("Untitled-1", "print(1)\n");
  doc.uri = new Uri("untitled", "/Untitled-1");
  const { repl, runtime } = await harness(
    { events: () => [{ kind: "done" }], changedFiles: [{ name: "out.csv", contents: "x\n" }] },
    doc,
  );
  await repl.runFile("print(1)\n", "Untitled-1", doc);
  await settle();
  const mount = runtime.calls.find((c) => c[0] === "mountWorkspaceFiles");
  expect(mount[1] === "", "an untitled buffer should still clear the work dir");
  expect(written.size === 0, "nothing should be written back for an untitled buffer");
  repl.dispose();
}

console.log("\n[16] input() shows the pending prompt and resumes on submit");
{
  let resolved = "unset";
  const doc = makeDoc("input.py", 'name = input("Name: ")\n');
  const { repl, view, runtime } = await harness(
    {
      events: () => [
        { kind: "stdout", text: "Name: " },
        async () => {
          resolved = await runtime.stdinHandler();
        },
        { kind: "stdout", text: "hi Ada\n" },
        { kind: "done" },
      ],
    },
    doc,
  );
  const run = repl.runFile('name = input("Name: ")\n', "input.py", doc);
  await settle();
  console.log(`    awaiting=${view.awaitingInput} prefix=${JSON.stringify(view.inputPrefix)}`);
  expect(view.awaitingInput === true, "the input row should be enabled while input() waits");
  expect(
    view.inputPrefix === "Name: ",
    "the unflushed prompt should label the input row, got " + JSON.stringify(view.inputPrefix),
  );
  expect(view.focusedInput > 0, "the input row should be focused");

  view.handlers.onSubmit("Ada");
  await run;
  await settle();
  console.log(`    stdin resolved to ${JSON.stringify(resolved)}`);
  expect(resolved === "Ada", "the submitted line should reach Python, got " + resolved);
  expect(
    texts(view, "stdout").includes("Name: Ada"),
    "the prompt and the typed reply should read as one line, got " +
      JSON.stringify(texts(view, "stdout")),
  );
  expect(view.awaitingInput === false, "the input row should be released afterwards");
  repl.dispose();
}

console.log("\n[17] Ctrl+C while input() waits sends EOF");
{
  let resolved = "unset";
  const doc = makeDoc("input.py", 'input("x")\n');
  const { repl, view, runtime } = await harness(
    {
      events: () => [
        async () => {
          resolved = await runtime.stdinHandler();
        },
        { kind: "done" },
      ],
    },
    doc,
  );
  const run = repl.runFile('input("x")\n', "input.py", doc);
  await settle();
  view.handlers.onInterrupt();
  await run;
  await settle();
  expect(resolved === null, "interrupting input() should deliver EOF, got " + resolved);
  repl.dispose();
}

console.log("\n[18] each file keeps its own session, swapped with the active editor");
{
  const a = makeDoc("a.py", "print('a')\n");
  const b = makeDoc("b.py", "print('b')\n");
  const { repl, view, runtime } = await harness(
    { events: (_kind, req) => [{ kind: "stdout", text: `from ${req.fileName}\n` }, { kind: "done" }] },
    a,
  );
  await repl.runFile("print('a')\n", "a.py", a);
  await settle();
  expect(texts(view, "stdout").join("") === "from a.py", "a.py output should be visible");

  __setActiveEditor({ document: b });
  await settle();
  console.log(`    after switch: title=${view.title} entries=${view.entries.length}`);
  expect(view.title === "b.py", "switching editors should retitle the view");
  expect(view.entries.length === 0, "b.py has its own, empty session");

  view.handlers.onSubmit("1");
  await settle();
  const keyB = runtime.calls.filter((c) => c[0] === "replEval").at(-1)[2];
  expect(keyB === b.uri.toString(), "the prompt should target b.py's session, got " + keyB);

  __setActiveEditor({ document: a });
  await settle();
  expect(view.title === "a.py [raw]", "returning should restore a.py's title, got " + view.title);
  expect(
    texts(view, "stdout").join("") === "from a.py",
    "returning should replay a.py's entries",
  );
  repl.dispose();
}

console.log("\n[19] Run File clears the previous run and resets the prompt");
{
  const doc = makeDoc("hello.py", "print(1)\n");
  const { repl, view, runtime } = await harness({ events: () => [{ kind: "done" }] }, doc);
  view.handlers.onSubmit("if True:");
  await settle();
  expect(view.prompt === "continuation", "precondition: an open continuation");
  await repl.runFile("print(1)\n", "hello.py", doc);
  await settle();
  expect(view.prompt === "primary", "Run File should reset the prompt");
  expect(
    !view.entries.some((e) => e.kind === "echo"),
    "Run File should clear the previous stream",
  );
  view.handlers.onSubmit("2");
  await settle();
  const evaluated = runtime.calls.filter((c) => c[0] === "replEval").map((c) => c[1]);
  expect(
    evaluated.at(-1) === "2",
    "the abandoned continuation must not leak into the next snippet, got " + evaluated.at(-1),
  );
  repl.dispose();
}

console.log("\n[20] a Pyodide that will not start is reported once");
{
  const doc = makeDoc("hello.py", "print(1)\n");
  const { repl, view, runtime } = await harness({ initFails: true }, doc);
  await repl.runFile("print(1)\n", "hello.py", doc);
  await settle();
  const errors = view.entries.filter((e) => e.kind === "rawError");
  console.log(`    ${errors.length} error entr(y|ies): ${errors[0]?.errorType}`);
  expect(errors.length === 1, "the init failure should be reported once, got " + errors.length);
  expect(errors[0].errorType === "InitializationError", "it should be labelled as an init failure");
  expect(!runtime.calls.some((c) => c[0] === "runFile"), "nothing should run");
  expect(view.busy === false, "the session should not be stuck on a spinner");
  repl.dispose();
}

console.log("\n[21] a static-analysis crash does not block the run");
{
  const doc = makeDoc("beginner.py", "#level beginner\nprint(1)\n");
  const { repl, view, runtime } = await harness({ events: () => [{ kind: "done" }] }, doc);
  runtime.staticAnalyze = async () => {
    throw new Error("analyzer exploded");
  };
  await repl.runFile("#level beginner\nprint(1)\n", "beginner.py", doc);
  await settle();
  expect(
    texts(view, "banner").some((t) => /^Static analysis failed \(analyzer exploded\)\. Running anyway\.$/.test(t)),
    "the failure should be visible, got " + JSON.stringify(texts(view, "banner")),
  );
  expect(
    runtime.calls.some((c) => c[0] === "runFile"),
    "a broken analyzer should not stop the file from running",
  );
  repl.dispose();
}

/* ---------------------------------------------------------------- */
/* Stopping a running program                                       */
/* ---------------------------------------------------------------- */

/** A run that stays busy until the returned `release` is called. */
function gatedHarnessScript(extra = {}) {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  return {
    release: () => release(),
    script: {
      ...extra,
      events: (kind) =>
        kind === "runFile" ? [async () => { await gate; }, { kind: "done" }] : [{ kind: "done" }],
    },
  };
}

console.log("\n[22] Ctrl+C while a program runs asks the runtime to interrupt it");
{
  const { release, script } = gatedHarnessScript();
  const { repl, view, runtime, doc } = await harness(script);
  const run = repl.runFile("while True:\n    pass\n", "hello.py", doc);
  await settle();
  expect(view.busy === true, "the session should be busy while the program runs");
  view.handlers.onInterrupt();
  await settle();
  expect(
    runtime.calls.some((c) => c[0] === "interrupt"),
    "onInterrupt while busy should call runtime.interrupt()",
  );
  expect(view.status === "Stopping...", `status should read "Stopping...", got ${view.status}`);
  expect(
    !view.entries.some((e) => e.kind === "banner" && e.text === "KeyboardInterrupt"),
    "a running program should not get the abandoned-snippet banner",
  );
  release();
  await run;
  await settle();
  repl.dispose();
}

console.log("\n[23] the palette command stops the program too");
{
  const { release, script } = gatedHarnessScript();
  const { repl, runtime, doc } = await harness(script);
  const run = repl.runFile("while True:\n    pass\n", "hello.py", doc);
  await settle();
  repl.stopActiveProgram();
  await settle();
  expect(
    runtime.calls.filter((c) => c[0] === "interrupt").length === 1,
    "stopActiveProgram should interrupt exactly once",
  );
  release();
  await run;
  await settle();
  repl.dispose();
}

console.log("\n[24] with no interrupt channel the user is told, not left guessing");
{
  const { release, script } = gatedHarnessScript({ noInterruptChannel: true });
  const { repl, view, doc } = await harness(script);
  const run = repl.runFile("while True:\n    pass\n", "hello.py", doc);
  await settle();
  view.handlers.onInterrupt();
  await settle();
  expect(
    view.entries.some((e) => e.kind === "banner" && /Cannot stop the program/.test(e.text)),
    "a missing SharedArrayBuffer should produce an explanatory banner",
  );
  release();
  await run;
  await settle();
  repl.dispose();
}

console.log("\n[25] a Stop that never lands is reported instead of failing silently");
{
  const { release, script } = gatedHarnessScript();
  const { repl, view, doc } = await harness(script);
  const run = repl.runFile("while True:\n    pass\n", "hello.py", doc);
  await settle();
  view.handlers.onInterrupt();
  await settle();
  expect(
    !view.entries.some((e) => e.kind === "banner" && /has not stopped/.test(e.text)),
    "the warning must not appear immediately",
  );
  await new Promise((r) => setTimeout(r, STOP_TIMEOUT_MS + 200));
  expect(
    view.entries.some((e) => e.kind === "banner" && /has not stopped/.test(e.text)),
    "a program still running after the deadline should produce a warning banner",
  );
  release();
  await run;
  await settle();
  repl.dispose();
}

console.log("\n[26] a Stop after the program ended does not warn");
{
  const { release, script } = gatedHarnessScript();
  const { repl, view, doc } = await harness(script);
  const run = repl.runFile("print(1)\n", "hello.py", doc);
  await settle();
  view.handlers.onInterrupt();
  await settle();
  release();
  await run;
  await settle();
  await new Promise((r) => setTimeout(r, STOP_TIMEOUT_MS + 200));
  expect(
    !view.entries.some((e) => e.kind === "banner" && /has not stopped/.test(e.text)),
    "a finished program must not be reported as stuck",
  );
  repl.dispose();
}

console.log("\n[27] runaway output is capped so the panel stays usable");
{
  const flood = "hello\n".repeat(MAX_STREAM_LINES_PER_RUN + 1000);
  const { repl, view, doc } = await harness({
    events: (kind) => (kind === "runFile" ? [{ kind: "stdout", text: flood }, { kind: "done" }] : []),
  });
  await repl.runFile('while True:\n    print("hello")\n', "hello.py", doc);
  await settle();
  const printed = view.entries.filter((e) => e.kind === "stdout").length;
  expect(
    printed === MAX_STREAM_LINES_PER_RUN,
    `expected ${MAX_STREAM_LINES_PER_RUN} rendered lines, got ${printed}`,
  );
  const notices = view.entries.filter(
    (e) => e.kind === "banner" && /Output stopped after/.test(e.text),
  );
  expect(notices.length === 1, `expected exactly one truncation notice, got ${notices.length}`);
  console.log(`    rendered ${printed} of ${MAX_STREAM_LINES_PER_RUN + 1000} lines, one notice`);
  repl.dispose();
}

console.log("\n[28] the output budget resets for the next run");
{
  const { repl, view, doc } = await harness({
    events: (kind) => (kind === "runFile" ? [{ kind: "stdout", text: "a\n" }, { kind: "done" }] : []),
  });
  await repl.runFile("print('a')", "hello.py", doc);
  await settle();
  await repl.runFile("print('a')", "hello.py", doc);
  await settle();
  expect(
    view.entries.filter((e) => e.kind === "stdout").length === 1,
    "each Run File clears the panel, so the second run shows its own line",
  );
  expect(
    !view.entries.some((e) => e.kind === "banner" && /Output stopped/.test(e.text)),
    "a small second run must not inherit the previous run's budget",
  );
  repl.dispose();
}

/* ---------------------------------------------------------------- */
/* Reactors                                                         */
/* ---------------------------------------------------------------- */

/** The reactor event a worker emits when `interact()` runs. */
function reactorEvent(over = {}) {
  return {
    kind: "reactor",
    id: "r1",
    title: "test",
    tickRate: 0.02,
    ticking: true,
    wantsKeys: false,
    wantsMouse: false,
    register: null,
    frame: { data: "<svg/>", width: 10, height: 10 },
    index: 0,
    length: 1,
    atEnd: true,
    stopped: false,
    valueRepr: "0",
    ...over,
  };
}

/** A runtime whose reactor steps count up, like an on_tick of n + 1. */
function countingReactor(extra = {}) {
  let n = 0;
  return {
    events: (kind) => (kind === "runFile" ? [reactorEvent(extra.event), { kind: "done" }] : []),
    reactorStep: (_id, event) => {
      if (event.kind === "tick") n += 1;
      return {
        ok: true, frame: { data: `<svg id="${n}"/>`, width: 10, height: 10 },
        index: n, length: n + 1, at_end: true, stopped: extra.stopAt === n,
        value_repr: String(n), messages: extra.send ? [JSON.stringify(extra.send)] : [],
      };
    },
    reactorSeek: (_id, index) => ({
      ok: true, frame: { data: "<svg/>", width: 10, height: 10 },
      index, length: n + 1, at_end: false, stopped: false, value_repr: String(index),
    }),
    ...extra.script,
  };
}

console.log("\n[29] a reactor becomes a live card and ticks on its own");
{
  const { repl, view, runtime, doc } = await harness(countingReactor());
  await repl.runFile("animate(...)", "hello.py", doc);
  await settle();
  const card = view.entries.find((e) => e.kind === "reactor");
  expect(card !== undefined, "a reactor entry should be appended");
  expect(card.playing === true, "a ticking reactor should start playing");
  await new Promise((r) => setTimeout(r, 200));
  const ticks = runtime.calls.filter((c) => c[0] === "reactorStep").length;
  expect(ticks > 1, `the clock should have ticked more than once, got ${ticks}`);
  expect(card.index > 0, `the entry should track the frame, got ${card.index}`);
  repl.dispose();
}

console.log("\n[30] pause stops the clock; step advances exactly one frame");
{
  const { repl, view, runtime, doc } = await harness(countingReactor());
  await repl.runFile("animate(...)", "hello.py", doc);
  await settle();
  view.handlers.onReactorControl("r1", "pause");
  await new Promise((r) => setTimeout(r, 150));
  const paused = runtime.calls.filter((c) => c[0] === "reactorStep").length;
  await new Promise((r) => setTimeout(r, 150));
  expect(
    runtime.calls.filter((c) => c[0] === "reactorStep").length === paused,
    "no ticks should happen while paused",
  );
  view.handlers.onReactorControl("r1", "step");
  await settle();
  expect(
    runtime.calls.filter((c) => c[0] === "reactorStep").length === paused + 1,
    "step should be exactly one more tick",
  );
  view.handlers.onReactorControl("r1", "seek", 0);
  await settle();
  const seeks = runtime.calls.filter((c) => c[0] === "reactorSeek");
  expect(seeks.length === 1 && seeks[0][2] === 0, "seek should reach the runtime with its index");
  repl.dispose();
}

console.log("\n[31] stop_when halts the clock");
{
  const { repl, view, runtime, doc } = await harness(countingReactor({ stopAt: 2 }));
  await repl.runFile("animate(...)", "hello.py", doc);
  await new Promise((r) => setTimeout(r, 300));
  const card = view.entries.find((e) => e.kind === "reactor");
  expect(card.stopped === true, "the card should show as stopped");
  expect(card.playing === false, "a stopped reactor should not be playing");
  const settled = runtime.calls.filter((c) => c[0] === "reactorStep").length;
  await new Promise((r) => setTimeout(r, 200));
  expect(
    runtime.calls.filter((c) => c[0] === "reactorStep").length === settled,
    "no further ticks after stop_when",
  );
  repl.dispose();
}

console.log("\n[32] key and mouse input reach the reactor");
{
  const { repl, view, runtime, doc } = await harness(
    countingReactor({ event: { ticking: false, wantsKeys: true, wantsMouse: true } }),
  );
  await repl.runFile("reactor(...)", "hello.py", doc);
  await settle();
  view.handlers.onReactorInput("r1", { kind: "key", key: "left" });
  await settle();
  view.handlers.onReactorInput("r1", { kind: "mouse", x: 3, y: 4, event: "button-down" });
  await settle();
  const sent = runtime.calls.filter((c) => c[0] === "reactorStep").map((c) => JSON.parse(c[2]));
  expect(
    sent.some((e) => e.kind === "key" && e.key === "left"),
    "the key event should reach the runtime",
  );
  expect(
    sent.some((e) => e.kind === "mouse" && e.x === 3 && e.event === "button-down"),
    "the mouse event should reach the runtime",
  );
  repl.dispose();
}

console.log("\n[33] a registered world connects, receives, and sends");
{
  const { repl, view, runtime, doc, sockets } = await harness(
    countingReactor({
      event: { ticking: false, register: "ws://localhost:9999" },
      send: { hello: 1 },
    }),
  );
  await repl.runFile("reactor(...)", "hello.py", doc);
  await settle();
  expect(sockets.length === 1, `one connection should be opened, got ${sockets.length}`);
  expect(sockets[0].url === "ws://localhost:9999", "the register address should be used");
  const card = view.entries.find((e) => e.kind === "reactor");
  expect(card.connection === "connecting", `should start connecting, got ${card.connection}`);

  sockets[0].handlers.onOpen();
  await settle();
  expect(card.connection === "open", `should report open, got ${card.connection}`);

  // A message from the server becomes a `receive` event.
  sockets[0].handlers.onMessage(JSON.stringify({ from: "server" }));
  await settle();
  const received = runtime.calls
    .filter((c) => c[0] === "reactorStep")
    .map((c) => JSON.parse(c[2]))
    .filter((e) => e.kind === "receive");
  expect(received.length === 1, "the server message should become one receive event");
  expect(received[0].message.from === "server", "the payload should arrive unchanged");
  // ...and package(...) on that step sent one back.
  expect(
    sockets[0].sent.includes(JSON.stringify({ hello: 1 })),
    `package(...) should be sent, got ${JSON.stringify(sockets[0].sent)}`,
  );
  repl.dispose();
}

console.log("\n[34] messages sent before the socket opens are held, not lost");
{
  const { repl, view, doc, sockets } = await harness(
    countingReactor({
      event: { ticking: false, register: "ws://localhost:9999" },
      send: { early: true },
    }),
  );
  await repl.runFile("reactor(...)", "hello.py", doc);
  await settle();
  view.handlers.onReactorInput("r1", { kind: "key", key: "a" });
  await settle();
  expect(sockets[0].sent.length === 0, "nothing should be sent before the socket opens");
  sockets[0].handlers.onOpen();
  await settle();
  expect(
    sockets[0].sent.includes(JSON.stringify({ early: true })),
    "the held message should be flushed on open",
  );
  repl.dispose();
}

console.log("\n[35] a bad register address is reported, and nothing is dialled");
{
  const { repl, view, doc, sockets } = await harness(
    countingReactor({ event: { ticking: false, register: "http://not-a-socket" } }),
  );
  await repl.runFile("reactor(...)", "hello.py", doc);
  await settle();
  expect(sockets.length === 0, "an invalid address should not be dialled");
  const card = view.entries.find((e) => e.kind === "reactor");
  expect(card.connection === "error", `should report an error, got ${card.connection}`);
  expect(
    view.entries.some((e) => e.kind === "banner" && /ws:\/\/ or wss:\/\//.test(e.text)),
    "the student should be told what a register address looks like",
  );
  repl.dispose();
}

console.log("\n[36] re-running the file stops the old reactor and closes its socket");
{
  const { repl, runtime, doc, sockets } = await harness(
    countingReactor({ event: { register: "ws://localhost:9999" } }),
  );
  await repl.runFile("animate(...)", "hello.py", doc);
  await settle();
  await repl.runFile("animate(...)", "hello.py", doc);
  await settle();
  expect(sockets[0].closed === true, "the previous world's socket should be closed");
  expect(
    runtime.calls.some((c) => c[0] === "reactorDispose" && c[1] === "r1"),
    "the previous reactor should be disposed in Python",
  );
  const before = runtime.calls.filter((c) => c[0] === "reactorStep").length;
  await new Promise((r) => setTimeout(r, 200));
  // The second run re-used id "r1", so only one clock may be running.
  const rate = runtime.calls.filter((c) => c[0] === "reactorStep").length - before;
  expect(rate > 0 && rate < 40, `exactly one clock should be running, saw ${rate} ticks`);
  repl.dispose();
}

/* ---------------------------------------------------------------- */
/* Examplar                                                         */
/* ---------------------------------------------------------------- */

const EX_URL = "https://course.example/hw3.json";

/**
 * An examplarRun reply, shaped like the real primitive's.
 *
 * `failing` tests fail on the wheat, `raising` tests error on it, `missed`
 * chaffs pass. Chaffs belong to a function and are judged only by that
 * function's tests, and phase two is gated per function - so the fixture
 * has to reproduce both, or it would be testing replies the worker cannot
 * produce.
 */
function examplarReply({
  tests = ["test_a"],
  failing = [],
  raising = [],
  missed = [],
  defines = [],
  provides = ["shout"],
  // test -> the provided names it exercises. Everything, by default.
  attribution = null,
} = {}) {
  const attributed = attribution ?? Object.fromEntries(tests.map((t) => [t, provides]));
  const outcome = (name, bad) =>
    raising.includes(name)
      ? { outcome: "error", message: `FileNotFoundError: [Errno 44] No such file or directory: 'data.csv'` }
      : bad.includes(name)
        ? { outcome: "fail", message: `assert 'X' == 'Y' for ${name}` }
        : { outcome: "pass", message: null };
  const outcomes = (names, bad) => Object.fromEntries(names.map((t) => [t, outcome(t, bad)]));

  const settled = provides.filter((fn) => {
    const mine = tests.filter((t) => (attributed[t] ?? []).includes(fn));
    return mine.length > 0 && mine.every((t) => !failing.includes(t) && !raising.includes(t));
  });
  const chaffs = [];
  for (const fn of provides) {
    if (!settled.includes(fn)) continue;
    const mine = tests.filter((t) => (attributed[t] ?? []).includes(fn));
    for (const id of ["1", "2"]) {
      const key = `${fn}/${id}`;
      chaffs.push({
        id,
        targets: fn,
        loaded: true,
        tests: outcomes(mine, missed.includes(key) ? [] : mine),
        student_defines: defines,
      });
    }
  }
  return {
    ok: true,
    provides,
    attribution: attributed,
    wheats: [
      { id: "reference", loaded: true, tests: outcomes(tests, failing), student_defines: defines },
    ],
    chaffs,
    chaffs_skipped: provides.filter((fn) => !settled.includes(fn)),
  };
}

/** The card for one function, from the most recent run. */
const fnCard = (view, name) =>
  view.entries.filter((e) => e.kind === "examplar" && e.name === name).at(-1);

const withBundle = (extra = {}) => ({
  bundles: { [EX_URL]: { json: JSON.stringify({ examplar: 2 }) } },
  events: (kind) => (kind === "runFile" ? [{ kind: "done" }] : []),
  ...extra,
});
const EX_SRC = [`#examplar ${EX_URL}`, "", "def test_a():", '    assert shout("hi") == "HI!"'].join("\n");

console.log("\n[37] the workspace is unmounted while the known implementations run");
{
  // The decision this asserts: a bundle is code from a URL, so it must not
  // see - or be able to rewrite - the student's data files.
  files.set("file:/work/data.csv", "a,b\n1,2\n");
  const { repl, runtime, doc } = await harness(withBundle({ examplarResult: examplarReply() }));
  await repl.runFile(EX_SRC, "hw.py", doc);
  await settle();
  const seq = runtime.calls
    .filter((c) => c[0] === "mountWorkspaceFiles" || c[0] === "examplarRun")
    .map((c) => (c[0] === "examplarRun" ? "examplarRun" : `mount(${c[1] || "-"})`));
  console.log(`    ${seq.join(" -> ")}`);
  const at = seq.indexOf("examplarRun");
  expect(at > 0, `examplarRun should have happened, got ${seq.join(",")}`);
  expect(seq[at - 1] === "mount(-)", `the mount before it must be empty, got ${seq[at - 1]}`);
  expect(seq[at + 1] === "mount(data.csv)", `siblings must be restored after, got ${seq[at + 1]}`);
  files.clear();
  repl.dispose();
}

console.log("\n[38] a clean suite is reported as agreeing, with the bugs it caught");
{
  const { repl, view, doc } = await harness(
    withBundle({
      examplarResult: examplarReply({
        tests: ["test_shout", "test_total"],
        provides: ["shout", "total"],
        attribution: { test_shout: ["shout"], test_total: ["total"] },
      }),
    }),
  );
  await repl.runFile(EX_SRC, "hw.py", doc);
  await settle();
  // One card per provided function - that is the unit a student works in.
  const cards = view.entries.filter((e) => e.kind === "examplar");
  expect(
    cards.map((c) => c.name).join(",") === "shout,total",
    `expected a card per function, got ${JSON.stringify(cards.map((c) => c.name))}`,
  );
  for (const card of cards) {
    expect(card.allPass === true, `${card.name}: agrees with the correct implementations`);
    expect(card.testCount === 1, `${card.name}: only its own tests count, got ${card.testCount}`);
    expect(card.caught === 2 && card.total === 2, `${card.name}: caught ${card.caught}/${card.total}`);
    expect(card.missed.length === 0, `${card.name}: nothing missed`);
    expect(card.url === EX_URL && card.cached === true, "it records where the bundle came from");
  }
  console.log(`    ${cards.length} function card(s), each agreeing and catching 2 of 2`);
  repl.dispose();
}

console.log("\n[39] a test that disagrees is named, and nothing more");
{
  const { repl, view, doc } = await harness(
    withBundle({ examplarResult: examplarReply({ failing: ["test_a"] }) }),
  );
  await repl.runFile(EX_SRC, "hw.py", doc);
  await settle();
  const card = fnCard(view, "shout");
  expect(card.allPass === false, "a failure means the test is wrong");
  expect(card.failures.join(",") === "test_a", `named, got ${JSON.stringify(card.failures)}`);
  // The name, and *only* the name. `assert 'X' == 'Y'` states the correct
  // answer, so a card carrying it would let a student read the whole
  // specification off it, one deliberately-wrong test at a time.
  expect(
    !JSON.stringify(card).includes("assert"),
    `no assertion may reach the card, got ${JSON.stringify(card)}`,
  );
  expect(
    !JSON.stringify(card).includes("'Y'"),
    `nor the expected value, got ${JSON.stringify(card)}`,
  );
  // Phase two waits for phase one: a wrong test fails on everything, so a
  // coverage number here would flatter the student for their own bug.
  expect(card.pending === true, "coverage must not be reported next to a wrong test");
  expect(card.total === 0, `and nothing was even run, got ${card.total}`);
  console.log(`    named ${card.failures.join(", ")}, with nothing about the answer`);
  console.log("    coverage withheld until the suite is right");
  repl.dispose();
}

console.log("\n[40] a test that raised is not a test that is wrong");
{
  // The phase runs with the workspace unmounted, so a test that opens a data
  // file cannot work there. Reporting that as "you expect the wrong answer"
  // would be an accusation, and a false one.
  const { repl, view, doc } = await harness(
    withBundle({
      examplarResult: examplarReply({ tests: ["test_a", "test_b"], raising: ["test_a"] }),
    }),
  );
  await repl.runFile(EX_SRC, "hw.py", doc);
  await settle();
  const card = fnCard(view, "shout");
  expect(card.failures.length === 0, "an error is not a disagreement");
  expect(card.errors.length === 1, `one error, got ${card.errors.length}`);
  expect(card.errors[0].test === "test_a", `named: ${card.errors[0].test}`);
  expect(card.allPass === false, "and the suite is not clean either");
  expect(/files next to your program/.test(card.hint ?? ""), `expected the unmount hint, got ${card.hint}`);
  // A test that raised did not pass, so phase two waits for it just as it
  // does for one that disagreed. A suite is only a measuring instrument
  // once every test in it runs *and* agrees.
  expect(card.pending === true, "an error withholds coverage too");
  console.log(`    ${card.errors[0].test}: ${card.errors[0].message}`);
  console.log("    coverage withheld: an error is not a pass either");

  // And it holds up only its own function. A broken test of `total` used
  // to withhold `shout`'s coverage as well, which is what splitting the
  // cards by function is for.
  const split = await harness(
    withBundle({
      examplarResult: examplarReply({
        tests: ["test_shout", "test_total"],
        raising: ["test_total"],
        provides: ["shout", "total"],
        attribution: { test_shout: ["shout"], test_total: ["total"] },
        missed: ["shout/2"],
      }),
    }),
  );
  await split.repl.runFile(EX_SRC, "hw.py", split.doc);
  await settle();
  const shout = fnCard(split.view, "shout");
  const total = fnCard(split.view, "total");
  expect(!shout.pending && shout.caught === 1 && shout.missed.join(",") === "2",
    `shout should be scored regardless, got ${shout.caught}/${shout.total} missed=${shout.missed}`);
  expect(total.pending === true && total.errors.length === 1,
    "and total should be the one held back");
  console.log(`    shout: caught ${shout.caught} of ${shout.total}; total: waiting on its own test`);

  // A test that disagrees on one reference and raises on another is a
  // disagreement: that is the half the student can act on.
  const both = await harness(
    withBundle({
      examplarResult: (() => {
        const reply = examplarReply({ failing: ["test_a"] });
        reply.wheats.push({
          id: "alternative",
          loaded: true,
          tests: { test_a: { outcome: "error", message: "TypeError: nope" } },
          student_defines: [],
        });
        return reply;
      })(),
    }),
  );
  await both.repl.runFile(EX_SRC, "hw.py", both.doc);
  await settle();
  const mixed = fnCard(both.view, "shout");
  expect(mixed.failures.join(",") === "test_a", "counted once, as a disagreement");
  expect(mixed.pending === true, "and a disagreement gates coverage");
  expect(mixed.errors.length === 0, `and not also as an error, got ${JSON.stringify(mixed.errors)}`);
  // An error that is not about files gets no hint, since the hint would not
  // be true.
  expect(mixed.hint === undefined, `no hint here, got ${mixed.hint}`);
  console.log("    a mixed verdict is reported as the disagreement it is");
  repl.dispose();
  both.repl.dispose();
  split.repl.dispose();
}

console.log("\n[41] a missed chaff names the id and nothing else");
{
  const { repl, view, doc } = await harness(
    withBundle({ examplarResult: examplarReply({ missed: ["shout/2"] }) }),
  );
  await repl.runFile(EX_SRC, "hw.py", doc);
  await settle();
  const card = fnCard(view, "shout");
  expect(card.missed.join(",") === "2", `missed: ${card.missed}`);
  expect(card.caught === 1, `caught: ${card.caught}`);
  // The whole point of reporting only ids: no chaff message may leak.
  expect(
    !JSON.stringify(card).includes("assert"),
    `no chaff assertion may reach the card, got ${JSON.stringify(card)}`,
  );
  console.log(`    missed ${card.missed.join(", ")} with no hint as to why`);
  repl.dispose();
}

console.log("\n[42] tests-first is the normal case: a verdict, and no noise");
{
  const { repl, view, runtime, doc } = await harness(
    withBundle({ examplarResult: examplarReply({ defines: [] }), hasTests: true }),
  );
  await repl.runFile(EX_SRC, "hw.py", doc);
  await settle();
  expect(
    !runtime.calls.some((c) => c[0] === "runTests"),
    "their tests cannot run against an implementation they have not written",
  );
  // Silence, deliberately: writing tests before any implementation of your
  // own is the point, so there is nothing to explain. (A cache note can
  // still appear here, since the fixture has no server to reach.)
  const banners = view.entries.filter((e) => e.kind === "banner").map((e) => e.text);
  expect(
    banners.every((text) => /could not reach/.test(text)),
    `the offline note is the only banner allowed here, got ${JSON.stringify(banners)}`,
  );
  expect(
    view.entries.some((e) => e.kind === "examplar"),
    "the verdict card is the feedback, and it is still there",
  );

  // Once they have written it, their own tests run too.
  const second = await harness(
    withBundle({ examplarResult: examplarReply({ defines: ["shout"] }) }),
  );
  await second.repl.runFile(EX_SRC, "hw.py", second.doc);
  await settle();
  expect(
    second.runtime.calls.some((c) => c[0] === "hasTests"),
    "with an implementation present, the normal test path is reached",
  );
  console.log("    verdict with no implementation; own tests attempted once written");
  repl.dispose();
  second.repl.dispose();
}

console.log("\n[43] a broken bundle never stops the file from running");
{
  const two = [`#examplar ${EX_URL}`, `#examplar ${EX_URL}`, 'print("hi")'].join("\n");
  const dup = await harness(withBundle());
  await dup.repl.runFile(two, "hw.py", dup.doc);
  await settle();
  expect(
    dup.view.entries.some((e) => e.kind === "banner" && /more than one/.test(e.text)),
    "two directives should be reported",
  );
  expect(dup.runtime.calls.some((c) => c[0] === "runFile"), "and the file still runs");
  dup.repl.dispose();

  // Nothing cached and no network: a banner, and the file still runs.
  const cold = await harness({ events: () => [{ kind: "done" }] });
  await cold.repl.runFile(EX_SRC, "hw.py", cold.doc);
  await settle();
  expect(
    cold.view.entries.some(
      (e) => e.kind === "banner" && /Could not load the known implementations/.test(e.text),
    ),
    "an unreachable bundle should be reported",
  );
  expect(cold.runtime.calls.some((c) => c[0] === "runFile"), "and the file still runs");
  expect(
    !cold.view.entries.some((e) => e.kind === "examplar"),
    "with no verdict card, since there was no verdict",
  );

  // And a crash in the phase becomes a card with a problem, not a lost run.
  const boom = await harness(withBundle({ examplarThrows: true }));
  await boom.repl.runFile(EX_SRC, "hw.py", boom.doc);
  await settle();
  const card = boom.view.entries.find((e) => e.kind === "examplar" && e.card === "failed");
  expect(card?.problem === "boom", `expected the problem on the card, got ${card?.problem}`);
  expect(boom.runtime.calls.some((c) => c[0] === "runFile"), "and the file still runs");
  console.log("    duplicate directive, unreachable bundle, and a crash - file ran every time");
  cold.repl.dispose();
  boom.repl.dispose();
}

console.log("\n[44] no directive means no Examplar at all");
{
  const { repl, view, runtime, doc } = await harness({ events: () => [{ kind: "done" }] });
  await repl.runFile('print("plain")', "hw.py", doc);
  await settle();
  expect(!view.entries.some((e) => e.kind === "examplar"), "no card");
  expect(!runtime.calls.some((c) => c[0] === "examplarRun"), "and nothing is run");
  repl.dispose();
}

console.log("\n[45] a warning is shown and the file still runs");
{
  // Refusing to run a file over something that works - a helper nothing
  // calls, a method named but not called - would obstruct more than the
  // mistake does. Only an error stops the run.
  const doc = makeDoc("warn.py", "#level beginner\ndef check_total():\n    assert 1 == 1\n");
  const { repl, view, runtime } = await harness(
    {
      events: () => [{ kind: "stdout", text: "ran\n" }, { kind: "done" }],
      findings: [
        {
          id: "test-not-named",
          error_type: "NeverRun",
          message: "`check_total` has an `assert` in it, but nothing runs it",
          line_number: 2,
          column: 0,
          name_token: "check_total",
          scope_kind: "module",
        },
      ],
    },
    doc,
  );
  await repl.runFile(doc.getText(), "warn.py", doc);
  await settle();
  expect(
    view.entries.some((e) => e.kind === "finding" && e.finding.errorType === "NeverRun"),
    "the warning should be shown",
  );
  expect(
    !view.entries.some((e) => e.kind === "banner" && /was not run/.test(e.text)),
    `and nothing should say the file was skipped: ${JSON.stringify(view.entries.map((e) => e.text))}`,
  );
  expect(
    runtime.calls.some((c) => c[0] === "runFile"),
    "the file should still be run",
  );
  repl.dispose();
}

console.log("\n[46] an error still stops the file");
{
  const doc = makeDoc("blocked.py", "#level beginner\ndef test_total():\n    assert(1, 2)\n");
  const { repl, view, runtime } = await harness(
    {
      events: () => [{ kind: "done" }],
      findings: [
        {
          id: "assert-tuple",
          error_type: "AlwaysTrue",
          message: "this `assert` is always true",
          line_number: 3,
          column: 4,
          name_token: null,
          scope_kind: "function",
        },
      ],
    },
    doc,
  );
  await repl.runFile(doc.getText(), "blocked.py", doc);
  await settle();
  expect(
    view.entries.some((e) => e.kind === "banner" && /The file was not run/.test(e.text)),
    "an error should say the file was not executed",
  );
  expect(
    !runtime.calls.some((c) => c[0] === "runFile"),
    "and the file must not be run",
  );
  repl.dispose();
}

/* ---------------------------------------------------------------- */
/* Stopping between the phases of a run                             */
/* ---------------------------------------------------------------- */

/** Holds one step of a run open until the test opens it. */
function makeGate() {
  let open;
  const promise = new Promise((resolve) => {
    open = resolve;
  });
  return { promise, open: () => open() };
}

/** Wait for the run to reach a step, which may be past a slow fetch. */
async function untilStatus(view, status, ms = 10000) {
  const deadline = Date.now() + ms;
  while (view.status !== status && Date.now() < deadline) {
    await settle();
  }
  return view.status === status;
}

const bannerTexts = (view) => view.entries.filter((e) => e.kind === "banner").map((e) => e.text);
const called = (runtime, name) => runtime.calls.some((c) => c[0] === name);
/** Anything on the panel that reads as something having gone wrong. */
const complaints = (view) =>
  view.entries
    .filter((e) => (e.kind === "stderr" || e.kind === "banner") && /fail|error|could not/i.test(e.text))
    .map((e) => e.text);

const LOOPING_TESTS = [
  "def test_ok():",
  "    assert True",
  "",
  "def test_forever():",
  "    while True:",
  "        pass",
  "",
  'print("the program")',
].join("\n");

/** The report of a test phase that a Stop ended in `test_forever`. */
const stoppedReport = (fileName) => ({
  kind: "testReport",
  fileName,
  passed: 1,
  failed: 0,
  skipped: 0,
  errors: 0,
  stopped: true,
  stoppedIn: "test_forever",
  tests: [
    { name: "test_ok", outcome: "passed", lineNumber: 1, message: null, stdout: null },
    { name: "test_forever", outcome: "stopped", lineNumber: 4, message: null, stdout: null },
  ],
});

console.log("\n[47] a Stop during the tests ends the run, so the program does not start");
{
  // The bug: the Stop ended the looping test, the remaining tests ran, and
  // then the program ran - after the student had asked for it all to stop.
  const gate = makeGate();
  let stopTests = true;
  const doc = makeDoc("loops.py", LOOPING_TESTS);
  const { repl, view, runtime } = await harness(
    {
      events: () => [{ kind: "done" }],
      runTests: async (request, onEvent) => {
        await gate.promise;
        if (stopTests) {
          onEvent(stoppedReport(request.fileName));
        } else {
          onEvent({ kind: "testReport", fileName: request.fileName, passed: 2, failed: 0,
            skipped: 0, errors: 0, tests: [] });
        }
        onEvent({ kind: "done" });
      },
    },
    doc,
  );
  const run = repl.runFile(LOOPING_TESTS, "loops.py", doc);
  await settle();
  expect(view.status === "Running tests...", `the tests should be running, status ${view.status}`);
  view.handlers.onInterrupt();
  await settle();
  expect(called(runtime, "interrupt"), "the Stop should reach the runtime");
  gate.open();
  await run;
  await settle();
  expect(!called(runtime, "runFile"), "the program must not run after a stopped test phase");
  const report = view.entries.find((e) => e.kind === "testReport");
  expect(
    report?.stopped === true && report?.stoppedIn === "test_forever",
    `the report should say where it stopped: ${JSON.stringify(report)}`,
  );
  expect(
    bannerTexts(view).join("|") ===
      "Stopped during the tests. The rest of the tests and the program were not run.",
    `one banner, saying what did not run: ${JSON.stringify(bannerTexts(view))}`,
  );
  expect(view.busy === false, "and the session is free again");
  console.log(`    ${bannerTexts(view)[0]}`);

  // The Stop belonged to that run. The next one runs everything.
  stopTests = false;
  await repl.runFile(LOOPING_TESTS, "loops.py", doc);
  await settle();
  expect(called(runtime, "runFile"), "the next run should go on to the program");
  expect(bannerTexts(view).length === 0, `and say nothing about stopping: ${JSON.stringify(bannerTexts(view))}`);
  repl.dispose();
}

console.log("\n[48] a Stop as the last test finishes still keeps the program from starting");
{
  const gate = makeGate();
  const doc = makeDoc("loops.py", LOOPING_TESTS);
  const { repl, view, runtime } = await harness(
    {
      events: () => [{ kind: "done" }],
      // Every test finished before Python next looked for the Stop.
      runTests: async (request, onEvent) => {
        await gate.promise;
        onEvent({ kind: "testReport", fileName: request.fileName, passed: 2, failed: 0,
          skipped: 0, errors: 0, tests: [] });
        onEvent({ kind: "done" });
      },
    },
    doc,
  );
  const run = repl.runFile(LOOPING_TESTS, "loops.py", doc);
  await settle();
  view.handlers.onInterrupt();
  gate.open();
  await run;
  await settle();
  expect(!called(runtime, "runFile"), "the program must not run");
  // Not "during the tests": every one of them ran, and the card says so.
  expect(
    bannerTexts(view).join("|") === "Stopped after the tests. The program was not run.",
    `banners: ${JSON.stringify(bannerTexts(view))}`,
  );
  console.log(`    ${bannerTexts(view)[0]}`);
  repl.dispose();
}

console.log("\n[49] a Stop while pytest loads means no tests and no program");
{
  // Loading pytest takes seconds the first time, and runs nothing of the
  // student's, so a Stop then reaches no running Python at all.
  const gate = makeGate();
  const doc = makeDoc("loops.py", LOOPING_TESTS);
  const { repl, view, runtime } = await harness(
    { events: () => [{ kind: "done" }], ensurePytest: () => gate.promise },
    doc,
  );
  const run = repl.runFile(LOOPING_TESTS, "loops.py", doc);
  await settle();
  expect(view.status === "Loading pytest...", `pytest should be loading, status ${view.status}`);
  view.handlers.onInterrupt();
  gate.open();
  await run;
  await settle();
  expect(!called(runtime, "runTests"), "the tests must not start");
  expect(!called(runtime, "runFile"), "nor the program");
  expect(
    bannerTexts(view).join("|") ===
      "Stopped before the tests started. The tests and the program were not run.",
    `banners: ${JSON.stringify(bannerTexts(view))}`,
  );
  console.log(`    ${bannerTexts(view)[0]}`);

  // A load the Stop broke: there are then no tests to run, and still no
  // program - and no "Could not load pytest" either.
  const broken = makeGate();
  const second = await harness(
    {
      events: () => [{ kind: "done" }],
      ensurePytest: async () => {
        await broken.promise;
        throw new Error("Traceback (most recent call last):\nKeyboardInterrupt");
      },
    },
    doc,
  );
  const run2 = second.repl.runFile(LOOPING_TESTS, "loops.py", doc);
  expect(await untilStatus(second.view, "Loading pytest..."), "pytest should be loading");
  second.view.handlers.onInterrupt();
  broken.open();
  await run2;
  await settle();
  expect(!called(second.runtime, "runFile"), "the program must not run");
  expect(complaints(second.view).length === 0, `a Stop is not a failure: ${JSON.stringify(complaints(second.view))}`);
  expect(
    bannerTexts(second.view).join("|") === "Stopped before the program started.",
    `banners: ${JSON.stringify(bannerTexts(second.view))}`,
  );
  console.log(`    and when the Stop broke the load: ${bannerTexts(second.view)[0]}`);
  second.repl.dispose();
  repl.dispose();
}

console.log("\n[50] a Stop during the Examplar check: no tests, no program, no failed card");
{
  const gate = makeGate();
  const { repl, view, runtime, doc } = await harness(
    withBundle({
      examplarResult: examplarReply({ defines: ["shout"] }),
      // As the worker reports a Stop in the student's tests: a traceback.
      examplarRun: async () => {
        await gate.promise;
        throw new Error("Traceback (most recent call last):\nKeyboardInterrupt");
      },
    }),
  );
  const run = repl.runFile(EX_SRC, "hw.py", doc);
  expect(await untilStatus(view, "Checking your tests..."), `the check should be running, status ${view.status}`);
  view.handlers.onInterrupt();
  gate.open();
  await run;
  await settle();
  expect(
    !view.entries.some((e) => e.kind === "examplar" && e.card === "failed"),
    "the Stop is not a reason the check failed",
  );
  expect(!called(runtime, "runTests"), "the student's own tests must not run");
  expect(!called(runtime, "runFile"), "nor the program");
  expect(
    bannerTexts(view).filter((t) => !/could not reach/.test(t)).join("|") ===
      "Stopped while checking your tests. Your own tests and the program were not run.",
    `banners: ${JSON.stringify(bannerTexts(view))}`,
  );
  // The check unmounts the student's files, and they must come back even
  // though the run ends here.
  const mounts = runtime.calls.filter((c) => c[0] === "mountWorkspaceFiles");
  expect(mounts.length >= 3, `the workspace should be mounted again after the check: ${JSON.stringify(mounts)}`);
  console.log(`    ${bannerTexts(view).at(-1)}`);

  // Pressed while pytest loaded for the check: the check does not start.
  const early = makeGate();
  const second = await harness(
    withBundle({ examplarResult: examplarReply(), ensurePytest: () => early.promise }),
  );
  const run2 = second.repl.runFile(EX_SRC, "hw.py", second.doc);
  expect(await untilStatus(second.view, "Checking your tests..."), "pytest should be loading for the check");
  second.view.handlers.onInterrupt();
  early.open();
  await run2;
  await settle();
  expect(!called(second.runtime, "examplarRun"), "the check must not start once Stop is pressed");
  expect(!called(second.runtime, "runFile"), "nor the program");
  expect(
    bannerTexts(second.view).some((t) => t.startsWith("Stopped while checking your tests.")),
    `banners: ${JSON.stringify(bannerTexts(second.view))}`,
  );
  second.repl.dispose();
  repl.dispose();
}

console.log("\n[51] a Stop before the program starts: nothing runs, and nothing complains");
{
  // While the files next to it load.
  const gate = makeGate();
  const doc = makeDoc("loops.py", LOOPING_TESTS);
  const { repl, view, runtime } = await harness(
    { events: () => [{ kind: "done" }], mountWorkspaceFiles: () => gate.promise },
    doc,
  );
  const run = repl.runFile(LOOPING_TESTS, "loops.py", doc);
  await settle();
  expect(view.status === "Loading files...", `files should be loading, status ${view.status}`);
  view.handlers.onInterrupt();
  gate.open();
  await run;
  await settle();
  expect(!called(runtime, "runTests") && !called(runtime, "runFile"), "nothing may run");
  expect(
    bannerTexts(view).join("|") === "Stopped before the program started. Nothing was run.",
    `banners: ${JSON.stringify(bannerTexts(view))}`,
  );
  console.log(`    ${bannerTexts(view)[0]}`);

  // During the static checks, which the Stop interrupts: their failure is
  // the Stop, not a broken analyzer. (Only a level with checks has any.)
  const checked = `#level beginner\n${LOOPING_TESTS}`;
  const checkedDoc = makeDoc("checked.py", checked);
  const checking = makeGate();
  const second = await harness(
    {
      events: () => [{ kind: "done" }],
      staticAnalyze: async () => {
        await checking.promise;
        throw new Error("Traceback (most recent call last):\nKeyboardInterrupt");
      },
    },
    checkedDoc,
  );
  const run2 = second.repl.runFile(checked, "checked.py", checkedDoc);
  await settle();
  expect(second.view.status === "Checking...", `the checks should be running, status ${second.view.status}`);
  second.view.handlers.onInterrupt();
  checking.open();
  await run2;
  await settle();
  expect(!called(second.runtime, "runFile"), "the program must not run");
  expect(
    complaints(second.view).length === 0,
    `a Stop is not a failure: ${JSON.stringify(complaints(second.view))}`,
  );
  expect(
    bannerTexts(second.view).join("|") === "Stopped before the program started. Nothing was run.",
    `banners: ${JSON.stringify(bannerTexts(second.view))}`,
  );
  console.log("    and during the static checks, without \"Static analysis failed\"");

  // While packages load, when the Stop breaks the load.
  const imports = `import numpy\n${LOOPING_TESTS}`;
  const importsDoc = makeDoc("imports.py", imports);
  const loading = makeGate();
  const third = await harness(
    {
      events: () => [{ kind: "done" }],
      ensurePackages: async () => {
        await loading.promise;
        throw new Error("Traceback (most recent call last):\nKeyboardInterrupt");
      },
    },
    importsDoc,
  );
  const run3 = third.repl.runFile(imports, "imports.py", importsDoc);
  expect(await untilStatus(third.view, "Loading libraries..."), `libraries should be loading, status ${third.view.status}`);
  third.view.handlers.onInterrupt();
  loading.open();
  await run3;
  await settle();
  expect(!called(third.runtime, "runTests") && !called(third.runtime, "runFile"), "nothing may run");
  expect(complaints(third.view).length === 0, `a Stop is not a failure: ${JSON.stringify(complaints(third.view))}`);
  expect(
    bannerTexts(third.view).join("|") === "Stopped before the program started. Nothing was run.",
    `banners: ${JSON.stringify(bannerTexts(third.view))}`,
  );
  console.log("    and while libraries load, without \"Could not load libraries\"");
  third.repl.dispose();
  second.repl.dispose();
  repl.dispose();
}

console.log("\n[52] a run that fails because of a Stop is not an internal error");
{
  const gate = makeGate();
  const { repl, view, doc } = await harness({
    events: (kind) =>
      kind === "runFile"
        ? [
            async () => {
              await gate.promise;
              throw new Error("Traceback (most recent call last):\nKeyboardInterrupt");
            },
          ]
        : [{ kind: "done" }],
  });
  const run = repl.runFile("while True:\n    pass\n", "hello.py", doc);
  await settle();
  view.handlers.onInterrupt();
  gate.open();
  await run;
  await settle();
  expect(complaints(view).length === 0, `no internal error: ${JSON.stringify(complaints(view))}`);
  expect(bannerTexts(view).join("|") === "Stopped.", `banners: ${JSON.stringify(bannerTexts(view))}`);
  console.log(`    ${bannerTexts(view)[0]}`);
  repl.dispose();
}

console.log("\n[53] at the prompt, a Stop before the input runs means it does not run");
{
  const gate = makeGate();
  const { repl, view, runtime } = await harness({
    events: () => [{ kind: "result", repr: "2" }, { kind: "done" }],
    mountWorkspaceFiles: () => gate.promise,
  });
  view.handlers.onSubmit("1 + 1");
  await settle();
  expect(view.busy === true, "the input should be on its way");
  view.handlers.onInterrupt();
  gate.open();
  await settle();
  await settle();
  expect(!called(runtime, "replEval"), "the input must not run");
  expect(
    bannerTexts(view).join("|") === "Stopped. Your input was not run.",
    `banners: ${JSON.stringify(bannerTexts(view))}`,
  );
  expect(view.busy === false, "and the prompt is free again");
  console.log(`    ${bannerTexts(view)[0]}`);
  repl.dispose();
}

console.log("\n[54] after going back, Play plays again - even once stop_when has stopped it");
{
  const steps = (runtime) => runtime.calls.filter((c) => c[0] === "reactorStep").length;
  for (const stopAt of [undefined, 2]) {
    const { repl, view, runtime, doc } = await harness(countingReactor({ stopAt }));
    await repl.runFile("animate(...)", "hello.py", doc);
    await new Promise((r) => setTimeout(r, 300));
    view.handlers.onReactorControl("r1", stopAt ? "back" : "pause", 0);
    view.handlers.onReactorControl("r1", "seek", 0);
    await settle();
    const card = view.entries.find((e) => e.kind === "reactor");
    expect(card.stopped === false, `an earlier frame is not a stopped one: ${card.stopped}`);
    const before = steps(runtime);
    view.handlers.onReactorControl("r1", "play");
    await new Promise((r) => setTimeout(r, 150));
    const label = stopAt ? "after stop_when" : "after a pause";
    expect(card.playing === true || stopAt, `${label}: Play should be playing`);
    expect(steps(runtime) > before, `${label}: Play should tick again, got ${steps(runtime) - before} ticks`);
    repl.dispose();
  }
  console.log("    Play resumes from an earlier frame, stopped or not");
}

console.log("\n[55] an error in a reactor's handler is a finding, like any other");
{
  // It used to be shown as Python's raw traceback, through PLL's own
  // frames - the one runtime error that never got PLL's wording.
  const code = "def tick(n: int) -> int:\n    return n + undefined_step\n\nanimate(draw)\n";
  const doc = makeDoc("anim.py", code);
  const { repl, view } = await harness(
    countingReactor({
      script: {
        reactorStep: () => ({
          ok: false,
          error_type: "NameError",
          error_message: "name 'undefined_step' is not defined",
          traceback: "Traceback ...",
          error_file: "anim.py",
          line_number: 2,
          column: 15,
          error_frames: [
            { file: "<exec>", line: 400, column: null, function: "_pll_reactor_step", user: false },
            { file: "anim.py", line: 2, column: 15, function: "tick", user: true },
          ],
          error_facts: { name: "undefined_step" },
        }),
      },
    }),
    doc,
  );
  await repl.runFile(code, "anim.py", doc);
  await new Promise((r) => setTimeout(r, 100));
  expect(!view.entries.some((e) => e.kind === "rawError"), "no raw traceback");
  const finding = view.entries.find((e) => e.kind === "finding")?.finding;
  expect(
    finding?.headline === "Python doesn't know what `undefined_step` means.",
    `explained against the program: ${finding?.headline}`,
  );
  expect(finding?.location?.label === "anim.py:2:16", `at the handler's line: ${finding?.location?.label}`);
  const card = view.entries.find((e) => e.kind === "reactor");
  expect(card?.playing === false, "and the clock stops");
  console.log(`    ${finding?.headline} (${finding?.location?.label})`);
  repl.dispose();
}

console.log("\n[56] a test's error is explained in the card, as the run's would be");
{
  const code = 'def add(xs):\n    return xs + "!"\n\ndef test_add():\n    assert add([1]) == [1]\n';
  const doc = makeDoc("t.py", code);
  const { repl, view } = await harness(
    {
      events: () => [{ kind: "done" }],
      runTests: async (request, onEvent) => {
        onEvent({
          kind: "testReport",
          fileName: request.fileName,
          passed: 0,
          failed: 0,
          skipped: 0,
          errors: 1,
          tests: [
            {
              name: "test_add",
              outcome: "error",
              lineNumber: 4,
              message: 'TypeError: can only concatenate list (not "str") to list',
              stdout: null,
              error: errorEvent({
                type: "TypeError",
                message: 'can only concatenate list (not "str") to list',
                file: "t.py",
                line: 2,
                frames: [["t.py", 5, "test_add"], ["t.py", 2, "add"]],
              }).error,
            },
          ],
        });
        onEvent({ kind: "done" });
      },
    },
    doc,
  );
  await repl.runFile(code, "t.py", doc);
  await settle();
  const test = view.entries.find((e) => e.kind === "testReport")?.tests?.[0];
  expect(
    test?.finding?.headline === "A list and a string cannot be added together.",
    `the editor explains it: ${JSON.stringify(test?.finding)}`,
  );
  expect(test?.finding?.location?.label === "t.py:2", `in \`add\`: ${test?.finding?.location?.label}`);
  expect(test?.error === undefined, "and the webview is sent the finding, not the exception");
  console.log(`    ${test?.finding?.errorType}: ${test?.finding?.headline}`);
  repl.dispose();
}

console.log("\n[57] a top-level error in a file with tests is reported once");
{
  // The test phase loads the file to find its tests, so it meets the error
  // first; the program then raises it again. The editor showed both, while
  // the command line - which had its own copy of the run - showed one.
  const code = "x = 1 / 0\n\ndef test_a():\n    assert True\n";
  const doc = makeDoc("top.py", code);
  const failure = errorEvent({
    type: "ZeroDivisionError",
    message: "division by zero",
    file: "top.py",
    line: 1,
    frames: [["top.py", 1]],
  });
  const { repl, view } = await harness(
    {
      events: (kind) => (kind === "runFile" ? [failure, { kind: "done" }] : [{ kind: "done" }]),
      runTests: async (_request, onEvent) => {
        onEvent(failure);
        onEvent({ kind: "done" });
      },
    },
    doc,
  );
  await repl.runFile(code, "top.py", doc);
  await settle();
  const findings = view.entries.filter((e) => e.kind === "finding");
  expect(findings.length === 1, `one finding, from the program: ${findings.length}`);
  console.log(`    ${findings.length} finding: ${findings[0]?.finding.headline}`);
  repl.dispose();
}

console.log("\n[58] files that could not be mounted are not written back");
{
  const doc = makeDoc("nofiles.py", "print(1)\n");
  const { repl, runtime } = await harness(
    {
      events: () => [{ kind: "done" }],
      mountWorkspaceFiles: async () => {
        throw new Error("no room");
      },
    },
    doc,
  );
  await repl.runFile("print(1)\n", "nofiles.py", doc);
  await settle();
  expect(runtime.calls.some((c) => c[0] === "runFile"), "the program still runs");
  expect(
    !runtime.calls.some((c) => c[0] === "collectWorkspaceFiles"),
    "but nothing it wrote is copied back over the student's files",
  );
  repl.dispose();
}

console.log(`\nsmoke-repl-session: ${ok ? "ok" : "FAILED"}`);
if (!ok) {
  process.exit(1);
}
