import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import {
  WorkerPythonRuntime,
  type WorkerHandle,
  type WorkerHandlers,
} from "../common/workerRuntime";
import type { WorkerOutbound } from "../common/workerProtocol";

export interface NodeRuntimePaths {
  /** Directories to look for Pyodide's assets in, most preferred first. */
  indexUrlCandidates: string[];
  /** The bundled worker entry to spawn. */
  workerPath: string;
  /** Shown when no candidate holds the assets. */
  missingAssetsHint: string;
}

/**
 * Node host: Pyodide lives in a `worker_threads` Worker so `input()` can
 * block without freezing the caller, and so live output can stream the same
 * way as the web worker. Assets are loaded from disk.
 *
 * Shared by the VS Code desktop extension and the `pll` command line, which
 * differ only in where their assets and worker bundle sit - hence the paths
 * being injected rather than derived here.
 */
export class DesktopPyodideRuntime extends WorkerPythonRuntime {
  constructor(private readonly paths: NodeRuntimePaths) {
    super();
  }

  protected resolveIndexUrl(): string {
    const found = this.paths.indexUrlCandidates.find((dir) =>
      fs.existsSync(path.join(dir, "pyodide.asm.wasm")),
    );
    if (!found) {
      throw new Error(this.paths.missingAssetsHint);
    }
    return found;
  }

  protected spawn(handlers: WorkerHandlers): WorkerHandle {
    const worker = new Worker(this.paths.workerPath);
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
