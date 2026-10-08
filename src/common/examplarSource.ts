import { errorText } from "./errorText";

/**
 * Finding and fetching an Examplar bundle.
 *
 * The directive is scanned line by line anywhere in the file, rather than
 * from a header block, so that adding it cannot perturb how `#level` is
 * read - `parseLevel` has deliberately strict semantics and stays untouched.
 */

/** Largest bundle we will accept. A wheat plus a dozen chaffs is ~10 KB. */
export const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;

const DIRECTIVE_RE = /^#\s*examplar\s+(\S+)\s*$/;

export type ExamplarDirective =
  | { kind: "none" }
  | { kind: "found"; url: string; line: number }
  | { kind: "error"; message: string; line: number };

/**
 * The `#examplar <url>` line, if there is exactly one.
 *
 * Only a whole line counts, so a URL mentioned in prose or trailing another
 * statement is not a directive. Two directives are an error rather than
 * "first wins": silently ignoring the second would be a confusing way to
 * find out you had edited the wrong line.
 */
export function parseExamplarDirective(source: string): ExamplarDirective {
  const hits: { url: string; line: number }[] = [];
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = DIRECTIVE_RE.exec(lines[i].trim());
    if (match) {
      hits.push({ url: match[1], line: i + 1 });
    }
  }
  if (hits.length === 0) {
    return { kind: "none" };
  }
  if (hits.length > 1) {
    return {
      kind: "error",
      line: hits[1].line,
      message:
        `there is more than one \`#examplar\` line (lines ` +
        `${hits.map((h) => h.line).join(" and ")}). Keep the one you want.`,
    };
  }
  const { url, line } = hits[0];
  const problem = validateBundleUrl(url);
  return problem ? { kind: "error", message: problem, line } : { kind: "found", url, line };
}

/**
 * Bundles are code that will run in the student's interpreter, so the
 * address has to be one they can trust. Plain http is allowed only for
 * localhost, which is what a course would use while writing an assignment.
 */
export function validateBundleUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `\`${url}\` is not a URL.`;
  }
  if (parsed.protocol === "https:") {
    return null;
  }
  if (parsed.protocol === "http:") {
    const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    return local
      ? null
      : `\`${url}\` must use https (plain http is only allowed for localhost).`;
  }
  return `\`${url}\` must be an https address.`;
}

export interface CachedBundle {
  json: string;
  /** The server's ETag, so the next fetch can be conditional. */
  etag?: string;
}

/** Somewhere to keep fetched bundles between runs. */
export interface BundleStore {
  read(url: string): Promise<CachedBundle | undefined>;
  write(url: string, entry: CachedBundle): Promise<void>;
}

export interface BundleLoad {
  json?: string;
  /** True when the bytes came from the store rather than the network. */
  fromCache: boolean;
  /** Something worth telling the student, but not a failure. */
  note?: string;
  /** Set when there is no bundle to use at all. */
  error?: string;
}

type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/**
 * Fetch a bundle, preferring a conditional request and falling back to the
 * cache.
 *
 * Offline with a cached copy is a *note*, not an error: a student on a train
 * should still get their feedback. Offline with nothing cached is an error,
 * but the caller is expected to carry on running the file regardless - the
 * same fail-open stance as every other optional layer here.
 */
export async function loadBundle(
  url: string,
  store: BundleStore,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<BundleLoad> {
  const cached = await store.read(url).catch(() => undefined);
  let response;
  try {
    response = await fetchImpl(url, {
      headers: cached?.etag ? { "If-None-Match": cached.etag } : {},
    });
  } catch (err) {
    const why = errorText(err);
    return cached
      ? { json: cached.json, fromCache: true, note: `could not reach ${url} (${why}); using the cached copy` }
      : { fromCache: false, error: `could not reach ${url} (${why}), and nothing is cached` };
  }

  if (response.status === 304 && cached) {
    return { json: cached.json, fromCache: true };
  }
  if (!response.ok) {
    return cached
      ? {
          json: cached.json,
          fromCache: true,
          note: `${url} returned ${response.status}; using the cached copy`,
        }
      : { fromCache: false, error: `${url} returned ${response.status}` };
  }

  const json = await response.text();
  if (json.length > MAX_BUNDLE_BYTES) {
    return cached
      ? { json: cached.json, fromCache: true, note: `${url} is unexpectedly large; using the cached copy` }
      : {
          fromCache: false,
          error: `${url} is ${json.length} bytes, past the ${MAX_BUNDLE_BYTES}-byte limit`,
        };
  }
  // A page that is not a bundle - a login page, a 404 served as 200 - is
  // never cached: it would replace the good copy a student offline needs.
  if (!looksLikeBundle(json)) {
    return cached
      ? { json: cached.json, fromCache: true, note: `${url} did not return a bundle; using the cached copy` }
      : { fromCache: false, error: `${url} did not return an Examplar bundle` };
  }
  const etag = response.headers.get("etag") ?? undefined;
  try {
    await store.write(url, { json, etag });
  } catch (err) {
    return { json, fromCache: false, note: `could not keep a copy for offline use (${errorText(err)})` };
  }
  return { json, fromCache: false };
}

/** Whether `json` is shaped like what `pll examplar build` writes. */
function looksLikeBundle(json: string): boolean {
  try {
    const bundle = JSON.parse(json) as Record<string, unknown> | null;
    return (
      typeof bundle === "object" &&
      bundle !== null &&
      "examplar" in bundle &&
      Array.isArray(bundle.wheats) &&
      Array.isArray(bundle.chaffs)
    );
  } catch {
    return false;
  }
}
