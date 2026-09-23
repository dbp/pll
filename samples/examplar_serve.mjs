#!/usr/bin/env node
/**
 * Serve an Examplar bundle over http, the way a course would.
 *
 *     node samples/examplar_serve.mjs /tmp/hw.json
 *     node samples/examplar_serve.mjs /tmp/hw.json 9000
 *
 * Dependency-free, and small on purpose: publishing a bundle is one static
 * file, and the only thing that is not obvious is the headers.
 *
 * Those headers matter for the **web** build (vscode.dev, a codespace),
 * where the extension host is a browser and a bundle is a cross-origin
 * request. Each one is load-bearing and each failure is silent:
 *
 *   Access-Control-Allow-Origin      without it, no bundle at all
 *   Access-Control-Expose-Headers    without it the ETag is invisible to
 *                                    script, so nothing is ever cached
 *   Access-Control-Allow-Headers     without it the conditional request
 *                                    fails its preflight, so students stay
 *                                    pinned to the copy they cached first
 *
 * A real course would serve this from whatever already hosts the assignment
 * handout; the point of this file is what to configure there.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";

const file = resolve(process.argv[2] ?? "hw.json");
const port = Number(process.argv[3] ?? process.env.PORT ?? 8123);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "If-None-Match",
  "Access-Control-Expose-Headers": "ETag",
  // vscode.dev is cross-origin isolated.
  "Cross-Origin-Resource-Policy": "cross-origin",
};

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  let body;
  try {
    // Re-read each time, so rebuilding the bundle does not need a restart.
    body = await readFile(file);
  } catch (err) {
    console.error(`  500 ${req.url} - cannot read ${file}: ${err.message}`);
    res.writeHead(500, CORS);
    res.end("cannot read the bundle");
    return;
  }
  // Content-addressed, so a rebuild that changes nothing does not invalidate
  // anyone's cache.
  const etag = `"${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`;
  if (req.headers["if-none-match"] === etag) {
    console.log(`  304 ${req.url} (unchanged)`);
    res.writeHead(304, { ...CORS, ETag: etag });
    res.end();
    return;
  }
  console.log(`  200 ${req.url} (${body.length} bytes)`);
  res.writeHead(200, { ...CORS, "Content-Type": "application/json", ETag: etag });
  res.end(body);
});

server.listen(port, () => {
  console.log(`serving ${file}`);
  console.log(`put this in a student's file:\n\n    #examplar http://localhost:${port}/hw.json\n`);
});
