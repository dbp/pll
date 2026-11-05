import { loadBundle, validateBundleUrl, type BundleKind, type BundleStore } from "./examplarSource";
import type { PythonRuntime } from "./python";

/**
 * Bundles: modules a course has compiled with `pll bundle build`, which a
 * program names with `#bundle <name> <url>` and then uses by that name,
 * with no import - functions to call whose code the student doesn't see.
 *
 * They are fetched and cached as Examplar bundles are, and trusted the same
 * way: the address must be https (`validateBundleUrl`), and the code runs
 * unchecked.
 */

// A whole line, whose address has a scheme, so a comment that only uses the
// word - `# bundle of joy` - is not one. Python reads the same lines for the
// names they give (`_pll_bundle_lines`, sessions.py).
const DIRECTIVE_RE = /^#\s*bundle\s+(\S+)\s+(\S+:\/\/\S*)\s*$/;

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue",
  "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in",
  "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
]);

export interface BundleDirective {
  name: string;
  url: string;
  /** 1-based. */
  line: number;
}

export interface BundleProblem {
  line: number;
  message: string;
}

/** What `pll bundle build` writes, as against an Examplar bundle or a page that is neither. */
export const MODULE_BUNDLE: BundleKind = {
  noun: "a bundle",
  looksRight(json) {
    try {
      const bundle = JSON.parse(json) as Record<string, unknown> | null;
      return typeof bundle === "object" && bundle !== null && typeof bundle.bundle === "number" && typeof bundle.pyc === "string";
    } catch {
      return false;
    }
  },
};

/** A file's `#bundle` lines: those it can use, and what is wrong with the rest. */
export function parseBundleDirectives(source: string): { bundles: BundleDirective[]; problems: BundleProblem[] } {
  const bundles: BundleDirective[] = [];
  const problems: BundleProblem[] = [];
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = DIRECTIVE_RE.exec(lines[i].trim());
    if (match === null) {
      continue;
    }
    const [, name, url] = match;
    const line = i + 1;
    if (!NAME_RE.test(name) || KEYWORDS.has(name)) {
      problems.push({
        line,
        message:
          `\`${name}\` can't name a bundle: a name is letters, digits and \`_\`, ` +
          `not starting with a digit, and not one of Python's keywords.`,
      });
      continue;
    }
    const earlier = bundles.find((bundle) => bundle.name === name);
    if (earlier !== undefined) {
      problems.push({
        line,
        message: `line ${earlier.line} already names a bundle \`${name}\`. Give each bundle its own name.`,
      });
      continue;
    }
    const problem = validateBundleUrl(url);
    if (problem !== null) {
      problems.push({ line, message: problem });
      continue;
    }
    bundles.push({ name, url, line });
  }
  return { bundles, problems };
}

export interface BundleHost {
  say(text: string, kind: "note" | "problem"): void;
  status(text: string): void;
}

/**
 * Fetch the file's bundles and make them into modules for its program. A
 * bundle that can't be had is said, and gives `"failed"`: the program uses
 * its name, so the run plan does not run it. A Stop, or Python lost, is
 * thrown, for the run plan to say.
 */
export async function runBundleStep(
  runtime: PythonRuntime,
  store: BundleStore,
  host: BundleHost,
  code: string,
  sessionKey: string,
): Promise<"none" | "loaded" | "failed"> {
  const { bundles, problems } = parseBundleDirectives(code);
  if (problems.length > 0) {
    for (const problem of problems) {
      host.say(`Line ${problem.line}: ${problem.message}`, "problem");
    }
    return "failed";
  }
  if (bundles.length === 0) {
    return "none";
  }
  host.status("Loading bundles...");
  const entries: { name: string; json: string }[] = [];
  for (const bundle of bundles) {
    const load = await loadBundle(bundle.url, store, undefined, MODULE_BUNDLE);
    if (load.note) {
      host.say(`The bundle \`${bundle.name}\`: ${load.note}`, "note");
    }
    if (load.json === undefined) {
      host.say(`Line ${bundle.line}: could not load the bundle \`${bundle.name}\`: ${load.error}.`, "problem");
      return "failed";
    }
    entries.push({ name: bundle.name, json: load.json });
  }
  const result = await runtime.bundleLoad(sessionKey, JSON.stringify(entries));
  if (!result.ok) {
    const at = bundles.find((bundle) => bundle.name === result.name);
    host.say(
      `Line ${at?.line ?? "?"}: the bundle \`${result.name ?? "?"}\` could not be loaded: ${result.error ?? "it is broken"}.`,
      "problem",
    );
    return "failed";
  }
  return "loaded";
}
