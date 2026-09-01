import { execFileSync } from "node:child_process";

export interface SyncHttpResult {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

/**
 * Synchronous HTTP(S) for the desktop Pyodide worker. Node has no sync
 * `fetch` / XHR, so this runs a short child process that uses async fetch
 * and writes the response on stdout. Used by the XMLHttpRequest polyfill
 * so `pyodide-http` (and therefore `pd.read_csv(url)`) works on desktop.
 *
 * `execFileSync` blocks this thread's event loop. That is fine for remote
 * URLs; do not point it at an HTTP server running in this same thread.
 */
export function syncHttpRequest(opts: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string | null;
}): SyncHttpResult {
  const payload = JSON.stringify({
    method: opts.method || "GET",
    url: opts.url,
    headers: opts.headers ?? {},
    body:
      opts.body == null || opts.body === ""
        ? null
        : Buffer.from(
            typeof opts.body === "string" ? opts.body : Buffer.from(opts.body),
          ).toString("base64"),
  });
  const script = `
const fs = require("node:fs");
const raw = fs.readFileSync(0, "utf8");
const req = JSON.parse(raw);
const init = { method: req.method, headers: req.headers };
if (req.body) init.body = Buffer.from(req.body, "base64");
fetch(req.url, init).then(async (r) => {
  const hop = new Set(["transfer-encoding", "content-encoding", "connection", "keep-alive"]);
  const headers = {};
  r.headers.forEach((v, k) => {
    if (!hop.has(k.toLowerCase())) headers[k] = v;
  });
  const raw = Buffer.from(await r.arrayBuffer());
  headers["content-length"] = String(raw.length);
  const body = raw.toString("base64");
  process.stdout.write(JSON.stringify({ status: r.status, headers, body }));
}).catch((e) => {
  process.stderr.write(String(e && e.stack ? e.stack : e));
  process.exit(1);
});
`;
  let out: Buffer;
  try {
    out = execFileSync(process.execPath, ["-e", script], {
      input: payload,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`HTTP request failed: ${msg}`);
  }
  const parsed = JSON.parse(out.toString("utf8")) as {
    status: number;
    headers: Record<string, string>;
    body: string;
  };
  return {
    status: parsed.status,
    headers: parsed.headers ?? {},
    body: new Uint8Array(Buffer.from(parsed.body ?? "", "base64")),
  };
}
