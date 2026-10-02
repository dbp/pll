#!/usr/bin/env node
/**
 * Smoke test for third-party package auto-loading and URL reads.
 *
 * Boots Pyodide the way the runtime does, then exercises the same load path
 * PLL uses for user code: `loadPackagesFromImports` (which pulls pandas +
 * numpy from the CDN fallback), followed by the `pyodide-http` shim plus a
 * Node XMLHttpRequest polyfill (the desktop worker's network path).
 *
 * URL reads hit a local HTTP server so the test does not depend on GitHub
 * or CORS.
 */
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { build } from "esbuild";
import { loadPyodide } from "pyodide";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

// The hosts' own regex, bundled, rather than a copy that could drift from it.
const bundled = await build({
  entryPoints: [resolve(ROOT, "src/common/packages.ts")],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const { NETWORK_IMPORT_RE } = await import(
  "data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64")
);

const CARS_CSV = "name,mpg\nvw,29\nhonda,33\nford,18\n";

let ok = true;
function expect(cond, msg) {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    ok = false;
  }
}

/**
 * Same idea as src/desktop/xhrPolyfill.ts + syncHttp.ts: Node has no
 * sync XHR, so a child process does async fetch and we block on it.
 */
function installNodeXHR() {
  if (typeof globalThis.crossOriginIsolated === "undefined") {
    globalThis.crossOriginIsolated = false;
  }
  if (typeof globalThis.XMLHttpRequest === "function") {
    return;
  }
  globalThis.XMLHttpRequest = class XMLHttpRequest {
    method = "GET";
    url = "";
    responseType = "";
    status = 0;
    statusText = "";
    response = null;
    responseText = "";
    readyState = 0;
    reqHeaders = {};
    resHeaders = {};

    open(method, url) {
      this.method = method;
      this.url = url;
      this.readyState = 1;
    }

    setRequestHeader(name, value) {
      this.reqHeaders[name] = value;
    }

    overrideMimeType() {}

    send(body) {
      const payload = JSON.stringify({
        method: this.method || "GET",
        url: this.url,
        headers: this.reqHeaders,
        body:
          body == null || body === ""
            ? null
            : Buffer.from(
                typeof body === "string" ? body : Buffer.from(body),
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
      const out = execFileSync(process.execPath, ["-e", script], {
        input: payload,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      });
      const parsed = JSON.parse(out.toString("utf8"));
      const bytes = new Uint8Array(Buffer.from(parsed.body ?? "", "base64"));
      this.status = parsed.status;
      this.statusText = parsed.status >= 200 && parsed.status < 300 ? "OK" : "";
      this.resHeaders = parsed.headers ?? {};
      this.readyState = 4;
      if (this.responseType === "arraybuffer") {
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        this.response = copy.buffer;
        this.responseText = "";
      } else {
        const text = new TextDecoder("latin1").decode(bytes);
        this.response = text;
        this.responseText = text;
      }
    }

    getAllResponseHeaders() {
      return Object.entries(this.resHeaders)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\r\n");
    }
  };
}

/**
 * Serve the CSV from a child process. The XHR polyfill uses
 * `execFileSync`, which blocks this event loop, so an in-process
 * `createServer` would deadlock.
 */
function startCsvServer() {
  return new Promise((resolveServer, reject) => {
    const script = `
const http = require("node:http");
const csv = ${JSON.stringify(CARS_CSV)};
const server = http.createServer((_req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/csv",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(csv);
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(String(server.address().port));
});
`;
    const child = spawn(process.execPath, ["-e", script], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    child.once("error", reject);
    child.stdout.once("data", (chunk) => {
      const port = Number(String(chunk).trim());
      resolveServer({
        url: `http://127.0.0.1:${port}/cars.csv`,
        close() {
          child.kill();
        },
      });
    });
  });
}

async function main() {
  installNodeXHR();

  const indexURL = resolve(ROOT, "node_modules", "pyodide");
  const pyodide = await loadPyodide({ indexURL });
  pyodide.runPython(readFileSync(resolve(ROOT, "src/common/pyodideBootstrap.py"), "utf8"));

  const userCode = [
    "import pandas as pd",
    "import io",
    "df = pd.read_csv(io.StringIO('name,mpg\\nvw,29\\nhonda,33\\nford,18\\n'))",
    "(len(df), df[df['mpg'] >= 30]['name'].tolist())",
  ].join("\n");

  console.log("\n[1] loadPackagesFromImports pulls pandas");
  await pyodide.loadPackagesFromImports(userCode);
  const version = pyodide.runPython("import pandas; pandas.__version__");
  console.log(`    pandas ${version}`);
  expect(typeof version === "string" && version.length > 0, "pandas should be importable");

  console.log("\n[2] the code the tool needs actually runs");
  const res = pyodide.runPython(userCode).toJs();
  console.log(`    rows=${res[0]} efficient=${JSON.stringify(res[1])}`);
  expect(res[0] === 3, "expected 3 rows, got " + res[0]);
  expect(
    Array.isArray(res[1]) && res[1].join(",") === "honda",
    "expected only 'honda' at >=30 mpg, got " + JSON.stringify(res[1]),
  );

  console.log("\n[3] network imports trigger the pyodide-http shim");
  expect(NETWORK_IMPORT_RE.test(userCode), "pandas import should match NETWORK_IMPORT_RE");
  expect(!NETWORK_IMPORT_RE.test("import math\nprint(math.pi)"), "plain math import should not match");
  await pyodide.loadPackage("pyodide-http");
  pyodide.runPython("import pyodide_http as _ph; _ph.patch_all()");
  console.log("    pyodide-http loaded and patched (no error)");

  console.log("\n[4] pd.read_csv(url) via Node XHR polyfill + local HTTP");
  const { url, close } = await startCsvServer();
  try {
    const urlCode = [
      "import pandas as pd",
      `df = pd.read_csv(${JSON.stringify(url)})`,
      "(len(df), df[df['mpg'] >= 30]['name'].tolist())",
    ].join("\n");
    const urlRes = pyodide.runPython(urlCode).toJs();
    console.log(`    url=${url} rows=${urlRes[0]} efficient=${JSON.stringify(urlRes[1])}`);
    expect(urlRes[0] === 3, "URL read expected 3 rows, got " + urlRes[0]);
    expect(
      Array.isArray(urlRes[1]) && urlRes[1].join(",") === "honda",
      "URL read expected only 'honda' at >=30 mpg, got " + JSON.stringify(urlRes[1]),
    );
  } finally {
    close();
  }

  console.log(`\nsmoke-pandas: ${ok ? "ok" : "FAILED"}`);
  if (!ok) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
