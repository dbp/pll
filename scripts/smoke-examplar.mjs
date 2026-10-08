#!/usr/bin/env node
/**
 * Examplar: the `#examplar` directive, and fetching bundles with a cache.
 *
 * The fetch path is covered against a real HTTP server rather than a stub,
 * because the behaviour that matters is conditional requests and what
 * happens when the server is *gone* - neither of which a hand-written fake
 * would get right by accident.
 *
 * The bundle primitives themselves need Pyodide and are covered by
 * `smoke-examplar-build.mjs`.
 */
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { expect, passed } from "./lib/check.mjs";
import { importSource } from "./lib/bundle.mjs";

async function load() {
  const mod = await importSource(`export * from "./src/common/examplarSource";
export { cacheDir, createFileStore } from "./src/cli/bundleStore";
`);
  return mod;
}

/** A server that serves `body` with an ETag and counts requests. */
function startServer(body) {
  let etag = '"v1"';
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, ifNoneMatch: req.headers["if-none-match"] ?? null });
    if (req.url === "/missing.json") {
      res.writeHead(404);
      res.end("nope");
      return;
    }
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ETag: etag });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json", ETag: etag });
    res.end(body());
  });
  return new Promise((res) => {
    server.listen(0, "127.0.0.1", () =>
      res({
        server,
        seen,
        base: `http://127.0.0.1:${server.address().port}`,
        bump: (next) => {
          etag = next;
        },
      }),
    );
  });
}

async function main() {
  const mod = await load();
  const { parseExamplarDirective, validateBundleUrl, loadBundle, createFileStore } = mod;

  console.log("\n[1] the directive: found, absent, malformed, duplicated");
  {
    const found = parseExamplarDirective(
      ["#level beginner", "", "#examplar https://c.example/hw3.json", "", "def test_x():", "    pass"].join("\n"),
    );
    expect(found.kind === "found", `expected found, got ${found.kind}`);
    expect(found.url === "https://c.example/hw3.json", `url: ${found.url}`);
    expect(found.line === 3, `line: ${found.line}`);

    expect(parseExamplarDirective("x = 1\n").kind === "none", "no directive -> none");
    expect(
      parseExamplarDirective("# examplar https://c.example/a.json\n").kind === "found",
      "a space after the hash is still a directive",
    );
    // Only a whole line counts, so prose and trailing text are not directives.
    expect(
      parseExamplarDirective("# see #examplar https://c.example/a.json for details\n").kind === "none",
      "a URL mentioned in prose is not a directive",
    );
    expect(
      parseExamplarDirective("x = 1  # examplar https://c.example/a.json\n").kind === "none",
      "a trailing comment is not a directive",
    );

    const dup = parseExamplarDirective(
      "#examplar https://c.example/a.json\n#examplar https://c.example/b.json\n",
    );
    expect(dup.kind === "error", `two directives should be an error, got ${dup.kind}`);
    expect(/more than one/.test(dup.message), `message: ${dup.message}`);
    console.log(`    duplicate: ${dup.message}`);
  }

  console.log("\n[2] only addresses a student can trust");
  {
    expect(validateBundleUrl("https://c.example/a.json") === null, "https is fine");
    expect(validateBundleUrl("http://localhost:8080/a.json") === null, "http on localhost is fine");
    expect(validateBundleUrl("http://127.0.0.1:8080/a.json") === null, "http on 127.0.0.1 is fine");
    expect(validateBundleUrl("http://evil.example/a.json") !== null, "plain http elsewhere is refused");
    expect(validateBundleUrl("file:///etc/passwd") !== null, "file:// is refused");
    expect(validateBundleUrl("not a url") !== null, "nonsense is refused");
    const bad = parseExamplarDirective("#examplar http://evil.example/a.json\n");
    expect(bad.kind === "error", "a bad url in a directive is an error");
    console.log(`    ${bad.message}`);
  }

  const work = mkdtempSync(join(tmpdir(), "pll-examplar-"));
  let payload = JSON.stringify({ examplar: 1, provides: ["shout"], wheats: [], chaffs: [] });
  const srv = await startServer(() => payload);

  console.log("\n[3] first fetch stores it; the second is conditional");
  {
    const store = createFileStore(join(work, "cache"));
    const first = await loadBundle(`${srv.base}/hw.json`, store);
    expect(first.json === payload, `first fetch should return the body, got ${first.error ?? first.json}`);
    expect(first.fromCache === false, "the first fetch is not from cache");
    expect(readdirSync(join(work, "cache")).length === 1, "it should be written to the cache");

    const second = await loadBundle(`${srv.base}/hw.json`, store);
    expect(second.json === payload, "the second fetch still yields the bundle");
    expect(second.fromCache === true, "a 304 should be served from cache");
    expect(srv.seen[1].ifNoneMatch === '"v1"', `expected a conditional request, got ${srv.seen[1].ifNoneMatch}`);
    console.log(`    request 2 sent If-None-Match: ${srv.seen[1].ifNoneMatch} -> served from cache`);
  }

  console.log("\n[4] a new ETag replaces the cached copy");
  {
    const store = createFileStore(join(work, "cache"));
    payload = JSON.stringify({ examplar: 1, provides: ["shout", "total"], wheats: [], chaffs: [] });
    srv.bump('"v2"');
    const fresh = await loadBundle(`${srv.base}/hw.json`, store);
    expect(fresh.fromCache === false, "a changed bundle is a fresh fetch");
    expect(fresh.json === payload, "and has the new contents");
    const again = await loadBundle(`${srv.base}/hw.json`, store);
    expect(again.fromCache === true && again.json === payload, "then caches under the new etag");
    console.log("    updated, then cached again");
  }

  console.log("\n[4b] a page that is not a bundle never replaces the cached copy");
  {
    const store = createFileStore(join(work, "cache"));
    const good = payload;
    // A login page, served 200 under a new ETag.
    payload = "<html><body>Please sign in</body></html>";
    srv.bump('"v3"');
    const page = await loadBundle(`${srv.base}/hw.json`, store);
    expect(page.json === good && page.fromCache === true, `the cached copy is used: ${page.error ?? page.note}`);
    expect(/did not return a bundle/.test(page.note ?? ""), `and it says why: ${page.note}`);
    payload = good;
    srv.bump('"v2"');
    const fresh = await loadBundle(`${srv.base}/hw.json`, createFileStore(join(work, "cache-page")));
    expect(fresh.json === good, "a good bundle still loads");
    const cold = await loadBundle(
      `${srv.base}/hw.json`,
      createFileStore(join(work, "cache-cold")),
      async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => "<html></html>" }),
    );
    expect(cold.json === undefined && /did not return an Examplar bundle/.test(cold.error ?? ""), `with nothing cached, an error: ${cold.error}`);
    const unwritable = await loadBundle(`${srv.base}/hw.json`, {
      read: async () => undefined,
      write: async () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
    });
    expect(unwritable.json === good && /could not keep a copy for offline use/.test(unwritable.note ?? ""), `an unwritable cache is said: ${unwritable.note}`);
    console.log(`    ${page.note}`);
  }

  console.log("\n[4c] a cache variable that is empty or relative is ignored");
  {
    const saved = { PLL_CACHE_DIR: process.env.PLL_CACHE_DIR, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME };
    process.env.PLL_CACHE_DIR = "";
    process.env.XDG_CACHE_HOME = "relative/cache";
    const dir = mod.cacheDir();
    expect(isAbsolute(dir) && dir.endsWith(join(".cache", "pll-python", "examplar")), `not under the current folder: ${dir}`);
    process.env.XDG_CACHE_HOME = join(work, "xdg");
    expect(mod.cacheDir() === join(work, "xdg", "pll-python", "examplar"), `an absolute one is used: ${mod.cacheDir()}`);
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  console.log("\n[5] a missing bundle is an error, not a silent pass");
  {
    const store = createFileStore(join(work, "cache2"));
    const missing = await loadBundle(`${srv.base}/missing.json`, store);
    expect(missing.json === undefined, "404 with no cache yields no bundle");
    expect(/404/.test(missing.error ?? ""), `expected the status in the error, got ${missing.error}`);
    console.log(`    ${missing.error}`);
  }

  console.log("\n[6] offline: a cached copy is a note, no cache is an error");
  {
    const store = createFileStore(join(work, "cache"));
    const url = `${srv.base}/hw.json`;
    await new Promise((res) => srv.server.close(res));

    const offline = await loadBundle(url, store);
    expect(offline.json === payload, "a cached bundle survives the server going away");
    expect(offline.fromCache === true, "and is marked as cached");
    expect(/could not reach/.test(offline.note ?? ""), `expected a note, got ${offline.note}`);
    console.log(`    with cache: ${offline.note}`);

    const cold = await loadBundle(url, createFileStore(join(work, "cache3")));
    expect(cold.json === undefined, "no cache and no server yields no bundle");
    expect(/nothing is cached/.test(cold.error ?? ""), `expected an error, got ${cold.error}`);
    console.log(`    without cache: ${cold.error}`);
  }

  console.log("\n[7] an oversized bundle is refused");
  {
    const big = "x".repeat(mod.MAX_BUNDLE_BYTES + 1);
    const fake = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => big,
    });
    const cold = await loadBundle("https://c.example/big.json", createFileStore(join(work, "cache4")), fake);
    expect(cold.json === undefined, "an oversized bundle should not be used");
    expect(/limit/.test(cold.error ?? ""), `expected a size error, got ${cold.error}`);
    console.log(`    ${cold.error}`);
  }

  console.log("\n[8] a corrupt cache entry is ignored, not fatal");
  {
    const dir = join(work, "cache5");
    const store = createFileStore(dir);
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "deadbeef.json"), "{not json", "utf8");
    const got = await store.read("https://c.example/whatever.json");
    expect(got === undefined, "an unreadable entry reads as a miss");
    console.log("    treated as a cache miss");
  }

  rmSync(work, { recursive: true, force: true });
  if (!passed()) {
    console.error("\nsmoke-examplar: FAILED");
    process.exit(1);
  }
  console.log("\nsmoke-examplar: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
