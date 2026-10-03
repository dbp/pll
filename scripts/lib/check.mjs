/**
 * What every smoke test reports with: `expect` notes a failure and carries
 * on, so one run shows every problem; `passed()` says whether any were noted.
 *
 * A test that checked nothing has not passed. One lost its whole body to an
 * edit once and went on reporting success, so `passed()` also needs at
 * least one check to have run.
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
