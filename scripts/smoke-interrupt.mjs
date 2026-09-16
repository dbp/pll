#!/usr/bin/env node
/**
 * Integration smoke for stopping a running program: boots the built desktop
 * worker, starts an infinite loop, and interrupts it through the shared
 * buffer. Requires `pnpm run build` so dist/desktop/pyodideWorker.js exists.
 *
 * This is the one test that proves the whole path, because the failure it
 * guards against (the worker never returning) cannot be reproduced with a
 * fake runtime.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Worker } from "node:worker_threads";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const WORKER_PATH = resolve(ROOT, "dist", "desktop", "pyodideWorker.js");
const INDEX_URL = resolve(ROOT, "node_modules", "pyodide");

// Must match src/common/interruptBuffer.ts.
const INTERRUPT_SAB_BYTES = 1;
const INTERRUPT_SIGINT = 2;

/** Generous: a bytecode check is immediate, so this only bounds a failure. */
const INTERRUPT_DEADLINE_MS = 20000;

let ok = true;
function expect(cond, msg) {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    ok = false;
  }
}

function talk(worker) {
  let nextId = 1;
  let displays = 0;
  const pending = new Map();
  worker.on("message", (msg) => {
    if (msg.type === "display") {
      displays += 1;
      return;
    }
    if (msg.type === "stdinRequest") return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.type === "error") p.reject(new Error(msg.message));
    else p.resolve(msg);
  });
  worker.on("error", (err) => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  });
  return {
    get displays() {
      return displays;
    },
    send(payload) {
      const id = nextId++;
      const promise = new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
      worker.postMessage({ id, ...payload });
      return promise;
    },
  };
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/** Reject rather than hang forever if the interrupt never lands. */
function withDeadline(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_res, rej) => {
      timer = setTimeout(() => rej(new Error(`${label} did not finish within ${ms}ms`)), ms);
    }),
  ]);
}

async function main() {
  if (!existsSync(WORKER_PATH)) {
    console.error(`Missing ${WORKER_PATH}. Run \`pnpm run build\` first.`);
    process.exit(1);
  }

  const interruptBuffer = new SharedArrayBuffer(INTERRUPT_SAB_BYTES);
  const signal = () => Atomics.store(new Uint8Array(interruptBuffer), 0, INTERRUPT_SIGINT);
  const pending = () => Atomics.load(new Uint8Array(interruptBuffer), 0);

  const worker = new Worker(WORKER_PATH);
  const session = talk(worker);

  try {
    console.log("\n[1] worker init accepts an interrupt buffer");
    await session.send({ type: "init", indexUrl: INDEX_URL, interruptBuffer });
    console.log("    ok");

    console.log("\n[2] an infinite loop is interruptible");
    const run = session.send({
      type: "runFile",
      code: 'print("before")\nwhile True:\n    pass\n',
      fileName: "loop.py",
      sessionKey: "s1",
      typeCheck: false,
      level: "advanced",
    });
    // Let the loop actually start before signalling.
    await sleep(500);
    signal();
    const { result } = await withDeadline(run, INTERRUPT_DEADLINE_MS, "interrupted run");
    expect(result.ok === false, `interrupted run should not be ok, got ok=${result.ok}`);
    expect(
      result.error_type === "KeyboardInterrupt",
      `expected KeyboardInterrupt, got ${result.error_type}`,
    );
    expect(
      result.stdout.includes("before"),
      `output printed before the loop should survive, got ${JSON.stringify(result.stdout)}`,
    );
    console.log(`    error_type=${result.error_type} stdout=${JSON.stringify(result.stdout)}`);

    console.log("\n[3] the interpreter still works after an interrupt");
    const after = await withDeadline(
      session.send({
        type: "runFile",
        code: 'print("still here")\n',
        fileName: "after.py",
        sessionKey: "s1",
        typeCheck: false,
        level: "advanced",
      }),
      INTERRUPT_DEADLINE_MS,
      "post-interrupt run",
    );
    expect(after.result.ok === true, `run after an interrupt should succeed: ${after.result.traceback}`);
    expect(after.result.stdout.includes("still here"), "post-interrupt stdout should be captured");
    console.log("    ok");

    console.log("\n[4] a Stop nobody consumed does not fire into the next run");
    // Signal with nothing running, as happens when Stop races the end of a run.
    signal();
    expect(pending() === INTERRUPT_SIGINT, "the signal should be pending before the next run");
    const later = await withDeadline(
      session.send({
        type: "runFile",
        code: 'print("clean")\n',
        fileName: "clean.py",
        sessionKey: "s1",
        typeCheck: false,
        level: "advanced",
      }),
      INTERRUPT_DEADLINE_MS,
      "run after a stale signal",
    );
    expect(
      later.result.ok === true,
      `a stale Stop must not interrupt the next program: ${later.result.error_type}`,
    );
    expect(later.result.stdout.includes("clean"), "post-stale-signal stdout should be captured");
    console.log("    ok");
    console.log("\n[5] a loop that prints is interruptible, and does not flood the host");
    // The case that matters: every print calls back into JS, so without
    // coalescing this posts a few hundred thousand messages a second and the
    // host never gets around to processing the student's Stop.
    const before = session.displays;
    const printRun = session.send({
      type: "runFile",
      code: 'while True:\n    print("hello")\n',
      fileName: "noisy.py",
      sessionKey: "s1",
      typeCheck: false,
      level: "advanced",
    });
    await sleep(1000);
    const duringSecond = session.displays - before;
    signal();
    const noisy = await withDeadline(printRun, INTERRUPT_DEADLINE_MS, "interrupted print loop");
    expect(
      noisy.result.error_type === "KeyboardInterrupt",
      `expected KeyboardInterrupt, got ${noisy.result.error_type}`,
    );
    expect(
      noisy.result.stdout.includes("hello"),
      "the loop's output should still be captured",
    );
    // One second of output at a 50ms flush cadence is ~20 messages. Allow
    // generous slack; the point is that it is bounded by time, not by how
    // fast Python can print.
    expect(
      duringSecond <= 200,
      `one second of printing should coalesce into few messages, got ${duringSecond}`,
    );
    console.log(`    messages for 1s of printing: ${duringSecond} (uncoalesced was ~230000)`);
  } finally {
    await worker.terminate();
  }

  if (!ok) {
    console.error("\nsmoke-interrupt: FAILED");
    process.exit(1);
  }
  console.log("\nsmoke-interrupt: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
