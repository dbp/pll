import { MessageChannel, type MessagePort, receiveMessageOnPort, Worker } from "node:worker_threads";
import { INTERRUPT_SIGINT } from "../common/interruptBuffer";

export interface SyncHttpResult {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface SyncHttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string | null;
  /** Milliseconds for the whole request, body and all; 0 for `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** The interrupt buffer: a Stop written there ends the wait. */
  interrupt?: Uint8Array | null;
}

/** How long a request may take when the program did not say. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** The largest response read. */
export const MAX_RESPONSE_BYTES = 256 * 1024 * 1024;

/**
 * Synchronous HTTP(S) for the desktop Pyodide worker. Node has no
 * synchronous `fetch`, so a helper thread fetches, and this thread waits
 * for its answer - in 20 ms slices, so a Stop or the time limit ends the
 * wait - and takes it with `receiveMessageOnPort`, which needs no event
 * loop. The bytes travel as they came.
 *
 * Errors are thrown with the name a browser's XHR uses - `NetworkError`,
 * `TimeoutError`, `AbortError` for a Stop - and a short message, so the
 * Python side can tell them apart and none of this code reaches a student.
 */
export function syncHttpRequest(request: SyncHttpRequest): SyncHttpResult {
  const thread = helperThread();
  const id = ++lastId;
  const timeoutMs = request.timeoutMs && request.timeoutMs > 0 ? request.timeoutMs : DEFAULT_TIMEOUT_MS;
  Atomics.store(thread.signal, 0, 0);
  thread.port.postMessage({
    id,
    method: request.method || "GET",
    url: request.url,
    headers: request.headers ?? {},
    body: request.body == null || request.body === "" ? null : request.body,
    timeoutMs,
    limit: MAX_RESPONSE_BYTES,
  });
  for (;;) {
    Atomics.wait(thread.signal, 0, 0, 20);
    const received = receiveMessageOnPort(thread.port);
    if (received !== undefined) {
      const reply = received.message as HelperReply;
      if (reply.id === id) {
        if (reply.error) {
          throw named(reply.error.name, reply.error.message);
        }
        const body = reply.body ? new Uint8Array(reply.body) : new Uint8Array(0);
        return { status: reply.status ?? 0, headers: reply.headers ?? {}, body };
      }
      // An answer to a request a Stop gave up on.
      Atomics.store(thread.signal, 0, 0);
      continue;
    }
    if (request.interrupt && request.interrupt[0] === INTERRUPT_SIGINT) {
      thread.port.postMessage({ cancel: id });
      throw named("AbortError", "Stopped.");
    }
  }
}

interface HelperReply {
  id: number;
  status?: number;
  headers?: Record<string, string>;
  body?: ArrayBuffer;
  error?: { name: string; message: string };
}

function named(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

let lastId = 0;
let helper: { port: MessagePort; signal: Int32Array } | null = null;

/** The thread that fetches, started on the first request and left idle after. */
function helperThread(): { port: MessagePort; signal: Int32Array } {
  if (helper !== null) {
    return helper;
  }
  const { port1, port2 } = new MessageChannel();
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(HELPER_SOURCE, {
    eval: true,
    workerData: { port: port2, signal },
    transferList: [port2],
  });
  // An idle helper must not keep the process alive.
  worker.unref();
  helper = { port: port1, signal };
  return helper;
}

/**
 * The helper: `fetch` each request, read the body up to the limit, and
 * post the answer - the body transferred, not copied - before raising the
 * signal. The error names are a browser's.
 */
const HELPER_SOURCE = `
const { workerData } = require("node:worker_threads");
const { port, signal } = workerData;
const running = new Map();
const hop = new Set(["transfer-encoding", "content-encoding", "connection", "keep-alive"]);

function reply(message, transfer) {
  port.postMessage(message, transfer);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
}

function reason(error) {
  let cause = error && error.cause;
  while (cause && cause.cause) cause = cause.cause;
  const code = (cause && (cause.code || cause.message)) || (error && error.message) || String(error);
  return String(code);
}

port.on("message", async (request) => {
  if (request.cancel !== undefined) {
    running.get(request.cancel)?.abort();
    return;
  }
  const controller = new AbortController();
  running.set(request.id, controller);
  const timer = setTimeout(() => controller.abort("timeout"), request.timeoutMs);
  const host = (() => { try { return new URL(request.url).host; } catch { return request.url; } })();
  try {
    const init = { method: request.method, headers: request.headers, signal: controller.signal, redirect: "follow" };
    if (request.body !== null) init.body = request.body;
    const response = await fetch(request.url, init);
    const headers = {};
    response.headers.forEach((value, key) => {
      if (!hop.has(key.toLowerCase())) headers[key] = value;
    });
    const chunks = [];
    let size = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > request.limit) {
          controller.abort("limit");
          throw Object.assign(new Error("limit"), { pllLimit: true });
        }
        chunks.push(chunk);
      }
    }
    const body = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      body.set(chunk, at);
      at += chunk.byteLength;
    }
    headers["content-length"] = String(size);
    reply({ id: request.id, status: response.status, headers, body: body.buffer }, [body.buffer]);
  } catch (error) {
    let failure;
    if (error && error.pllLimit) {
      failure = { name: "NetworkError", message: "the answer from " + host + " is larger than " + Math.round(request.limit / 1048576) + " MB" };
    } else if (controller.signal.aborted && controller.signal.reason === "timeout") {
      const seconds = Math.round(request.timeoutMs / 100) / 10;
      failure = { name: "TimeoutError", message: host + " did not answer within " + seconds + (seconds === 1 ? " second" : " seconds") };
    } else if (controller.signal.aborted) {
      failure = { name: "AbortError", message: "Stopped." };
    } else {
      failure = { name: "NetworkError", message: "could not connect to " + host + " (" + reason(error) + ")" };
    }
    reply({ id: request.id, error: failure });
  } finally {
    clearTimeout(timer);
    running.delete(request.id);
  }
});
`;
