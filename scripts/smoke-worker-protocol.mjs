#!/usr/bin/env node
/**
 * Smoke test for the shared worker protocol client
 * (`src/common/workerRuntime.ts`), which both hosts subclass.
 *
 * Drives a real `WorkerPythonRuntime` against a scripted in-process worker,
 * so no Pyodide is involved: this checks request/reply correlation, error
 * propagation, live display streaming, and the stdin round-trip.
 */
import { build } from "esbuild";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/** Let the runtime's internal `await initialize()` hops settle. */
const tick = () => new Promise((r) => setTimeout(r, 0));

let ok = true;
function expect(cond, msg) {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    ok = false;
  }
}

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
  const tmp = mkdtempSync(join(ROOT, ".smoke-"));
  const entry = join(tmp, "entry.mjs");
  writeFileSync(
    entry,
    `
export { WorkerPythonRuntime } from "../src/common/workerRuntime";
export * as stdin from "../src/common/stdinBuffer";
`,
  );
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: join(tmp, "out.mjs"),
    loader: { ".py": "text" },
    absWorkingDir: ROOT,
  });
  const mod = await import(pathToFileURL(join(tmp, "out.mjs")).href);
  rmSync(tmp, { recursive: true, force: true });
  return mod;
}

const { WorkerPythonRuntime, stdin } = await load();

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
      hs.onMessage({ id: msg.id, type: "error", message: "boom in Python" });
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
        hs.onMessage({ type: "display", payload: { type: "stdout", text: "Name: " } });
        hs.onMessage({
          type: "display",
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
  h.reply({ type: "display", payload: { type: "stdout", text: "ignored" } });

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
  h.reply({ type: "display", payload: { type: "stdout", text: "late" } });
  expect(events.length === before, "displays after the run should be dropped");
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
  expect(events[0].lineNumber === 3, "line number should be carried through");
  expect(events[0].fileName === "<repl>", "replEval should label events <repl>");
}

console.log("\n[7] stdinRequest asks the host and writes the line into the SAB");
{
  const h = makeRuntime(autoInit());
  await h.runtime.initialize();
  const sab = h.sent.find((m) => m.type === "init").stdinBuffer;
  const state = new Int32Array(sab);

  h.runtime.setStdinHandler(async () => "Ada");
  h.reply({ type: "stdinRequest" });
  await tick();
  expect(
    Atomics.load(state, stdin.STDIN_STATE_INDEX) === stdin.STDIN_STATE_LINE,
    "answering input() should store the LINE state",
  );
  const n = Atomics.load(state, stdin.STDIN_LENGTH_INDEX);
  const bytes = new Uint8Array(n);
  bytes.set(new Uint8Array(sab, stdin.STDIN_PAYLOAD_OFFSET, n));
  const line = new TextDecoder().decode(bytes);
  console.log(`    line=${JSON.stringify(line)}`);
  expect(line === "Ada", "the submitted line should land in the buffer, got " + line);

  // A handler that throws must still unblock the worker, with EOF.
  h.runtime.setStdinHandler(async () => {
    throw new Error("cancelled");
  });
  h.reply({ type: "stdinRequest" });
  await tick();
  expect(
    Atomics.load(state, stdin.STDIN_STATE_INDEX) === stdin.STDIN_STATE_EOF,
    "a failing stdin handler should send EOF rather than hang the worker",
  );

  // So must no handler at all.
  h.runtime.setStdinHandler(null);
  Atomics.store(state, stdin.STDIN_STATE_INDEX, stdin.STDIN_STATE_WAITING);
  h.reply({ type: "stdinRequest" });
  await tick();
  expect(
    Atomics.load(state, stdin.STDIN_STATE_INDEX) === stdin.STDIN_STATE_EOF,
    "no stdin handler should send EOF",
  );
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

console.log(`\nsmoke-worker-protocol: ${ok ? "ok" : "FAILED"}`);
if (!ok) {
  process.exit(1);
}
