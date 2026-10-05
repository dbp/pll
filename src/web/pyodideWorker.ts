/// <reference lib="WebWorker" />
import { createWorkerHost, type PyodideInstance } from "../common/workerHost";
import type { WorkerInbound } from "../common/workerProtocol";

declare const self: DedicatedWorkerGlobalScope & {
  loadPyodide?: (config: { indexURL: string }) => Promise<PyodideInstance>;
};

const handle = createWorkerHost({
  post: (msg) => self.postMessage(msg),
  stdinUnavailableMessage:
    "input() does not work in this browser tab, which is not cross-origin isolated. " +
    "It works in VS Code on a computer, and in a vscode.dev page opened with cross-origin isolation.",
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
