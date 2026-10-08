import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { ROOT } from "./bundle.mjs";

/** The built desktop worker; `pnpm run build` makes it. */
export const WORKER_PATH = resolve(ROOT, "dist", "desktop", "pyodideWorker.js");

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * Talk to a real worker the way the runtime does: `send` a request and get
 * its reply; `displays` is everything streamed live, in order.
 *
 * `onStdinRequest(request)` answers a blocked read of stdin, with
 * `writeStdin`; without it the request is ignored, which is right for a
 * test whose programs never read.
 */
export function talk(worker, { onStdinRequest } = {}) {
  let nextId = 1;
  let stdinCalls = 0;
  const displays = [];
  const pending = new Map();
  worker.on("message", (msg) => {
    if (msg.type === "display") {
      displays.push(msg.payload);
      return;
    }
    if (msg.type === "stdinRequest") {
      stdinCalls += 1;
      onStdinRequest?.(msg.request);
      return;
    }
    const waiting = pending.get(msg.id);
    if (!waiting) return;
    pending.delete(msg.id);
    if (msg.type === "error") waiting.reject(Object.assign(new Error(msg.message), { reply: msg }));
    else waiting.resolve(msg);
  });
  worker.on("error", (err) => {
    for (const waiting of pending.values()) waiting.reject(err);
    pending.clear();
  });
  const streamed = () =>
    displays.filter((d) => d.type === "stdout").map((d) => d.text).join("");
  return {
    displays,
    /** Everything streamed to stdout so far. */
    get streamed() {
      return streamed();
    },
    /** How many times the program asked for more of stdin. */
    get stdinCalls() {
      return stdinCalls;
    },
    /**
     * Wait until the program has printed `text` - that is, until it has
     * actually started.
     *
     * Signalling on a timer is a race the worker wins: a run clears any
     * pending interrupt before it starts (so a stale Stop cannot kill the
     * *next* program), and if the worker had not dequeued the request yet,
     * that clear wipes the signal and the program runs forever.
     */
    async waitForOutput(text, ms = 20000) {
      const deadline = Date.now() + ms;
      while (!streamed().includes(text)) {
        if (Date.now() > deadline) {
          throw new Error(`no ${JSON.stringify(text)} within ${ms}ms`);
        }
        await sleep(25);
      }
    },
    send(payload) {
      const id = nextId++;
      const reply = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      worker.postMessage({ id, ...payload });
      return reply;
    },
  };
}

/** Start the built worker, or say how to build it. */
export function startWorker() {
  if (!existsSync(WORKER_PATH)) {
    console.error(`Missing ${WORKER_PATH}. Run \`pnpm run build\` first.`);
    process.exit(1);
  }
  return new Worker(WORKER_PATH);
}
