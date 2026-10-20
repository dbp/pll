/**
 * What every smoke test reports with: `expect` notes a failure and carries
 * on, so one run shows every problem; `passed()` says whether any were noted.
 *
 * A test that checked nothing has not passed: an edit that empties a test's
 * body would otherwise leave it reporting success, so `passed()` also needs
 * at least one check to have run.
 */
let failures = 0;
let checks = 0;

export function expect(cond, msg) {
  checks += 1;
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    failures += 1;
  }
}

/** Note a failure that is not a condition - an exception the test caught. */
export function fail(msg) {
  expect(false, msg);
}

let warned = false;

export function passed() {
  if (checks === 0 && !warned) {
    warned = true;
    console.error("  FAIL: no checks ran");
  }
  return failures === 0 && checks > 0;
}

const ONLY = (process.env.PLL_SMOKE_ONLY ?? "").split(",").filter(Boolean);

/**
 * Whether to run section `id` of a test, saying its title if so: all of
 * them, unless `PLL_SMOKE_ONLY=26,27` names some. `scripts/smoke.mjs` runs
 * each section of a test made of them as a job of its own, so each has to
 * stand on its own, in files of its own.
 */
export function section(id, title) {
  if (ONLY.length > 0 && !ONLY.includes(String(id))) return false;
  console.log(`\n[${id}] ${title}`);
  return true;
}
