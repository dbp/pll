/**
 * Which packages a program needs loaded before it runs, read from its text.
 *
 * Shared because the hosts must agree: if one detects an import and another
 * does not, the same file works in the editor and fails at the command line.
 */

/**
 * Whether code imports anything at all. Gates `loadPackagesFromImports`, so
 * a plain expression never pays a worker round-trip.
 */
export const ANY_IMPORT_RE = /(^|\n)[ \t]*(import|from)[ \t]+\S/;

/**
 * `t.to_pandas()` needs pandas loaded, but nothing in the file imports it -
 * the import lives inside the method, where `loadPackagesFromImports` cannot
 * see it. So the *call* is the signal, and a file that never makes it never
 * pays for pandas.
 */
export const PANDAS_METHOD_RE = /\.\s*to_pandas\s*\(/;

/** The calls whose import is hidden inside a library method. */
export const NEEDS_PACKAGES_RE_LIST = [PANDAS_METHOD_RE];

/**
 * Whether anything in the file needs a package loaded before it runs:
 * either an import, or one of those calls.
 */
export function needsPackages(code: string): boolean {
  return ANY_IMPORT_RE.test(code) || NEEDS_PACKAGES_RE_LIST.some((re) => re.test(code));
}

/**
 * Imports whose use implies network access. Pyodide does not wire Python's
 * `urllib` to the host network, so `pd.read_csv(url)` / `requests` / `urllib`
 * fail with "unknown url type: https" until the `pyodide-http` shim is applied.
 * When code imports one of these, PLL loads `pyodide-http` and patches it in
 * (see PYODIDE_HTTP_PATCH_PY). `pandas` is included because its readers take
 * URLs. Programs that import nothing networked never load the shim.
 */
export const NETWORK_IMPORT_RE =
  /(^|\n)[ \t]*(?:import|from)[ \t]+(?:pandas|requests|urllib|urllib3|httpx|aiohttp|http)\b/;

