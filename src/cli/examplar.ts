import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  ExamplarBundle,
  ExamplarImplResult,
  ExamplarRunResult,
} from "../common/pyodideRunner";
import type { PythonRuntime } from "../common/types";
import { EXIT } from "./run";
import type { CliView } from "./view";

export const EXAMPLAR_USAGE = `pll examplar - author Examplar bundles

  pll examplar build <dir> [-o bundle.json] [--verify tests.py]

<dir> holds the implementations, one file each:

  <dir>/wheats/reference.py       known-good; every test must pass on these
  <dir>/wheats/alternative.py     more than one stops tests over-fitting
  <dir>/chaffs/initials/1.py      known-bad; each must be caught by some test
  <dir>/chaffs/longest/1.py

A chaff goes in a directory named after the function it breaks, because a
student's report is per function. Its id is its filename, and that id is the
only thing a student sees about a chaff they missed - so number them rather
than naming them after the bug. Every function needs at least one.

Only bytecode is written to the bundle, so the sources stay in your
repository.

The bytecode is compiled by the Pyodide this package pins, so it always
matches the interpreter that will run it - which is the reason to build
bundles with this tool rather than a local python.

  -o FILE           write here instead of stdout
  --verify TESTS    check the bundle with your own suite: it must pass on
                    every wheat and fail on every chaff. A chaff no test can
                    catch is a broken chaff, and better found now. Chaffs are
                    only checked once the wheats pass, since a suite that is
                    wrong fails on everything.
`;

interface BuildArgs {
  dir?: string;
  out?: string;
  verify?: string;
  help: boolean;
  error?: string;
}

export function parseExamplarArgs(argv: string[]): BuildArgs {
  const args: BuildArgs = { help: false };
  if (argv[0] !== "build") {
    args.error =
      argv.length === 0
        ? "examplar needs a subcommand"
        : `unknown examplar subcommand ${argv[0]}`;
    if (argv[0] === "-h" || argv[0] === "--help") {
      args.error = undefined;
      args.help = true;
    }
    return args;
  }
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") args.help = true;
    else if (arg === "-o") {
      args.out = argv[++i];
      if (args.out === undefined) {
        args.error = "-o needs a file";
        return args;
      }
    } else if (arg === "--verify") {
      args.verify = argv[++i];
      if (args.verify === undefined) {
        args.error = "--verify needs a test file";
        return args;
      }
    } else if (arg.startsWith("-")) {
      args.error = `unknown option ${arg}`;
      return args;
    } else if (args.dir === undefined) {
      args.dir = arg;
    } else {
      args.error = `unexpected extra argument ${arg}`;
      return args;
    }
  }
  if (!args.help && args.dir === undefined) {
    args.error = "no directory given";
  }
  return args;
}

async function readDir(folder: string) {
  try {
    return await fs.readdir(folder, { withFileTypes: true });
  } catch {
    throw new Error(`${folder} does not exist. See \`pll examplar --help\`.`);
  }
}

/** Read `<dir>/wheats/*.py` as `{ id: source }`. */
async function readWheats(dir: string): Promise<Record<string, string>> {
  const folder = path.join(dir, "wheats");
  const out: Record<string, string> = {};
  for (const entry of await readDir(folder)) {
    if (!entry.isFile() || !entry.name.endsWith(".py")) continue;
    out[entry.name.slice(0, -3)] = await fs.readFile(path.join(folder, entry.name), "utf8");
  }
  if (Object.keys(out).length === 0) {
    throw new Error(`${folder} has no .py files in it.`);
  }
  return out;
}

/**
 * Read `<dir>/chaffs/<function>/*.py` as `{ function: { id: source } }`.
 *
 * The directory *is* the statement of which function a chaff breaks, and a
 * student's report is per function, so a loose `.py` directly under
 * `chaffs/` has nowhere to go. That was the layout before, so say what
 * changed rather than just that the folder is empty.
 */
async function readChaffs(dir: string): Promise<Record<string, Record<string, string>>> {
  const folder = path.join(dir, "chaffs");
  const out: Record<string, Record<string, string>> = {};
  const loose: string[] = [];
  for (const entry of await readDir(folder)) {
    if (entry.isFile() && entry.name.endsWith(".py")) {
      loose.push(entry.name);
      continue;
    }
    if (!entry.isDirectory()) continue;
    const inner = path.join(folder, entry.name);
    const group: Record<string, string> = {};
    for (const file of await fs.readdir(inner, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".py")) continue;
      group[file.name.slice(0, -3)] = await fs.readFile(path.join(inner, file.name), "utf8");
    }
    if (Object.keys(group).length > 0) {
      out[entry.name] = group;
    }
  }
  if (loose.length > 0) {
    throw new Error(
      `${path.join(folder, loose[0])} is not inside a function's directory. ` +
        `Chaffs go in \`chaffs/<function>/\`, named after the function they ` +
        `break - move it to \`chaffs/<function>/${loose[0]}\`.`,
    );
  }
  if (Object.keys(out).length === 0) {
    throw new Error(`${folder} has no \`<function>/*.py\` in it.`);
  }
  return out;
}

export async function runExamplar(
  runtime: PythonRuntime,
  view: CliView,
  argv: string[],
): Promise<number> {
  const args = parseExamplarArgs(argv);
  if (args.help) {
    process.stdout.write(EXAMPLAR_USAGE);
    return EXIT.ok;
  }
  if (args.error !== undefined) {
    process.stderr.write(`pll: ${args.error}\n\n${EXAMPLAR_USAGE}`);
    return EXIT.usage;
  }

  const dir = path.resolve(args.dir as string);
  let sources: {
    wheats: Record<string, string>;
    chaffs: Record<string, Record<string, string>>;
  };
  try {
    sources = { wheats: await readWheats(dir), chaffs: await readChaffs(dir) };
  } catch (err) {
    view.problem(`pll: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.usage;
  }

  const built = await runtime.examplarBuild(JSON.stringify(sources));
  if (!built.ok || !built.bundle) {
    view.problem(`pll: ${built.error ?? "could not build the bundle"}`);
    return EXIT.usage;
  }
  const bundle = built.bundle;
  view.note(
    `built for Python ${bundle.built.python}: ` +
      `${bundle.wheats.length} wheat(s), ${bundle.chaffs.length} chaff(s), ` +
      `providing ${bundle.provides.join(", ")}`,
  );

  if (args.verify !== undefined) {
    const code = await verify(runtime, view, bundle, args.verify);
    if (code !== EXIT.ok) {
      return code;
    }
  }

  const json = JSON.stringify(bundle);
  if (args.out === undefined) {
    process.stdout.write(json + "\n");
  } else {
    await fs.writeFile(path.resolve(args.out), json + "\n", "utf8");
    view.note(`wrote ${args.out} (${json.length} bytes)`);
  }
  return EXIT.ok;
}

/** True if any test failed or errored against this implementation. */
function caught(impl: ExamplarImplResult): boolean {
  return !impl.loaded || Object.values(impl.tests).some((t) => t.outcome !== "pass");
}

/**
 * Check a bundle against the author's own suite.
 *
 * This is the property the bundle has to have, and nothing else can check
 * it: the suite passes on every wheat, and *each* chaff is caught by at
 * least one test. A chaff nothing catches would silently never contribute
 * to a student's score.
 */
async function verify(
  runtime: PythonRuntime,
  view: CliView,
  bundle: ExamplarBundle,
  testsPath: string,
): Promise<number> {
  let testSource: string;
  try {
    testSource = await fs.readFile(path.resolve(testsPath), "utf8");
  } catch (err) {
    view.problem(`pll: cannot read ${testsPath}: ${err instanceof Error ? err.message : err}`);
    return EXIT.usage;
  }
  // Load pytest so a failure shows `assert 'HI' == 'HI!'` rather than
  // "assertion failed" - the same reason the editor does.
  try {
    await runtime.ensurePytest();
  } catch {
    view.note("could not load pytest; assertion messages will be terse.");
  }

  const result: ExamplarRunResult = await runtime.examplarRun(
    testSource,
    JSON.stringify(bundle),
  );
  if (!result.ok) {
    view.problem(`pll: ${result.error ?? "the bundle could not be run"}`);
    return EXIT.usage;
  }

  let bad = 0;
  view.problem(`verifying with ${path.basename(testsPath)}:`);
  for (const wheat of result.wheats ?? []) {
    const failures = Object.entries(wheat.tests).filter(([, t]) => t.outcome !== "pass");
    if (wheat.loaded && failures.length === 0) {
      view.note(`  ok    wheat ${wheat.id}: all ${Object.keys(wheat.tests).length} pass`);
      continue;
    }
    bad += 1;
    view.problem(`  BAD   wheat ${wheat.id}: your own tests do not all pass on it`);
    if (!wheat.loaded) {
      view.problem(`          ${wheat.error_type}: ${wheat.error_message}`);
    }
    for (const [name, t] of failures) {
      view.problem(`          ${name}: ${(t.message ?? t.outcome).split("\n")[0]}`);
    }
  }
  // Phase two is gated the same way it is for students, and per function:
  // chaffs are not run for a function whose tests did not all pass. Say so,
  // or the silence about them reads as approval.
  for (const chaff of result.chaffs ?? []) {
    const where = `chaff ${chaff.targets}/${chaff.id}`;
    if (caught(chaff)) {
      const by = Object.entries(chaff.tests)
        .filter(([, t]) => t.outcome !== "pass")
        .map(([name]) => name);
      view.note(`  ok    ${where}: caught by ${by.join(", ")}`);
      continue;
    }
    bad += 1;
    view.problem(`  BAD   ${where}: no test catches it - it would never count`);
  }
  const attributed = Object.values(result.attribution ?? {});
  for (const name of result.chaffs_skipped ?? []) {
    if (attributed.some((names) => names.includes(name))) {
      // Already counted as the wheat failure that caused it; this line only
      // explains why its chaffs went unmentioned.
      view.problem(`  ---   ${name} chaffs not checked: its tests have to pass first`);
      continue;
    }
    // Not a note. `--verify` exists to prove every chaff is catchable, and
    // a function your suite never touches leaves its chaffs unproven - the
    // exact hazard of a chaff that would silently never count.
    bad += 1;
    view.problem(
      `  BAD   your own suite has no tests for ${name}, so its chaffs are unproven`,
    );
  }
  if (bad > 0) {
    view.problem(`pll: ${bad} problem(s) with this bundle; not written.`);
    return EXIT.testsFailed;
  }
  view.problem("verified.");
  return EXIT.ok;
}
