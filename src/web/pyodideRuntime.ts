import * as vscode from "vscode";
import {
  WorkerPythonRuntime,
  type WorkerHandle,
  type WorkerHandlers,
} from "../common/workerRuntime";
import type { WorkerOutbound } from "../common/workerProtocol";

const DEFAULT_INDEX_URL = "https://cdn.jsdelivr.net/pyodide/v0.29.3/full/";

/** Web host: Pyodide runs in a browser `Worker` loading assets over HTTP. */
export class WebPyodideRuntime extends WorkerPythonRuntime {
  constructor(private readonly extensionUri: vscode.Uri) {
    super();
  }

  protected resolveIndexUrl(): string {
    return (
      vscode.workspace.getConfiguration("pll").get<string>("pyodideIndexUrl") ??
      DEFAULT_INDEX_URL
    );
  }

  protected spawn(handlers: WorkerHandlers): WorkerHandle {
    const workerUri = vscode.Uri.joinPath(
      this.extensionUri,
      "dist",
      "web",
      "pyodideWorker.js",
    );
    const worker = new Worker(workerUri.toString(true));
    worker.onmessage = (event: MessageEvent<WorkerOutbound>) =>
      handlers.onMessage(event.data);
    worker.onerror = (event) =>
      handlers.onError(new Error(`Pyodide worker error: ${event.message}`));
    return {
      post: (msg) => worker.postMessage(msg),
      terminate: () => worker.terminate(),
    };
  }
}
