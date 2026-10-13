import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { Python } from "../run/python";
import type { WorkerOutbound } from "../pyodide/protocol";

export interface NodeRuntimePaths {
  /** Directories to look for Pyodide's assets in, most preferred first. */
  indexUrlCandidates: string[];
  /** The bundled worker entry to spawn. */
  workerPath: string;
  /** Shown when no candidate holds the assets. */
  missingAssetsHint: string;
  /** Longest Python may take to start; no limit when absent. */
  startTimeoutMs?: number;
  /**
   * Where downloaded packages are kept, given where Pyodide's assets are;
   * beside them when absent, or when this gives nothing.
   */
  packageCacheDir?: (indexUrl: string) => string | undefined;
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
export function desktopPython(paths: NodeRuntimePaths): Python {
  return new Python({
    indexUrl() {
      const found = paths.indexUrlCandidates.find((dir) => fs.existsSync(path.join(dir, "pyodide.asm.wasm")));
      if (!found) {
        throw new Error(paths.missingAssetsHint);
      }
      return found;
    },
    packageCacheDir: paths.packageCacheDir,
    startTimeoutMs: paths.startTimeoutMs,
    spawn(handlers) {
      const worker = new Worker(paths.workerPath);
      worker.on("message", (msg: WorkerOutbound) => handlers.onMessage(msg));
      // A Node worker that throws is ended, and `exit` follows: that is what
      // fails its requests, once, as Python lost. The error itself goes to
      // the log.
      worker.on("error", (err) => console.error("Pyodide worker failed:", err));
      worker.on("exit", () => handlers.onExit?.());
      return {
        post: (msg) => worker.postMessage(msg),
        terminate: () => void worker.terminate(),
      };
    },
  });
}
