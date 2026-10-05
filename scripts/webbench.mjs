/**
 * Shared helpers for the tests that drive a real vscode-test-web workbench.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Open a file from the explorer, scrolling to it first.
 *
 * The explorer list is **virtualised**: only the rows in view exist in the
 * DOM at all, so a file below the fold has no row to find, and a locator
 * for it times out with nothing to say it is a layout problem rather than a
 * broken feature. Scrolling until the row appears makes these tests
 * independent of how many samples there happen to be.
 */
export async function openFile(page, name, { timeout = 30_000 } = {}) {
  const row = page.locator(".monaco-list-row", { hasText: name }).first();
  await page.locator(".monaco-list-row").first().waitFor({ state: "visible", timeout });
  for (let i = 0; i < 30 && (await row.count()) === 0; i++) {
    await page.locator(".monaco-list-row").first().hover();
    await page.mouse.wheel(0, 240);
    await sleep(120);
  }
  if ((await row.count()) === 0) {
    const seen = await page.locator(".monaco-list-row").allInnerTexts();
    throw new Error(
      `${name} never appeared in the explorer after scrolling. Rendered rows: ` +
        JSON.stringify(seen.map((t) => t.trim().split("\n")[0])),
    );
  }
  await row.waitFor({ state: "visible", timeout });
  await row.dblclick();
  await sleep(1200);
}
