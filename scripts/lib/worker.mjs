import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { ROOT } from "./bundle.mjs";

/** The built desktop worker; `pnpm run build` makes it. */
export const WORKER_PATH = resolve(ROOT, "dist", "desktop", "pyodideWorker.js");

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * The calls into Python a test asks for by name, as `run/python.ts` makes
 * them: the function, its arguments, and whether its output streams.
 */
const CALLS = {
  runFile: (r) => ["_pll_run_file", [r.code, r.fileName, r.sessionKey, r.level ?? "raw", r.withTests ?? false], true],
  replEval: (r) => ["_pll_repl_eval", [r.code, r.sessionKey, r.level ?? "raw"], false],
  checkSyntax: (r) => ["_pll_repl_check", [r.code, r.whole === true], false],
  hasTests: (r) => ["_pll_has_tests", [r.code], false],
  staticAnalyze: (r) => ["_pll_static_analyze", [r.code, r.level, r.fileName, r.sessionKey ?? null], false],
  reactorStep: (r) => ["_pll_reactor_step", [r.reactorId, r.event], true],
  reactorSeek: (r) => ["_pll_reactor_seek", [r.reactorId, r.index], false],
  endSession: (r) => ["_pll_end_session", [r.sessionKey], false],
  examplarBuild: (r) => ["_pll_examplar_build", [r.sources], false],
  examplarRun: (r) => ["_pll_examplar_run", [r.testSource, r.bundle, r.fileName], false],
};

/**
 * Talk to a real worker the way the runtime does: `send` a request and get
 * its reply; `displays` is everything streamed live, in order.
 *
 * A request is one of the worker's own (`init`, `load`, `mount`,
 * `collect`, `call`), or named for what it does - `{ type: "runFile",
 * code, fileName, sessionKey }` - and answered `{ result }`; `loadPytest`
 * and `loadPackages` load as the runtime does.
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
    else waiting.resolve(msg.value);
  });
  worker.on("error", (err) => {
    for (const waiting of pending.values()) waiting.reject(err);
    pending.clear();
  });
  const streamed = () =>
    displays.filter((d) => d.kind === "stdout").map((d) => d.text).join("");
  /** One of the worker's own requests, and the value it replies with. */
  const request = (payload) => {
    const id = nextId++;
    const reply = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    worker.postMessage({ id, ...payload });
    return reply;
  };
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
    async send({ type, ...fields }) {
      if (type in CALLS) {
        const [fn, args, live] = CALLS[type](fields);
        return { result: await request({ type: "call", fn, args, live }) };
      }
      if (type === "loadPytest") {
        return request({ type: "load", modules: ["pytest"], network: false });
      }
      if (type === "loadPackages") {
        const found = await request({
          type: "call",
          fn: "_pll_package_imports",
          args: [fields.code, JSON.stringify(fields.siblings ?? [])],
          live: false,
        });
        return request({ type: "load", modules: found.modules, network: found.network || found.modules.includes("pandas") });
      }
      if (type === "mountWorkspace") {
        return request({ type: "mount", files: fields.files, leftOut: fields.leftOut ?? [] });
      }
      if (type === "collectWorkspace") {
        return { changes: await request({ type: "collect" }) };
      }
      return request({ type, ...fields });
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
