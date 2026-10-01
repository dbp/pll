#!/usr/bin/env node
/**
 * Publish `pll-python` to npm, logging in first when that is needed.
 *
 * Without a login, `npm publish` answers **404**, not 401: the registry
 * will not say whether a package exists to someone who may not be allowed
 * to see it, so "not logged in" and "no such package" look identical. That
 * is a confusing way to find out you have no token, so this checks first
 * and says which it is.
 *
 * `npm login --auth-type=web` is the browser flow: it prints a URL, opens
 * it where it can, and waits.
 *
 * Run from the repo root, after `pnpm run build` - which is what
 * `pnpm run cli:publish` does. Arguments are passed through to
 * `npm publish`, so a rehearsal is:
 *
 *   pnpm run build && node scripts/publish-cli.mjs --dry-run
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, "..", "dist-cli");

function fail(message) {
  console.error(`cli:publish: ${message}`);
  process.exit(1);
}

/** Run npm in dist-cli, with the terminal attached so login can prompt. */
function npm(args) {
  return spawnSync("npm", args, { cwd: DIST, stdio: "inherit" });
}

/** Who npm thinks we are, or null. Quiet: a 401 here is expected. */
function whoami() {
  const probe = spawnSync("npm", ["whoami"], { cwd: DIST, encoding: "utf8" });
  return probe.status === 0 ? probe.stdout.trim() : null;
}

if (!existsSync(join(DIST, "package.json"))) {
  fail(`${DIST} is not there. Run \`pnpm run build\` first.`);
}
const manifest = JSON.parse(readFileSync(join(DIST, "package.json"), "utf8"));

let user = whoami();
if (user === null) {
  console.log("Not logged in to npm. Opening the browser to sign in...");
  const login = npm(["login", "--auth-type=web"]);
  if (login.status !== 0) {
    fail("npm login did not complete, so nothing was published.");
  }
  user = whoami();
  if (user === null) {
    fail("still not logged in after npm login, so nothing was published.");
  }
}

console.log(`Publishing ${manifest.name}@${manifest.version} as ${user}.`);
const extra = process.argv.slice(2);
const published = npm(["publish", "--access", "public", ...extra]);
if (published.status !== 0) {
  fail(`npm publish exited ${published.status}.`);
}
