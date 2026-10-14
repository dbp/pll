import { parentPort } from "node:worker_threads";
import { createWorkerHost, type PyodideInstance } from "../pyodide/worker";
import type { WorkerInbound } from "../pyodide/protocol";
import { nodeHttp } from "./syncHttp";

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
  http: nodeHttp,
  async loadPyodide(indexUrl, packageCacheDir) {
    ensureStdioFds();
    const { loadPyodide } = await import("pyodide");
    return (await loadPyodide({
      indexURL: indexUrl,
      ...(packageCacheDir ? { packageCacheDir } : {}),
    })) as unknown as PyodideInstance;
  },
});

port.on("message", (data: WorkerInbound) => void handle(data));
