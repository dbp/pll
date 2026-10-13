/**
 * Whether a program may need packages loaded before it runs, read from its
 * text - the program's file and the student's other `.py` files beside it.
 *
 * Only a gate, so code that cannot import anything never pays a worker
 * round-trip: what to load is found by Python, which reads every import
 * (`_pll_package_imports` in bootstrap/packages.py). Shared because the
 * hosts must agree, or the same file works in the editor and fails at the
 * command line.
 */

/**
 * `t.to_pandas()` needs pandas loaded, but nothing in the file imports it -
 * the import lives inside the method, where an import finder cannot see
 * it. So the *call* is the signal, and a file that never makes it never
 * pays for pandas.
 */
export const PANDAS_METHOD_RE = /\.\s*to_pandas\s*\(/;

/** Anything that could be an import: the word, or `__import__`. */
const MAY_IMPORT_RE = /\bimport\b|__import__/;

/** A `.py` file beside the program, whose imports count too. */
export interface SiblingSource {
  name: string;
  text: string;
}

/** Whether anything in the program could need a package loaded before it runs. */
export function needsPackages(code: string, siblings: SiblingSource[] = []): boolean {
  return [code, ...siblings.map((sibling) => sibling.text)].some(
    (text) => MAY_IMPORT_RE.test(text) || PANDAS_METHOD_RE.test(text),
  );
}
