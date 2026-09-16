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
 * run should emit; `script.findings` is what staticAnalyze returns.
 */
function makeRuntime(script = {}) {
  const calls = [];
  let stdinHandler = null;
  const runtime = {
    calls,
    get stdinHandler() {
      return stdinHandler;
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
      if (script.pytestFails) throw new Error("no pytest wheel");
    },
    async runTests(request, onEvent) {
      calls.push(["runTests", request.fileName]);
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
      if (script.packagesFail) throw new Error("network down");
    },
    async staticAnalyze(request) {
      calls.push(["staticAnalyze", request.fileName, request.level, request.sessionKey]);
      return script.findings ?? [];
    },
    async mountWorkspaceFiles(files) {
      calls.push(["mountWorkspaceFiles", files.map((f) => f.name).join("|")]);
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
async function harness(script = {}, doc = makeDoc("hello.py")) {
  __setActiveEditor(doc ? { document: doc } : undefined);
  const runtime = makeRuntime(script);
  const view = makeView();
  const diagnostics = makeDiagnostics();
  const repl = new ReplSession({ runtime, view, diagnostics });
  await settle();
  return { repl, runtime, view, diagnostics, doc };
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
    view.entries.at(-1).text === "Static analysis found issues. File not executed.",
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
    view.entries.at(-1).text === "Static analysis found issues. Input not executed.",
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
        {
          kind: "error",
          errorType: "NameError",
          message: "name 'total' is not defined",
          traceback: 'File "oops.py", line 1\nNameError: name \'total\' is not defined',
          lineNumber: 1,
          column: null,
          fileName: "oops.py",
        },
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

console.log("\n[9] an unrecognized error falls back to the raw traceback");
{
  const doc = makeDoc("boom.py", "1/0\n");
  const { repl, view } = await harness(
    {
      events: () => [
        {
          kind: "error",
          errorType: "ZeroDivisionError",
          message: "division by zero",
          traceback: "Traceback...\nZeroDivisionError: division by zero",
          lineNumber: 1,
          column: null,
          fileName: "boom.py",
        },
        { kind: "done" },
      ],
    },
    doc,
  );
  await repl.runFile("1/0\n", "boom.py", doc);
  await settle();
  const raw = view.entries.find((e) => e.kind === "rawError");
  expect(!!raw, "an error with no analyzer should show the raw traceback");
  expect(raw.errorType === "ZeroDivisionError", "the error type should be preserved");
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
  files.set("file:/work/photo.png", "binary-ish");
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
  expect(mount[1] === "cars.csv", "only mountable siblings should be sent, got " + mount[1]);
  expect(
    written.get("file:/work/out.csv") === "a,b\n1,2\n",
    "changed files should be written next to the script",
  );
  expect(
    view.entries.some((e) => e.kind === "banner" && e.text === "Saved out.csv next to this file."),
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
    texts(view, "stderr").some((t) => /analyzer exploded/.test(t)),
    "the failure should be visible, got " + JSON.stringify(texts(view, "stderr")),
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

console.log(`\nsmoke-repl-session: ${ok ? "ok" : "FAILED"}`);
if (!ok) {
  process.exit(1);
}
