#!/usr/bin/env node
/**
 * Smoke test for the shared worker protocol client
 * (`src/common/workerRuntime.ts`), which both hosts subclass.
 *
 * Drives a real `WorkerPythonRuntime` against a scripted in-process worker,
 * so no Pyodide is involved: this checks request/reply correlation, error
 * propagation, live display streaming, and the stdin round-trip.
 */
import { expect, passed } from "./lib/check.mjs";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { importSource, ROOT } from "./lib/bundle.mjs";

/** Let the runtime's internal `await initialize()` hops settle. */
const tick = () => new Promise((r) => setTimeout(r, 0));

async function rejects(promise, pattern, msg) {
  try {
    await promise;
  } catch (err) {
    expect(pattern.test(err.message), `${msg} (got "${err.message}")`);
    return;
  }
  expect(false, `${msg} (resolved instead of rejecting)`);
}

async function load() {
  const mod = await importSource(`
export { WorkerPythonRuntime } from "./src/common/workerRuntime";
export { createWorkerHost } from "./src/common/workerHost";
export { onceSuccessful } from "./src/common/onceSuccessful";
export * as stdin from "./src/common/stdinBuffer";
export { StoppedError } from "./src/common/runtimeErrors";
`);
  return mod;
}

const { WorkerPythonRuntime, createWorkerHost, onceSuccessful, stdin, StoppedError } = await load();

/**
 * A runtime whose "worker" is a function the test controls. `respond` is
 * called for every outbound message; the test replies via `handlers`.
 */
function makeRuntime(respond) {
  const sent = [];
  let handlers = null;
  let terminated = false;

  class TestRuntime extends WorkerPythonRuntime {
    resolveIndexUrl() {
      return "/fake/index/";
    }
    spawn(h) {
      handlers = h;
      return {
        post: (msg) => {
          sent.push(msg);
          respond(msg, h);
        },
        terminate: () => {
          terminated = true;
        },
      };
    }
  }

  return {
    runtime: new TestRuntime(),
    sent,
    reply: (msg) => handlers.onMessage(msg),
    fail: (err) => handlers.onError(err),
    /** The worker dies, as a crashed Node worker does. */
    exit: () => handlers.onExit?.(),
    get terminated() {
      return terminated;
    },
  };
}

/** Answer `init` immediately and hand everything else to `custom`. */
function autoInit(custom = () => {}) {
  return (msg, h) => {
    if (msg.type === "init") {
      h.onMessage({ id: msg.id, type: "ready" });
      return;
    }
    custom(msg, h);
  };
}

const RESULT = {
  ok: true,
  stdout: "",
  stderr: "",
  result_repr: null,
  error_type: null,
  error_message: null,
  traceback: null,
  line_number: null,
  column: null,
  displays: [],
};

console.log("\n[0] Python's result shapes are read in one place");
{
  // `wire.ts` describes what Python sends; past the protocol, only
  // `fromPython.ts` reads it, and everything else uses the host's types.
  const ALLOWED = new Set(["src/common/fromPython.ts", "src/common/workerHost.ts", "src/common/workerProtocol.ts"]);
  const readers = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (rel.endsWith(".ts") && /from "(\.\.?\/)+(common\/)?wire"/.test(readFileSync(join(ROOT, rel), "utf8"))) readers.push(rel);
    }
  };
  walk("src");
  const strays = readers.filter((rel) => !ALLOWED.has(rel));
  expect(strays.length === 0, `only the protocol and fromPython import wire.ts: ${strays.join(", ")}`);
  expect(readers.includes("src/common/fromPython.ts"), `the check sees the imports at all: ${readers.join(", ")}`);
}

console.log("\n[1] init sends the index URL and a stdin buffer");
{
  const h = makeRuntime(autoInit());
  await h.runtime.initialize();
  await h.runtime.initialize(); // second call must not re-init
  const inits = h.sent.filter((m) => m.type === "init");
  console.log(`    init messages: ${inits.length}`);
  expect(inits.length === 1, "initialize() should be idempotent, sent " + inits.length);
  expect(inits[0].indexUrl === "/fake/index/", "init should carry the resolved index URL");
  expect(
    inits[0].stdinBuffer instanceof SharedArrayBuffer,
    "init should carry a SharedArrayBuffer for input()",
  );
}

console.log("\n[2] replies are matched by id, even out of order");
{
  const held = [];
  const h = makeRuntime(
    autoInit((msg) => {
      if (msg.type === "checkSyntax") held.push(msg);
    }),
  );
  await h.runtime.initialize();
  const first = h.runtime.checkReplComplete("if True:");
  const second = h.runtime.checkReplComplete("1 + 1");
  await tick();
  expect(held.length === 2, "both requests should reach the worker");
  // Answer the second request first.
  h.reply({ id: held[1].id, type: "syntax", result: { status: "complete" } });
  h.reply({ id: held[0].id, type: "syntax", result: { status: "incomplete", lineno: 1 } });
  const [a, b] = await Promise.all([first, second]);
  console.log(`    first=${a.status} second=${b.status}`);
  expect(a.status === "incomplete", "first call should get its own reply, got " + a.status);
  expect(b.status === "complete", "second call should get its own reply, got " + b.status);
  expect(a.lineNumber === 1, "snake_case reply fields should be mapped, got " + a.lineNumber);
}

console.log("\n[3] an error reply rejects with the worker's message");
{
  const h = makeRuntime(
    autoInit((msg, hs) => {
      hs.onMessage({ id: msg.id, type: "error", message: "boom in Python", kind: "failed" });
    }),
  );
  await h.runtime.initialize();
  await rejects(
    h.runtime.hasTests("x"),
    /boom in Python/,
    "error reply should reject with the message",
  );
}

console.log("\n[4] a mismatched reply type is reported, not silently accepted");
{
  const h = makeRuntime(
    autoInit((msg, hs) => {
      hs.onMessage({ id: msg.id, type: "pytestReady" });
    }),
  );
  await h.runtime.initialize();
  await rejects(
    h.runtime.collectWorkspaceFiles(),
    /replied "pytestReady", expected "workspaceFiles"/,
    "wrong reply type should reject",
  );
}

console.log("\n[5] live displays stream during runFile, and only during a run");
{
  const h = makeRuntime(
    autoInit((msg, hs) => {
      if (msg.type === "runFile") {
        hs.onMessage({ type: "display", requestId: msg.id, payload: { type: "stdout", text: "Name: " } });
        hs.onMessage({
          type: "display",
          requestId: msg.id,
          payload: { type: "image", data: "<svg/>", width: 2, height: 3 },
        });
        hs.onMessage({
          id: msg.id,
          type: "result",
          result: { ...RESULT, result_repr: "42" },
        });
      }
    }),
  );
  await h.runtime.initialize();

  // Displays arriving outside a run have nowhere to go; must not throw.
  h.reply({ type: "display", requestId: 999, payload: { type: "stdout", text: "ignored" } });

  const events = [];
  await h.runtime.runFile(
    { code: 'input("Name: ")', fileName: "input.py", sessionKey: "s1" },
    (e) => events.push(e),
  );
  const kinds = events.map((e) => e.kind);
  console.log(`    events: ${kinds.join(", ")}`);
  expect(
    kinds.join(",") === "stdout,image,result,done",
    "live displays should arrive before the batched result, got " + kinds.join(","),
  );
  expect(events[0].text === "Name: ", "prompt text should survive the round-trip");
  expect(events[1].source === "input.py", "images should be captioned with the file name");
  expect(events[2].repr === "42", "result_repr should become a result event");

  // After the run the sink is detached again.
  const before = events.length;
  const runId = h.sent.find((m) => m.type === "runFile").id;
  h.reply({ type: "display", requestId: runId, payload: { type: "stdout", text: "late" } });
  expect(events.length === before, "displays after the run should be dropped");
}

console.log("\n[5b] a reactor step streams its handlers' output too");
{
  // Live output is listened for during a reactor step, not only during a
  // file run, or a handler's `print` would reach nobody.
  const h = makeRuntime(
    autoInit((msg, hs) => {
      if (msg.type === "reactorStep") {
        hs.onMessage({ type: "display", requestId: msg.id, payload: { type: "stdout", text: "tick 0\n" } });
        hs.onMessage({
          id: msg.id,
          type: "reactorFrame",
          result: { ok: true, index: 1, length: 2, frame: { data: "<svg/>", width: 1, height: 1 } },
        });
      }
    }),
  );
  await h.runtime.initialize();
  const events = [];
  const reply = await h.runtime.reactorStep("r1", '{"kind":"tick"}', {
    onEvent: (e) => events.push(e),
    fileName: "rx.py",
  });
  expect(reply.kind === "frame" && reply.index === 1, `the frame still comes back: ${JSON.stringify(reply)}`);
  expect(
    events.map((e) => `${e.kind}:${e.text}`).join("|") === "stdout:tick 0\n",
    `the print is delivered: ${JSON.stringify(events)}`,
  );
  const before = events.length;
  const stepId = h.sent.find((m) => m.type === "reactorStep").id;
  h.reply({ type: "display", requestId: stepId, payload: { type: "stdout", text: "late" } });
  expect(events.length === before, "and nothing after the step is");
}

console.log("\n[5c] output goes to the request it belongs to");
{
  // Two requests in flight: a run's output must not reach a reactor's sink.
  let stepId = null;
  const h = makeRuntime(
    autoInit((msg, hs) => {
      if (msg.type === "reactorStep") stepId = msg.id;
      if (msg.type === "runFile") {
        hs.onMessage({ type: "display", requestId: msg.id, payload: { type: "stdout", text: "run\n" } });
        hs.onMessage({ id: msg.id, type: "result", result: RESULT });
        hs.onMessage({
          id: stepId,
          type: "reactorFrame",
          result: { ok: true, index: 1, length: 2, frame: { data: "<svg/>", width: 1, height: 1 } },
        });
      }
    }),
  );
  await h.runtime.initialize();
  const stepEvents = [];
  const step = h.runtime.reactorStep("r1", '{"kind":"tick"}', { onEvent: (e) => stepEvents.push(e), fileName: "rx.py" });
  const runEvents = [];
  await h.runtime.runFile({ code: "x", fileName: "a.py", sessionKey: "s" }, (e) => runEvents.push(e));
  await step;
  expect(runEvents.some((e) => e.kind === "stdout" && e.text === "run\n"), "the run gets its output");
  expect(stepEvents.length === 0, `the step does not: ${JSON.stringify(stepEvents)}`);
}

console.log("\n[6] a failed run becomes an error event, then done");
{
  const h = makeRuntime(
    autoInit((msg, hs) => {
      hs.onMessage({
        id: msg.id,
        type: "result",
        result: {
          ...RESULT,
          ok: false,
          error_type: "NameError",
          error_message: "name 'x' is not defined",
          traceback: "Traceback...\nNameError: name 'x' is not defined",
          line_number: 3,
        },
      });
    }),
  );
  await h.runtime.initialize();
  const events = [];
  await h.runtime.replEval({ code: "x", sessionKey: "s1" }, (e) => events.push(e));
  console.log(`    events: ${events.map((e) => e.kind).join(", ")}`);
  expect(
    events.map((e) => e.kind).join(",") === "error,done",
    "a failed run should emit error then done",
  );
  expect(events[0].error.lineNumber === 3, "line number should be carried through");
  expect(
    events[0].error.errorType === "NameError" && events[0].error.frames.length === 0,
    "the error should arrive whole, with no frames when Python sent none",
  );
  expect(events[0].fileName === "<repl>", "replEval should label events <repl>");
}

console.log("\n[7] stdinRequest asks the host and writes the bytes into the SAB");
{
  const h = makeRuntime(autoInit());
  await h.runtime.initialize();
  const sab = h.sent.find((m) => m.type === "init").stdinBuffer;
  const state = new Int32Array(sab);
  /** Stand in for the worker: start request `n`, as `waitForStdin` does. */
  const waitAs = (n) => {
    Atomics.store(state, stdin.STDIN_REQUEST_INDEX, n);
    Atomics.store(state, stdin.STDIN_STATE_INDEX, stdin.STDIN_STATE_WAITING);
    h.reply({ type: "stdinRequest", request: n });
  };
  const payload = () => {
    const n = Atomics.load(state, stdin.STDIN_LENGTH_INDEX);
    const bytes = new Uint8Array(n);
    bytes.set(new Uint8Array(sab, stdin.STDIN_PAYLOAD_OFFSET, n));
    return bytes;
  };

  h.runtime.setStdinHandler(async () => "Ada\n");
  waitAs(1);
  await tick();
  expect(
    Atomics.load(state, stdin.STDIN_STATE_INDEX) === stdin.STDIN_STATE_DATA,
    "answering a read should store the DATA state",
  );
  const line = new TextDecoder().decode(payload());
  console.log(`    line=${JSON.stringify(line)}`);
  expect(line === "Ada\n", "the text should land in the buffer exactly, got " + JSON.stringify(line));

  // Bytes too: what a program reads is what it was given.
  h.runtime.setStdinHandler(async () => new Uint8Array([0xff, 0x00, 0x41]));
  waitAs(2);
  await tick();
  expect(payload().join() === "255,0,65", `bytes are given as they are: ${payload()}`);

  // More than the buffer holds is given over several requests, all of it.
  const big = new Uint8Array(stdin.STDIN_SAB_BYTES * 2 + 5).fill(0x61);
  let asked = 0;
  h.runtime.setStdinHandler(async () => (asked++ === 0 ? big : null));
  let received = 0;
  for (let n = 3; n < 10; n++) {
    waitAs(n);
    await tick();
    if (Atomics.load(state, stdin.STDIN_STATE_INDEX) === stdin.STDIN_STATE_EOF) break;
    received += payload().length;
  }
  expect(received === big.length && asked === 2, `a big chunk is given whole, in pieces: ${received} of ${big.length}`);

  // A Stop while the host waits ends the read; what comes after is kept
  // for the next one, as a terminal keeps a line typed after Ctrl+C.
  let answer;
  h.runtime.setStdinHandler(() => new Promise((resolve) => (answer = resolve)));
  waitAs(20);
  await tick();
  h.runtime.interrupt();
  expect(
    Atomics.load(state, stdin.STDIN_STATE_INDEX) === stdin.STDIN_STATE_INTERRUPTED,
    "a Stop during a read ends it as interrupted",
  );
  answer("late\n");
  await tick();
  expect(
    Atomics.load(state, stdin.STDIN_STATE_INDEX) === stdin.STDIN_STATE_INTERRUPTED,
    "an answer to a read a Stop ended is not given to it",
  );
  waitAs(21);
  await tick();
  expect(new TextDecoder().decode(payload()) === "late\n", "but to the next read");

  // A program that caught the Stop and asks again: the read still waiting
  // answers that request, and nothing is held for the one after.
  let answerAgain;
  let asks = 0;
  h.runtime.setStdinHandler(() => {
    asks++;
    return new Promise((resolve) => (answerAgain = resolve));
  });
  waitAs(30);
  await tick();
  h.runtime.interrupt();
  waitAs(31);
  await tick();
  answerAgain("again\n");
  await tick();
  expect(
    Atomics.load(state, stdin.STDIN_STATE_INDEX) === stdin.STDIN_STATE_DATA &&
      new TextDecoder().decode(payload()) === "again\n" &&
      asks === 1,
    `the line answers the read asked since: ${new TextDecoder().decode(payload())}, ${asks} asks`,
  );
  h.runtime.setStdinHandler(async () => "fresh\n");
  waitAs(32);
  await tick();
  expect(new TextDecoder().decode(payload()) === "fresh\n", "and is not given twice");

  // A handler that throws must still unblock the worker, with EOF.
  h.runtime.setStdinHandler(async () => {
    throw new Error("cancelled");
  });
  waitAs(22);
  await tick();
  expect(
    Atomics.load(state, stdin.STDIN_STATE_INDEX) === stdin.STDIN_STATE_EOF,
    "a failing stdin handler should send EOF rather than hang the worker",
  );

  // So must no handler at all.
  h.runtime.setStdinHandler(null);
  waitAs(23);
  await tick();
  expect(
    Atomics.load(state, stdin.STDIN_STATE_INDEX) === stdin.STDIN_STATE_EOF,
    "no stdin handler should send EOF",
  );
}

console.log("\n[7b] a Python that never starts is given up on, if the host sets a limit");
{
  // Pyodide failing to load can report it and never settle.
  const h = makeRuntime(() => {});
  h.runtime.startTimeoutMs = 50;
  let failure = null;
  await h.runtime.initialize().catch((err) => (failure = err));
  expect(/did not start within/.test(failure?.message ?? ""), `the start fails, and says why: ${failure?.message}`);
  expect(h.terminated, "and the worker is ended");
  // Without a limit, it waits: the editor, where Stop is there to press.
  const patient = makeRuntime(() => {});
  let settled = false;
  patient.runtime.initialize().then(() => (settled = true), () => (settled = true));
  await new Promise((r) => setTimeout(r, 100));
  expect(!settled, "with no limit, a start is waited for");
  patient.runtime.dispose();
}

console.log("\n[8] worker failure and dispose reject in-flight requests");
{
  const h = makeRuntime(autoInit());
  await h.runtime.initialize();
  const inflight = h.runtime.hasTests("x");
  await tick();
  h.fail(new Error("worker died"));
  await rejects(inflight, /worker died/, "a worker error should reject pending requests");

  const h2 = makeRuntime(autoInit());
  await h2.runtime.initialize();
  const pending = h2.runtime.ensurePytest();
  await tick();
  h2.runtime.dispose();
  await rejects(pending, /Runtime disposed/, "dispose should reject pending requests");
  expect(h2.terminated, "dispose should terminate the worker");
}

console.log("\n[9] requests before initialize() still initialize first");
{
  const h = makeRuntime(
    autoInit((msg, hs) => {
      hs.onMessage({ id: msg.id, type: "workspaceReady" });
    }),
  );
  await h.runtime.mountWorkspaceFiles([{ name: "a.csv", contents: "x\n" }]);
  const types = h.sent.map((m) => m.type);
  console.log(`    sent: ${types.join(", ")}`);
  expect(
    types.join(",") === "init,mountWorkspace",
    "a bare request should init the worker first, got " + types.join(","),
  );
}

console.log("\n[10] a failed load is tried again; a successful one is remembered");
{
  // Cached as a rejected promise, one failure lasted until the window was
  // reloaded: one dropped connection while pytest loaded, and no tests ran.
  let calls = 0;
  const load = onceSuccessful(async () => {
    calls += 1;
    if (calls === 1) throw new Error("network down");
    return "loaded";
  });
  await rejects(load(), /network down/, "the first attempt fails");
  expect((await load()) === "loaded", "the second is made, and succeeds");
  await load();
  expect(calls === 2, `and then remembered: ${calls} attempts`);
}

console.log("\n[11] a failed start is tried again, in a fresh worker");
{
  let attempts = 0;
  const h = makeRuntime((msg, hs) => {
    if (msg.type !== "init") return;
    attempts += 1;
    if (attempts === 1) hs.onMessage({ id: msg.id, type: "error", message: "no wasm", kind: "failed" });
    else hs.onMessage({ id: msg.id, type: "ready" });
  });
  await rejects(h.runtime.initialize(), /no wasm/, "the first start fails");
  expect(h.terminated, "and its worker is ended");
  await h.runtime.initialize();
  expect(attempts === 2, `the next call starts again: ${attempts} attempts`);
}

console.log("\n[12] the worker tries pytest again after a failed load");
{
  // A Pyodide with nothing in it but what the worker calls.
  let pytestLoads = 0;
  const callable = Object.assign(() => ({ toJs: () => ({}), destroy() {} }), { destroy() {} });
  const instance = {
    runPython() {},
    setStdin() {},
    setInterruptBuffer() {},
    loadPackagesFromImports: async () => undefined,
    loadPackage: async (name) => {
      if (name === "pytest" && ++pytestLoads === 1) throw new Error("network down");
    },
    globals: { get: () => callable, set() {} },
    FS: new Proxy({}, { get: () => () => ({ isDir: () => true, mode: 0 }) }),
  };
  const posted = [];
  const handle = createWorkerHost({
    post: (msg) => posted.push(msg),
    loadPyodide: async () => instance,
    stdinUnavailableMessage: "no stdin",
  });
  await handle({ id: 1, type: "init", indexUrl: "/x/" });
  await handle({ id: 2, type: "loadPytest" });
  await handle({ id: 3, type: "loadPytest" });
  const replies = posted.filter((m) => m.id !== undefined).map((m) => `${m.id}:${m.type}`);
  expect(
    replies.join(",") === "1:ready,2:error,3:pytestReady",
    `failed, then loaded on the next request: ${replies.join(",")}`,
  );
}

console.log("\n[12b] the worker answers one request at a time, with typed errors and null for None");
{
  // A fake interpreter: `_pll_repl_check` gives a dict with a None in it,
  // `_pll_has_tests` raises KeyboardInterrupt, `_pll_repl_eval` an ordinary error.
  let releaseLoad;
  const loading = new Promise((resolve) => (releaseLoad = resolve));
  const pythonError = (type) => Object.assign(new Error(`${type}: raised`), { type });
  const fn = (name) => {
    const call = (...args) => {
      if (name === "_pll_repl_check") {
        return { toJs: () => ({ status: "invalid", error_type: "SyntaxError", lineno: undefined }), destroy() {} };
      }
      if (name === "_pll_has_tests") throw pythonError("KeyboardInterrupt");
      if (name === "_pll_repl_eval") throw pythonError("ValueError");
      return undefined;
    };
    call.destroy = () => {};
    return call;
  };
  const instance = {
    runPython() {},
    setStdin() {},
    setInterruptBuffer() {},
    loadPackagesFromImports: () => loading,
    loadPackage: async () => undefined,
    globals: { get: (name) => fn(name), set() {} },
    FS: new Proxy({}, { get: () => () => ({ isDir: () => true, mode: 0 }) }),
  };
  const posted = [];
  const handle = createWorkerHost({
    post: (msg) => posted.push(msg),
    loadPyodide: async () => instance,
    stdinUnavailableMessage: "no stdin",
  });
  await handle({ id: 1, type: "init", indexUrl: "/x/" });
  const load = handle({ id: 2, type: "loadPackages", code: "import numpy" });
  const check = handle({ id: 3, type: "checkSyntax", code: "x = (" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(!posted.some((m) => m.id === 3), "the check waits for the load before it");
  releaseLoad();
  await Promise.all([load, check]);
  const ids = posted.filter((m) => m.id !== undefined).map((m) => m.id);
  expect(ids.join(",") === "1,2,3", `answered in order: ${ids.join(",")}`);
  const syntax = posted.find((m) => m.id === 3);
  expect(syntax.result.lineno === null, `a None arrives as null: ${JSON.stringify(syntax.result)}`);
  await handle({ id: 4, type: "hasTests", code: "" });
  await handle({ id: 5, type: "replEval", code: "", sessionKey: "s" });
  const kinds = posted.filter((m) => m.type === "error").map((m) => `${m.id}:${m.kind}`);
  expect(kinds.join(",") === "4:interrupted,5:failed", `each error says what kind it is: ${kinds.join(",")}`);
}

console.log("\n[13] a worker that dies is replaced by the next request");
{
  // Kept, every later request would be posted to a worker that is no
  // longer there, and wait forever.
  let inits = 0;
  const h = makeRuntime((msg, hs) => {
    if (msg.type === "init") {
      inits += 1;
      hs.onMessage({ id: msg.id, type: "ready" });
    } else if (msg.type === "replEval" && inits > 1) {
      hs.onMessage({ id: msg.id, type: "result", result: { ...RESULT, result_repr: "2" } });
    }
  });
  await h.runtime.initialize();
  const lost = h.runtime.replEval({ code: "1 + 1", sessionKey: "s" }, () => {});
  while (!h.sent.some((m) => m.type === "replEval")) await new Promise((r) => setTimeout(r, 1));
  let told = 0;
  h.runtime.setPythonLostHandler(() => (told += 1));
  h.exit();
  await rejects(lost, /Python stopped completely/, "the request in flight fails, saying why");
  expect(told === 1, `whoever asked is told, once: ${told}`);
  const events = [];
  await h.runtime.replEval({ code: "1 + 1", sessionKey: "s" }, (e) => events.push(e));
  expect(inits === 2, `a new worker was started: ${inits} inits`);
  expect(events.some((e) => e.kind === "result" && e.repr === "2"), "and it answers");
}

console.log("\n[13b] so is a worker whose Python can no longer run");
{
  // `os.abort()`, or a fatal error in Pyodide: the worker lives on, but
  // every call into Python fails, so every run of every file failed until
  // the window was reloaded.
  let inits = 0;
  const h = makeRuntime((msg, hs) => {
    if (msg.type === "init") {
      inits += 1;
      hs.onMessage({ id: msg.id, type: "ready" });
    } else if (msg.type === "replEval" && inits === 1) {
      hs.onMessage({ id: msg.id, type: "error", message: "Pyodide already fatally failed and can no longer be used.", kind: "finished" });
    } else if (msg.type === "replEval") {
      hs.onMessage({ id: msg.id, type: "result", result: { ...RESULT, result_repr: "2" } });
    }
  });
  let told = 0;
  h.runtime.setPythonLostHandler(() => (told += 1));
  await h.runtime.initialize();
  await rejects(h.runtime.replEval({ code: "1 + 1", sessionKey: "s" }, () => {}), /Python stopped completely/,
    "the request fails as Python being gone, not with Pyodide's words");
  expect(h.terminated, "the worker is ended");
  expect(told === 1, `whoever asked is told: ${told}`);
  const events = [];
  await h.runtime.replEval({ code: "1 + 1", sessionKey: "s" }, (e) => events.push(e));
  expect(inits === 2 && events.some((e) => e.kind === "result" && e.repr === "2"), `and a new one answers: ${inits} inits`);
  // An ordinary failure is not that.
  const ordinary = makeRuntime(autoInit((msg, hs) => {
    if (msg.type === "replEval") hs.onMessage({ id: msg.id, type: "error", message: "boom", kind: "failed" });
    if (msg.type === "examplarRun") hs.onMessage({ id: msg.id, type: "error", message: "KeyboardInterrupt", kind: "interrupted" });
  }));
  await ordinary.runtime.initialize();
  await rejects(ordinary.runtime.replEval({ code: "1", sessionKey: "s" }, () => {}), /^boom$/, "an ordinary error is passed on");
  expect(!ordinary.terminated, "and the worker kept");
  // A Stop is told apart by its type, not its text.
  let stopped = null;
  await ordinary.runtime.examplarRun("t", "{}").catch((err) => (stopped = err));
  expect(stopped instanceof StoppedError, `a Stop arrives as a StoppedError: ${stopped}`);
}

console.log("\n[14] ending a session never starts Python just to do it");
{
  const h = makeRuntime(autoInit((msg, w) => {
    if (msg.type === "endSession") w.onMessage({ id: msg.id, type: "sessionEnded" });
  }));
  await h.runtime.endSession("file:///a.py");
  expect(h.sent.length === 0, `nothing sent before Python is started: ${JSON.stringify(h.sent.map((m) => m.type))}`);
  await h.runtime.initialize();
  await h.runtime.endSession("file:///a.py");
  const ends = h.sent.filter((m) => m.type === "endSession");
  expect(ends.length === 1 && ends[0].sessionKey === "file:///a.py", `then it is asked: ${JSON.stringify(ends)}`);
}

console.log("\n[15] what Pyodide says while loading goes to whoever the host names");
{
  const h = makeRuntime(autoInit());
  await h.runtime.initialize();
  const heard = [];
  h.runtime.setPackageNoteHandler((text, failed) => heard.push([text, failed]));
  h.reply({ type: "packageNote", text: "Loading pytest", failed: false });
  h.reply({ type: "packageNote", text: "URI mismatch", failed: true });
  expect(JSON.stringify(heard) === JSON.stringify([["Loading pytest", false], ["URI mismatch", true]]),
    `each note, and whether it is a failure: ${JSON.stringify(heard)}`);
}

console.log(`\nsmoke-worker-protocol: ${passed() ? "ok" : "FAILED"}`);
if (!passed()) {
  process.exit(1);
}
