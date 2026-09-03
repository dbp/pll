import { parentPort } from "node:worker_threads";
import { createWorkerHost, type PyodideInstance } from "../common/workerHost";
import type { WorkerInbound } from "../common/workerProtocol";
import { installNodeXHR } from "./xhrPolyfill";

if (!parentPort) {
  throw new Error("desktop pyodide worker must be started as a worker_thread");
}
const port = parentPort;

/**
 * Pyodide's Node loader expects real stdio file descriptors; the extension
 * host's worker threads do not always have them.
 */
function ensureStdioFds(): void {
  const streams: Array<[NodeJS.ReadStream | NodeJS.WriteStream, number]> = [
    [process.stdin, 0],
    [process.stdout, 1],
    [process.stderr, 2],
  ];
  for (const [stream, fd] of streams) {
    if (stream && (stream as { fd?: number }).fd == null) {
      Object.defineProperty(stream, "fd", { value: fd });
    }
  }
}

const handle = createWorkerHost({
  post: (msg) => port.postMessage(msg),
  stdinUnavailableMessage: "input() is unavailable (SharedArrayBuffer was not provided).",
  async loadPyodide(indexUrl) {
    ensureStdioFds();
    // Installed up front so the `pyodide-http` shim has an XMLHttpRequest to
    // patch if the program later reads a URL.
    installNodeXHR();
    const { loadPyodide } = await import("pyodide");
    return (await loadPyodide({ indexURL: indexUrl })) as unknown as PyodideInstance;
  },
});

port.on("message", (data: WorkerInbound) => void handle(data));
