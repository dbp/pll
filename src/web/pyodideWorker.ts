/// <reference lib="WebWorker" />
import { createWorkerHost, type PyodideInstance } from "../common/workerHost";
import type { WorkerInbound } from "../common/workerProtocol";

declare const self: DedicatedWorkerGlobalScope & {
  loadPyodide?: (config: { indexURL: string }) => Promise<PyodideInstance>;
};

const handle = createWorkerHost({
  post: (msg) => self.postMessage(msg),
  stdinUnavailableMessage:
    "input() needs cross-origin isolation (SharedArrayBuffer). " +
    "Use `pnpm run test-web` or a vscode.dev session that sets COI.",
  async loadPyodide(indexUrl) {
    const normalized = indexUrl.endsWith("/") ? indexUrl : indexUrl + "/";
    self.importScripts(normalized + "pyodide.js");
    if (!self.loadPyodide) {
      throw new Error("loadPyodide not available after importScripts");
    }
    return self.loadPyodide({ indexURL: normalized });
  },
});

self.onmessage = (event: MessageEvent<WorkerInbound>) => void handle(event.data);
