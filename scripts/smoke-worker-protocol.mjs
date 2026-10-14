#!/usr/bin/env node
/**
 * Smoke test for the shared worker protocol: the host side
 * (`src/pyodide/runtime.ts`, with `src/run/python.ts` over it) and the
 * worker side (`src/pyodide/worker.ts`).
 *
 * Drives a real `Python` against a scripted in-process worker, and the real
 * worker against a fake Pyodide, so no Pyodide is involved: this checks
 * request/reply correlation, error propagation, live display streaming,
 * the stdin round-trip, and loading packages.
 */
import { expect, passed } from "./lib/check.mjs";
import { importSource } from "./lib/bundle.mjs";

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
export { Python } from "./src/run/python";
export { createWorkerHost } from "./src/pyodide/worker";
export * as stdin from "./src/pyodide/sharedMemory";
export { StoppedError } from "./src/pyodide/runtime";
`);
  return mod;
}

const { Python, createWorkerHost, stdin, StoppedError } = await load();

/**
 * A runtime whose "worker" is a function the test controls. `respond` is
 * called for every outbound message; the test replies via `handlers`.
 */
function makeRuntime(respond, options = {}) {
  const sent = [];
  let handlers = null;
  let terminated = false;
  const runtime = new Python({
    ...options,
    indexUrl: () => "/fake/index/",
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
    },
  });

  return {
    runtime,
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

/** The worker's answer to `msg`: `value`, its success. */
const answer = (h, msg, value = null) => h.onMessage({ id: msg.id, type: "reply", value });

/** Whether `msg` is a call of the Python function `fn`. */
const calls = (msg, fn) => msg.type === "call" && msg.fn === fn;

/** Answer `init` immediately and hand everything else to `custom`. */
function autoInit(custom = () => {}) {
  return (msg, h) => {
    if (msg.type === "init") {
      answer(h, msg);
      return;
    }
    custom(msg, h);
  };
}

/** A run's result as Python sends it (`_pll_run_result`): nothing printed, shown or raised. */
const RESULT = {
  ok: true,
  stdout: "",
  stderr: "",
  resultRepr: null,
  displays: [],
  exitCode: null,
  stopped: false,
  tests: null,
  error: null,
};

/** A reactor's frame after a step, as Python sends it. */
const FRAME = {
  kind: "frame",
  index: 1,
  length: 2,
  frame: "<svg/>",
  atEnd: true,
  stopped: false,
  valueRepr: "1",
  messages: [],
};

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
      if (calls(msg, "_pll_repl_check")) held.push(msg);
    }),
  );
  await h.runtime.initialize();
  const first = h.runtime.checkReplComplete("if True:");
  const second = h.runtime.checkReplComplete("1 + 1");
  await tick();
  expect(held.length === 2, "both requests should reach the worker");
  // Answer the second request first.
  h.reply({ id: held[1].id, type: "reply", value: { status: "complete" } });
  h.reply({ id: held[0].id, type: "reply", value: { status: "incomplete", lineNumber: 1 } });
  const [a, b] = await Promise.all([first, second]);
  console.log(`    first=${a.status} second=${b.status}`);
  expect(a.status === "incomplete", "first call should get its own reply, got " + a.status);
  expect(b.status === "complete", "second call should get its own reply, got " + b.status);
  expect(a.lineNumber === 1, "the reply is Python's, as it is, got " + a.lineNumber);
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

console.log("\n[4] a call names the Python function, its arguments, and whether it streams");
{
  const worded = [{ id: "reassignment", headline: "`x` is already assigned." }];
  const h = makeRuntime(autoInit((msg, hs) => answer(hs, msg, msg.fn === "_pll_static_findings" ? worded : RESULT)));
  await h.runtime.runFile({ code: "x = 1", fileName: "a.py", sessionKey: "s" }, () => {});
  await h.runtime.replEval({ code: "x", sessionKey: "s", level: "beginner" }, () => {});
  const findings = await h.runtime.staticAnalyze({ code: "x", level: "beginner", fileName: "a.py" });
  const sent = h.sent.filter((m) => m.type === "call").map(({ fn, args, live }) => [fn, args, live]);
  expect(
    JSON.stringify(sent) ===
      JSON.stringify([
        ["_pll_run_file", ["x = 1", "a.py", "s", "raw", false], true],
        ["_pll_repl_eval", ["x", "s", "beginner"], false],
        ["_pll_static_findings", ["x", "beginner", "a.py", null], false],
      ]),
    `defaults filled in, and only a run streams: ${JSON.stringify(sent)}`,
  );
  expect(JSON.stringify(findings) === JSON.stringify(worded), `the findings as Python words them: ${JSON.stringify(findings)}`);
}

console.log("\n[5] live displays stream during runFile, and only during a run");
{
  const h = makeRuntime(
    autoInit((msg, hs) => {
      if (calls(msg, "_pll_run_file")) {
        hs.onMessage({ type: "display", requestId: msg.id, payload: { kind: "stdout", text: "Name: " } });
        hs.onMessage({
          type: "display",
          requestId: msg.id,
          payload: { kind: "image", svg: "<svg/>", width: 2, height: 3 },
        });
        answer(hs, msg, { ...RESULT, resultRepr: "42" });
      }
    }),
  );
  await h.runtime.initialize();

  // Displays arriving outside a run have nowhere to go; must not throw.
  h.reply({ type: "display", requestId: 999, payload: { kind: "stdout", text: "ignored" } });

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
  expect(events[2].repr === "42", "the last line's value should become a result event");

  // How the program ended goes with `done`.
  const ended = makeRuntime(autoInit((msg, hs) => answer(hs, msg, { ...RESULT, exitCode: 3, stopped: true })));
  const endEvents = [];
  await ended.runtime.runFile({ code: "x", fileName: "e.py", sessionKey: "s" }, (e) => endEvents.push(e));
  expect(
    JSON.stringify(endEvents.at(-1)) === JSON.stringify({ kind: "done", exitCode: 3, stopped: true }),
    `its exit status and its Stop: ${JSON.stringify(endEvents.at(-1))}`,
  );

  // After the run the sink is detached again.
  const before = events.length;
  const runId = h.sent.find((m) => calls(m, "_pll_run_file")).id;
  h.reply({ type: "display", requestId: runId, payload: { kind: "stdout", text: "late" } });
  expect(events.length === before, "displays after the run should be dropped");
}

console.log("\n[5b] a reactor step streams its handlers' output too");
{
  // Live output is listened for during a reactor step, not only during a
  // file run, or a handler's `print` would reach nobody.
  const h = makeRuntime(
    autoInit((msg, hs) => {
      if (calls(msg, "_pll_reactor_step")) {
        hs.onMessage({ type: "display", requestId: msg.id, payload: { kind: "stdout", text: "tick 0\n" } });
        answer(hs, msg, FRAME);
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
  const stepId = h.sent.find((m) => calls(m, "_pll_reactor_step")).id;
  h.reply({ type: "display", requestId: stepId, payload: { kind: "stdout", text: "late" } });
  expect(events.length === before, "and nothing after the step is");
}

console.log("\n[5c] output goes to the request it belongs to");
{
  // Two requests in flight: a run's output must not reach a reactor's sink.
  let stepId = null;
  const h = makeRuntime(
    autoInit((msg, hs) => {
      if (calls(msg, "_pll_reactor_step")) stepId = msg.id;
      if (calls(msg, "_pll_run_file")) {
        hs.onMessage({ type: "display", requestId: msg.id, payload: { kind: "stdout", text: "run\n" } });
        answer(hs, msg, RESULT);
        hs.onMessage({
          id: stepId,
          type: "reply",
          value: FRAME,
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
      answer(hs, msg, {
        ...RESULT,
        ok: false,
        error: {
          errorType: "NameError",
          message: "name 'x' is not defined",
          finding: {
            id: "name-error",
            errorType: "NameError",
            headline: "Python doesn't know what `x` means.",
            howToFix: [],
            fileName: "<repl>",
            lineNumber: 3,
            column: 0,
            nameToken: "x",
            severity: "error",
            origin: "runtime",
          },
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
  expect(events[0].error.finding.lineNumber === 3, "the finding should be carried through");
  expect(events[0].error.errorType === "NameError", "and Python's own words for the error");
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
  const h = makeRuntime(() => {}, { startTimeoutMs: 50 });
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
  const h = makeRuntime(autoInit((msg, hs) => answer(hs, msg)));
  await h.runtime.mountWorkspaceFiles([{ name: "a.csv", contents: "x\n" }]);
  const types = h.sent.map((m) => m.type);
  console.log(`    sent: ${types.join(", ")}`);
  expect(
    types.join(",") === "init,mount",
    "a bare request should init the worker first, got " + types.join(","),
  );
}

console.log("\n[10] packages: what Python finds the program imports is loaded, and the network if it reads URLs");
{
  // Python finds pandas for `to_pandas()` (smoke-pandas [1]); the host loads what it is told.
  const h = makeRuntime(
    autoInit((msg, hs) => {
      if (calls(msg, "_pll_package_imports")) {
        answer(
          hs,
          msg,
          msg.args[0].includes("requests")
            ? { modules: ["requests"], network: true }
            : { modules: msg.args[0].includes("to_pandas") ? ["pandas"] : [], network: msg.args[0].includes("to_pandas") },
        );
      } else {
        answer(hs, msg);
      }
    }),
  );
  await h.runtime.ensurePackages("import requests\n");
  await h.runtime.ensurePackages("t.to_pandas()\n", [{ name: "helper.py", text: "x = 1\n" }]);
  await h.runtime.ensurePytest();
  const loads = h.sent.filter((m) => m.type === "load").map(({ modules, network }) => [modules, network]);
  expect(
    JSON.stringify(loads) ===
      JSON.stringify([
        [["requests"], true],
        [["pandas"], true],
        [["pytest"], false],
      ]),
    `each load asks for what it needs: ${JSON.stringify(loads)}`,
  );
  const asked = h.sent.filter((m) => calls(m, "_pll_package_imports")).map((m) => m.args);
  expect(
    asked.length === 2 && asked[1][1] === JSON.stringify([{ name: "helper.py", text: "x = 1\n" }]),
    `the files beside it are read too, and pytest is not looked for: ${JSON.stringify(asked)}`,
  );
}

console.log("\n[11] a failed start is tried again, in a fresh worker");
{
  let attempts = 0;
  const h = makeRuntime((msg, hs) => {
    if (msg.type !== "init") return;
    attempts += 1;
    if (attempts === 1) hs.onMessage({ id: msg.id, type: "error", message: "no wasm", kind: "failed" });
    else answer(hs, msg);
  });
  await rejects(h.runtime.initialize(), /no wasm/, "the first start fails");
  expect(h.terminated, "and its worker is ended");
  await h.runtime.initialize();
  expect(attempts === 2, `the next call starts again: ${attempts} attempts`);
}

/**
 * A fake Pyodide, with nothing in it but what the worker uses. `python(fn,
 * args)` stands in for the Python function a call names; `loadPackages`
 * for Pyodide's `loadPackagesFromImports`; `stops` for how many Stops
 * Python has delivered.
 */
function fakePyodide({ python = () => null, loadPackages = async () => [] } = {}) {
  const ran = [];
  const pllCall = Object.assign((fn, argsJson) => JSON.stringify(python(fn, JSON.parse(argsJson)) ?? null), {
    destroy() {},
  });
  const set = new Map();
  const fake = {
    ran,
    stops: 0,
    globals: set,
    instance: {
      runPython(code) {
        ran.push(code);
        return code === "_pll_stops_delivered" ? fake.stops : undefined;
      },
      setStdin() {},
      setInterruptBuffer() {},
      loadPackagesFromImports: loadPackages,
      globals: {
        get: (name) => (name === "_pll_call" ? pllCall : Object.assign(() => undefined, { destroy() {} })),
        set: (name, value) => set.set(name, value),
      },
      FS: new Proxy({}, { get: () => () => ({ isDir: () => true, mode: 0 }) }),
    },
  };
  return fake;
}

/** The worker, over `fake`; `posted` is everything it sends back. */
async function startWorkerHost(fake) {
  const posted = [];
  const network = () => ({ status: 200, headers: {}, body: new Uint8Array(0) });
  const handle = createWorkerHost({
    post: (msg) => posted.push(msg),
    loadPyodide: async () => fake.instance,
    stdinUnavailableMessage: "no stdin",
    http: () => network,
  });
  await handle({ id: 1, type: "init", indexUrl: "/x/" });
  // The host's network is Python's from the start.
  expect(fake.globals.get("_pll_host_http") === network, "the network is handed to Python");
  return { handle, posted };
}

console.log("\n[12] a package that failed to download is tried again by the next load");
{
  // Pyodide resolves after a failure, having said so to `errorCallback`:
  // a load remembered as done would never try again.
  let attempts = 0;
  const fake = fakePyodide({
    loadPackages: async (code, options) => {
      attempts += 1;
      if (attempts === 1) {
        options.messageCallback("Failed to load pytest");
        options.errorCallback("The following error occurred while loading pytest:");
        options.errorCallback("network down");
      }
      return [];
    },
  });
  const { handle, posted } = await startWorkerHost(fake);
  await handle({ id: 2, type: "load", modules: ["pytest"], network: false });
  await handle({ id: 3, type: "load", modules: ["pytest"], network: false });
  const replies = posted.filter((m) => m.id !== undefined).map((m) => `${m.id}:${m.type}`);
  expect(replies.join(",") === "1:reply,2:error,3:reply", `failed, then loaded on the next request: ${replies.join(",")}`);
  const failure = posted.find((m) => m.id === 2);
  expect(
    failure.message === "The following error occurred while loading pytest: network down",
    `the failure says why, in Pyodide's words: ${failure.message}`,
  );
  expect(attempts === 2, `Pyodide was asked again: ${attempts}`);
  const notes = posted.filter((m) => m.type === "packageNote").map((m) => `${m.failed}:${m.text}`);
  expect(notes.length === 3 && notes[2] === "true:network down", `and what it said went to the host: ${notes.join(" | ")}`);
}

console.log("\n[12a] a Stop while a package installs is a Stop, not a package that failed");
{
  // Pyodide's installer is Python: the Stop raises in it, and Pyodide
  // reports that package as failed and carries on.
  const fake = fakePyodide({
    loadPackages: async (code, options) => {
      fake.stops += 1;
      options.errorCallback("The following error occurred while loading pandas:");
      options.errorCallback("KeyboardInterrupt");
      return [];
    },
  });
  const { handle, posted } = await startWorkerHost(fake);
  await handle({ id: 2, type: "load", modules: ["pandas"], network: false });
  const reply = posted.find((m) => m.id === 2);
  expect(reply.type === "error" && reply.kind === "interrupted", `the load ends as stopped: ${JSON.stringify(reply)}`);
}

console.log("\n[12b] a load that uses the network loads nothing for it, and routes urllib after the packages");
{
  const asked = [];
  const fake = fakePyodide({
    loadPackages: async (code) => {
      asked.push(code);
      return [];
    },
  });
  const { handle, posted } = await startWorkerHost(fake);
  await handle({ id: 2, type: "load", modules: ["pandas"], network: true });
  await handle({ id: 3, type: "load", modules: [], network: false });
  expect(
    JSON.stringify(asked) === JSON.stringify(["import pandas"]),
    `with the network, no package for it; with nothing, Pyodide is not asked: ${JSON.stringify(asked)}`,
  );
  expect(fake.ran.filter((code) => /_pll_urlopen/.test(code)).length === 1, "and urllib is routed once, for the load that asked");
  expect(posted.filter((m) => m.type === "reply").length === 3, "each answered");
}

console.log("\n[12c] the worker answers one request at a time, with typed errors and Python's JSON");
{
  // `_pll_repl_check` gives a dict with a None in it, `_pll_has_tests`
  // raises KeyboardInterrupt, `_pll_repl_eval` an ordinary error.
  let releaseLoad;
  const loading = new Promise((resolve) => (releaseLoad = resolve));
  const pythonError = (type) => Object.assign(new Error(`${type}: raised`), { type });
  const fake = fakePyodide({
    loadPackages: () => loading,
    python(fn, args) {
      if (fn === "_pll_repl_check") return { status: "invalid", errorType: "SyntaxError", lineNumber: null, source: args[0] };
      if (fn === "_pll_has_tests") throw pythonError("KeyboardInterrupt");
      if (fn === "_pll_repl_eval") throw pythonError("ValueError");
      // Pyodide can give a `KeyboardInterrupt` no message at all.
      if (fn === "_pll_reactor_seek") throw Object.assign(new Error(""), { type: "KeyboardInterrupt" });
      return null;
    },
  });
  const { handle, posted } = await startWorkerHost(fake);
  const load = handle({ id: 2, type: "load", modules: ["numpy"], network: false });
  const check = handle({ id: 3, type: "call", fn: "_pll_repl_check", args: ["x = ("], live: false });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(!posted.some((m) => m.id === 3), "the check waits for the load before it");
  releaseLoad([]);
  await Promise.all([load, check]);
  const ids = posted.filter((m) => m.id !== undefined).map((m) => m.id);
  expect(ids.join(",") === "1,2,3", `answered in order: ${ids.join(",")}`);
  const syntax = posted.find((m) => m.id === 3);
  expect(
    syntax.value.lineNumber === null && syntax.value.source === "x = (",
    `the arguments arrive, and the result comes back as Python wrote it: ${JSON.stringify(syntax.value)}`,
  );
  await handle({ id: 4, type: "call", fn: "_pll_has_tests", args: [""], live: false });
  await handle({ id: 5, type: "call", fn: "_pll_repl_eval", args: ["", "s", "raw"], live: false });
  await handle({ id: 6, type: "call", fn: "_pll_reactor_seek", args: ["r1", 0], live: false });
  const kinds = posted.filter((m) => m.type === "error").map((m) => `${m.id}:${m.kind}`);
  expect(kinds.join(",") === "4:interrupted,5:failed,6:interrupted", `each error says what kind it is: ${kinds.join(",")}`);
  const unworded = posted.find((m) => m.id === 6);
  expect(unworded.message === "KeyboardInterrupt", `one with no message says its type: ${JSON.stringify(unworded.message)}`);
}

console.log("\n[13] a worker that dies is replaced by the next request");
{
  // Kept, every later request would be posted to a worker that is no
  // longer there, and wait forever.
  let inits = 0;
  const h = makeRuntime((msg, hs) => {
    if (msg.type === "init") {
      inits += 1;
      answer(hs, msg);
    } else if (calls(msg, "_pll_repl_eval") && inits > 1) {
      answer(hs, msg, { ...RESULT, resultRepr: "2" });
    }
  });
  await h.runtime.initialize();
  const lost = h.runtime.replEval({ code: "1 + 1", sessionKey: "s" }, () => {});
  while (!h.sent.some((m) => calls(m, "_pll_repl_eval"))) await new Promise((r) => setTimeout(r, 1));
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
      answer(hs, msg);
    } else if (calls(msg, "_pll_repl_eval") && inits === 1) {
      hs.onMessage({ id: msg.id, type: "error", message: "Pyodide already fatally failed and can no longer be used.", kind: "finished" });
    } else if (calls(msg, "_pll_repl_eval")) {
      answer(hs, msg, { ...RESULT, resultRepr: "2" });
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
    if (calls(msg, "_pll_repl_eval")) hs.onMessage({ id: msg.id, type: "error", message: "boom", kind: "failed" });
    if (calls(msg, "_pll_examplar_run")) hs.onMessage({ id: msg.id, type: "error", message: "KeyboardInterrupt", kind: "interrupted" });
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
  const h = makeRuntime(autoInit((msg, w) => answer(w, msg)));
  await h.runtime.endSession("file:///a.py");
  expect(h.sent.length === 0, `nothing sent before Python is started: ${JSON.stringify(h.sent.map((m) => m.type))}`);
  await h.runtime.initialize();
  await h.runtime.endSession("file:///a.py");
  const ends = h.sent.filter((m) => calls(m, "_pll_end_session"));
  expect(ends.length === 1 && ends[0].args[0] === "file:///a.py", `then it is asked: ${JSON.stringify(ends)}`);
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
