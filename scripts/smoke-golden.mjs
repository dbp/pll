#!/usr/bin/env node
/**
 * Golden outputs: every program in `golden/cases.mjs`, run through the real
 * CLI, must print exactly what `golden/expected.txt` says it printed.
 *
 * This is the test for wording. The unit tests pin what each explainer does
 * with an error; this pins what a student actually reads, end to end, for a
 * corpus that reaches every explainer, rule, library check and static
 * finding. A change in wording - intended or not - shows up here as a diff
 * of the text a student would see.
 *
 *   node scripts/smoke-golden.mjs            compare, and print what differs
 *   node scripts/smoke-golden.mjs --update   accept the current output
 *   node scripts/smoke-golden.mjs NAME...    only these cases (no --update)
 *
 * After `--update`, read the diff of `expected.txt` before keeping it: that
 * diff is the review.
 *
 * Requires `pnpm run build` so dist-cli/ exists.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CASES } from "./golden/cases.mjs";
import { ROOT } from "./lib/bundle.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(ROOT, "dist-cli", "cli.cjs");
const EXPECTED = join(HERE, "golden", "expected.txt");
const PARALLEL = 4;
const TIMEOUT_MS = 120_000;

/** One case's output, as text a reviewer can read in a diff. */
function render(name, { code, stdout, stderr }) {
  const stream = (label, text) => {
    if (!text) return "";
    const lines = text.split("\n");
    const ended = lines.at(-1) === "";
    if (ended) lines.pop();
    return `${label}:\n${lines.map((l) => `  ${l}`).join("\n")}\n${ended ? "" : "  (no newline at end)\n"}`;
  };
  return `=== ${name} (exit ${code})\n${stream("stdout", stdout)}${stream("stderr", stderr)}`;
}

/** The rendered text, split back into one block per case. */
function blocks(text) {
  const out = new Map();
  for (const block of text.split(/^(?==== )/m)) {
    const name = /^=== (\S+)/.exec(block)?.[1];
    if (name) out.set(name, block);
  }
  return out;
}

function runCase(work, c, vars) {
  const dir = mkdtempSync(join(work, `${c.name}-`));
  const fill = (text) => text.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key]);
  writeFileSync(join(dir, "student.py"), fill(c.code.join("\n")) + "\n");
  for (const [name, text] of Object.entries(c.files ?? {})) writeFileSync(join(dir, name), text);
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, "--no-color", "student.py"], {
      cwd: dir,
      // Its own bundle cache, so whether a bundle was cached never depends
      // on what ran before.
      env: { ...process.env, PLL_CACHE_DIR: join(dir, ".cache") },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      const steady = (text) =>
        text
          // Package loading is chatter about the cache, not the program.
          .replace(/^Load(ing|ed) .*\n/gm, "")
          // The bundle server's port changes every run.
          .replaceAll(vars.BUNDLE, "{{BUNDLE}}");
      done({ code, stdout: steady(stdout), stderr: steady(stderr) });
    });
    child.stdin.end(c.stdin ?? "");
  });
}

/** Serve the sample Examplar bundle, built by the CLI itself, on localhost. */
async function serveBundle(work) {
  const bundle = join(work, "hw.json");
  await new Promise((done, fail) => {
    const child = spawn(process.execPath, [CLI, "examplar", "build", join(ROOT, "samples", "examplar_bundle"), "-o", bundle]);
    let err = "";
    child.stderr.on("data", (b) => (err += b));
    child.on("close", (code) => (code === 0 ? done() : fail(new Error(`examplar build failed: ${err}`))));
  });
  const body = readFileSync(bundle);
  const server = createServer((req, res) => {
    if (req.url === "/hw.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  // `localhost` both ways, so the server and the CLI resolve it alike.
  await new Promise((done) => server.listen(0, "localhost", done));
  return { server, url: `http://localhost:${server.address().port}/hw.json` };
}

async function main() {
  if (!existsSync(CLI)) {
    console.error(`Missing ${CLI}. Run \`pnpm run build\` first.`);
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const update = args.includes("--update");
  const only = args.filter((a) => !a.startsWith("--"));
  if (update && only.length > 0) {
    console.error("--update records every case; drop the names.");
    process.exit(64);
  }
  const cases = only.length > 0 ? CASES.filter((c) => only.includes(c.name)) : CASES;
  const unknown = only.filter((n) => !CASES.some((c) => c.name === n));
  if (unknown.length > 0) {
    console.error(`no such case: ${unknown.join(", ")}`);
    process.exit(64);
  }

  const work = mkdtempSync(join(ROOT, ".smoke-golden-"));
  const { server, url } = await serveBundle(work);
  const results = new Map();
  try {
    let next = 0;
    await Promise.all(
      Array.from({ length: PARALLEL }, async () => {
        while (next < cases.length) {
          const c = cases[next++];
          results.set(c.name, await runCase(work, c, { BUNDLE: url }));
        }
      }),
    );
  } finally {
    server.close();
    rmSync(work, { recursive: true, force: true });
  }
  const actual = cases.map((c) => render(c.name, results.get(c.name))).join("\n");

  if (update) {
    writeFileSync(EXPECTED, actual + "\n");
    console.log(`smoke-golden: recorded ${cases.length} cases in scripts/golden/expected.txt`);
    return;
  }
  const expected = existsSync(EXPECTED) ? blocks(readFileSync(EXPECTED, "utf8")) : new Map();
  const got = blocks(actual + "\n");
  let differ = 0;
  for (const c of cases) {
    const want = expected.get(c.name);
    const have = got.get(c.name);
    if (want === have) continue;
    differ += 1;
    console.log(`\n--- ${c.name}${want === undefined ? " (no expected output)" : ""}`);
    const old = (want ?? "").split("\n");
    const now = have.split("\n");
    for (const line of old) if (line && !now.includes(line)) console.log(`  - ${line}`);
    for (const line of now) if (line && !old.includes(line)) console.log(`  + ${line}`);
  }
  if (only.length === 0) {
    for (const name of expected.keys()) {
      if (!got.has(name)) {
        differ += 1;
        console.log(`\n--- ${name} (expected, but no such case)`);
      }
    }
  }
  if (differ > 0) {
    console.error(`\nsmoke-golden: FAILED - ${differ} of ${cases.length} cases differ.`);
    console.error("If the change is intended, run with --update and review the diff of expected.txt.");
    process.exit(1);
  }
  console.log(`smoke-golden: ok (${cases.length} cases)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
