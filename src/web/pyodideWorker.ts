/// <reference lib="WebWorker" />
import { createWorkerHost, type PyodideInstance } from "../pyodide/worker";
import type { HostHttp } from "../pyodide/install";
import type { WorkerInbound } from "../pyodide/protocol";

declare const self: DedicatedWorkerGlobalScope & {
  loadPyodide?: (config: { indexURL: string }) => Promise<PyodideInstance>;
};

/**
 * Python's network in a browser: a synchronous XHR, which a worker may wait
 * for. It cannot be stopped part way; the bytes arrive as they were sent.
 */
const webHttp: HostHttp = (method, url, headers, body, timeoutMs) => {
  const xhr = new XMLHttpRequest();
  xhr.open(method, url, false);
  xhr.responseType = "arraybuffer";
  xhr.timeout = timeoutMs;
  for (const [name, value] of Object.entries(headers)) {
    xhr.setRequestHeader(name, value);
  }
  try {
    xhr.send((body ?? null) as XMLHttpRequestBodyInit | null);
  } catch (err) {
    const error = new Error(
      (err as Error).name === "TimeoutError"
        ? `${new URL(url).host} did not answer within ${timeoutMs / 1000} seconds`
        : // In a browser a failed cross-origin request looks like this, and
          // it is the likeliest cause by far.
          `could not reach ${new URL(url).host}; if that address is not your own, it may not allow other sites to read it`,
    );
    error.name = (err as Error).name === "TimeoutError" ? "TimeoutError" : "NetworkError";
    throw error;
  }
  const answer: Record<string, string> = {};
  for (const line of xhr.getAllResponseHeaders().split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      answer[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
  }
  return { status: xhr.status, headers: answer, body: new Uint8Array(xhr.response as ArrayBuffer) };
};

const handle = createWorkerHost({
  post: (msg) => self.postMessage(msg),
  http: () => webHttp,
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
