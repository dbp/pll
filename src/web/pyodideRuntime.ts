import * as vscode from "vscode";
import { Python } from "../run/python";
import type { WorkerOutbound } from "../pyodide/protocol";

/** The Pyodide this build was made with, on the CDN; set by esbuild. */
declare const PLL_PYODIDE_INDEX_URL: string;

/** Web host: Pyodide runs in a browser `Worker` loading assets over HTTP. */
export function webPython(extensionUri: vscode.Uri): Python {
  return new Python({
    indexUrl() {
      // Empty is as good as unset: there is no Pyodide at "".
      return vscode.workspace.getConfiguration("pll").get<string>("pyodideIndexUrl") || PLL_PYODIDE_INDEX_URL;
    },
    spawn(handlers) {
      const workerUri = vscode.Uri.joinPath(extensionUri, "dist", "web", "pyodideWorker.js");
      const worker = new Worker(workerUri.toString(true));
      worker.onmessage = (event: MessageEvent<WorkerOutbound>) => handlers.onMessage(event.data);
      worker.onerror = (event) => handlers.onError(new Error(`Pyodide worker error: ${event.message}`));
      return {
        post: (msg) => worker.postMessage(msg),
        terminate: () => worker.terminate(),
      };
    },
  });
}
