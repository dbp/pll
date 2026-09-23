import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import type { BundleStore, CachedBundle } from "../common/examplarSource";

/**
 * Cache fetched bundles on disk, so a student without a network - or an
 * autograder run offline - still gets their Examplar feedback.
 *
 * Keyed by a hash of the URL rather than by anything derived from it: a URL
 * is not a safe filename, and two assignments can share a basename.
 */
export function cacheDir(): string {
  const base =
    process.env.PLL_CACHE_DIR ??
    process.env.XDG_CACHE_HOME ??
    (homedir() ? path.join(homedir(), ".cache") : tmpdir());
  return path.join(base, "pll-python", "examplar");
}

export function createFileStore(dir: string = cacheDir()): BundleStore {
  const fileFor = (url: string) =>
    path.join(dir, createHash("sha256").update(url).digest("hex").slice(0, 32) + ".json");

  return {
    async read(url) {
      try {
        const raw = await fs.readFile(fileFor(url), "utf8");
        const entry = JSON.parse(raw) as CachedBundle & { url?: string };
        // Guard against a hash collision, however unlikely: a wrong bundle
        // would produce baffling feedback.
        if (entry.url !== undefined && entry.url !== url) return undefined;
        return typeof entry.json === "string" ? { json: entry.json, etag: entry.etag } : undefined;
      } catch {
        return undefined;
      }
    },
    async write(url, entry) {
      await fs.mkdir(dir, { recursive: true });
      const body = JSON.stringify({ url, json: entry.json, etag: entry.etag });
      // Write-then-rename, so an interrupted run cannot leave a half file
      // that later parses as valid JSON.
      const target = fileFor(url);
      const temp = `${target}.${process.pid}.tmp`;
      await fs.writeFile(temp, body, "utf8");
      await fs.rename(temp, target);
    },
  };
}
