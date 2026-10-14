import { MessageChannel, type MessagePort, receiveMessageOnPort, Worker } from "node:worker_threads";
import type { HostHttp } from "../pyodide/install";
import { INTERRUPT_ACK_INDEX, INTERRUPT_SIGINT } from "../pyodide/sharedMemory";

/** How long a request may take when the program did not say. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** The largest response read. */
export const MAX_RESPONSE_BYTES = 256 * 1024 * 1024;

/**
 * Python's network on the desktop. Node has no synchronous `fetch`, so a
 * helper thread fetches, and this thread waits for its answer - in 20 ms
 * slices, so a Stop in `interrupt` (no answer) or the time limit ends the wait,
 * and the helper with it, since it may still be waiting too - and takes it with
 * `receiveMessageOnPort`, which needs no event loop. The bytes travel as
 * they came.
 */
export function nodeHttp(interrupt: Uint8Array | null): HostHttp {
  return (method, url, headers, body, timeoutMs) => {
    const limit = timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    const { port, signal } = helperThread();
    Atomics.store(signal, 0, 0);
    port.postMessage({ method, url, headers, body: body ?? null, limit: MAX_RESPONSE_BYTES });
    const deadline = Date.now() + limit;
    for (;;) {
      Atomics.wait(signal, 0, 0, 20);
      const received = receiveMessageOnPort(port);
      if (received !== undefined) {
        const reply = received.message as HelperReply;
        if (reply.error !== undefined) {
          throw named("NetworkError", reply.error);
        }
        return { status: reply.status, headers: reply.headers, body: new Uint8Array(reply.body) };
      }
      if (interrupt && interrupt[0] === INTERRUPT_SIGINT) {
        // Taken here, and acknowledged, so the host sends it no more; left
        // for Pyodide, it would be raised as this call returns, unacknowledged.
        Atomics.store(interrupt, INTERRUPT_ACK_INDEX, 1);
        Atomics.store(interrupt, 0, 0);
        endHelper();
        return undefined;
      }
      if (Date.now() > deadline) {
        endHelper();
        const seconds = Math.round(limit / 100) / 10;
        throw named("TimeoutError", `${hostOf(url)} did not answer within ${seconds} second${seconds === 1 ? "" : "s"}`);
      }
    }
  };
}

type HelperReply =
  | { error: string }
  | { error?: undefined; status: number; headers: Record<string, string>; body: ArrayBuffer };

function named(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

let helper: { worker: Worker; port: MessagePort; signal: Int32Array } | null = null;

/** The thread that fetches, started on the first request and left idle after. */
function helperThread(): { port: MessagePort; signal: Int32Array } {
  if (helper === null) {
    const { port1, port2 } = new MessageChannel();
    const signal = new Int32Array(new SharedArrayBuffer(4));
    const worker = new Worker(HELPER_SOURCE, { eval: true, workerData: { port: port2, signal }, transferList: [port2] });
    // An idle helper must not keep the process alive.
    worker.unref();
    helper = { worker, port: port1, signal };
  }
  return helper;
}

/** Give up on the request in flight: the next one starts a new helper. */
function endHelper(): void {
  void helper?.worker.terminate();
  helper?.port.close();
  helper = null;
}

/**
 * The helper: `fetch` each request, read the body up to the limit, and
 * post the answer - the body transferred, not copied - before raising the
 * signal. Node's `fetch` has already undone any compression.
 */
const HELPER_SOURCE = `
const { workerData } = require("node:worker_threads");
const { port, signal } = workerData;

function reply(message, transfer) {
  port.postMessage(message, transfer);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
}

function reason(error) {
  let cause = error && error.cause;
  while (cause && cause.cause) cause = cause.cause;
  return String((cause && (cause.code || cause.message)) || (error && error.message) || error);
}

port.on("message", async (request) => {
  const host = (() => { try { return new URL(request.url).host; } catch { return request.url; } })();
  try {
    const init = { method: request.method, headers: request.headers, redirect: "follow" };
    if (request.body !== null) init.body = request.body;
    const response = await fetch(request.url, init);
    const headers = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > request.limit) {
        return reply({ error: "the answer from " + host + " is larger than " + Math.round(request.limit / 1048576) + " MB" });
      }
      chunks.push(chunk);
    }
    const body = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      body.set(chunk, at);
      at += chunk.byteLength;
    }
    reply({ status: response.status, headers, body: body.buffer }, [body.buffer]);
  } catch (error) {
    reply({ error: "could not connect to " + host + " (" + reason(error) + ")" });
  }
});
`;
