import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import {
  WorkerPythonRuntime,
  type WorkerHandle,
  type WorkerHandlers,
} from "../common/workerRuntime";
import type { WorkerOutbound } from "../common/workerProtocol";

/**
 * Desktop host: Pyodide lives in a `worker_threads` Worker so `input()` can
 * block without freezing the extension host, and so live output can stream
 * the same way as the web worker. Assets are loaded from disk.
 */
export class DesktopPyodideRuntime extends WorkerPythonRuntime {
  constructor(private readonly extensionPath: string) {
    super();
  }

  protected resolveIndexUrl(): string {
    const candidates = [
      path.join(this.extensionPath, "vendor", "pyodide"),
      path.join(this.extensionPath, "node_modules", "pyodide"),
    ];
    const found = candidates.find((dir) =>
      fs.existsSync(path.join(dir, "pyodide.asm.wasm")),
    );
    if (!found) {
      throw new Error(
        "Pyodide runtime assets not found. Run `pnpm run build` to copy them into vendor/pyodide.",
      );
    }
    return found;
  }

  protected spawn(handlers: WorkerHandlers): WorkerHandle {
    const workerPath = path.join(
      this.extensionPath,
      "dist",
      "desktop",
      "pyodideWorker.js",
    );
    const worker = new Worker(workerPath);
    worker.on("message", (msg: WorkerOutbound) => handlers.onMessage(msg));
    worker.on("error", (err) =>
      handlers.onError(err instanceof Error ? err : new Error(String(err))),
    );
    return {
      post: (msg) => worker.postMessage(msg),
      terminate: () => void worker.terminate(),
    };
  }
}
