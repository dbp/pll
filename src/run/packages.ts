/**
 * Whether a program may need packages loaded before it runs, read from its
 * text and the student's other `.py` files beside it: only a gate, so code
 * that imports nothing never pays a worker round-trip. What to load is
 * Python's to find (`_pll_package_imports` in bootstrap/packages.py). The
 * hosts share it, or the same file would work in the editor and fail at the
 * command line.
 */

/** A `.py` file beside the program, whose imports count too. */
export interface SiblingSource {
  name: string;
  text: string;
}

/** An import, or a table's `to_pandas()`, which needs pandas with none in sight. */
const MAY_NEED_PACKAGES_RE = /\bimport\b|__import__|\.\s*to_pandas\s*\(/;

/** Whether anything in the program could need a package loaded before it runs. */
export function needsPackages(code: string, siblings: SiblingSource[] = []): boolean {
  return [code, ...siblings.map((sibling) => sibling.text)].some((text) => MAY_NEED_PACKAGES_RE.test(text));
}
