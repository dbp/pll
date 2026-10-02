import * as fs from "node:fs/promises";
import * as path from "node:path";
import { levelHeaderFinding } from "../common/analyzers/levelHeaderFinding";
import { enrichStaticFindings } from "../common/analyzers/static/registry";
import { findingForErrorEvent } from "../common/analyzers/runtimeFinding";
import {
  DEFAULT_LEVEL,
  levelHasStaticChecks,
  parseLevel,
  type Level,
} from "../common/level";
import { needsPackages } from "../common/pyodideRunner";
import type { ExecutionEvent, PythonRuntime } from "../common/types";
import { collectSiblingFiles, writeBackSiblingFiles } from "./files";
import type { CliView } from "./view";

/**
 * Exit codes. Distinct on purpose: an autograder wants to tell "the level
 * rejected this file" from "the tests failed" from "it crashed".
 */
export const EXIT = {
  ok: 0,
  /** The program raised, or Ctrl+C stopped the run. */
  programError: 1,
  /** Level checks found problems, so the file was not run. */
  blocked: 2,
  /** The program ran, but its in-file tests did not all pass. */
  testsFailed: 3,
  /** Bad usage, or PLL itself could not run. */
  usage: 64,
} as const;

export interface RunOptions {
  /** Path to the .py file. */
  file: string;
  /** Run in-file `test_*` functions before the file, as the editor does. */
  runTests: boolean;
  /**
   * Whether Ctrl+C has been pressed. Checked before each phase: a Stop
   * pressed while one phase is starting up, or between two, reaches no
   * running Python, and the next phase clears it as it starts - so without
   * this it was simply lost, and the program ran anyway.
   */
  stopRequested?: () => boolean;
}

/** Said when Ctrl+C comes before any of the student's code has run. */
const STOPPED_BEFORE_START = "Stopped before the program started. Nothing was run.";

/**
 * Run one file, in the same order the editor does: level checks, then
 * packages, then sibling files, then tests, then the file, then write back
 * whatever it changed.
 *
 * The *sequence* is repeated from `ReplSession.executeFile` rather than
 * shared, because everything underneath it already is: the policy, the
 * analyzers, the wording, the protocol. What is left here is the shape of a
 * one-shot command, which has no sessions, no exec chain and no view to
 * keep in sync.
 */
export async function runFile(
  runtime: PythonRuntime,
  view: CliView,
  opts: RunOptions,
): Promise<number> {
  const fileName = path.basename(opts.file);
  let source: string;
  try {
    source = await fs.readFile(opts.file, "utf8");
  } catch (err) {
    view.problem(`Cannot read ${opts.file}: ${errText(err)}`);
    return EXIT.usage;
  }

  const level = parseLevel(source);
  view.note(`${fileName} [${level}]`);

  // Checked at every level: a broken `#level` line means the file asked for
  // checks and got none, and the fallback level is the symptom rather than
  // the thing to consult.
  const header = levelHeaderFinding(source, fileName, level);
  if (header !== null) {
    view.findings([header]);
    return EXIT.blocked;
  }

  const stopRequested = opts.stopRequested ?? (() => false);
  if (levelHasStaticChecks(level)) {
    const blocked = await staticChecks(runtime, view, source, fileName, level, stopRequested);
    if (blocked) {
      return EXIT.blocked;
    }
  }
  if (stopRequested()) {
    view.problem(STOPPED_BEFORE_START);
    return EXIT.programError;
  }

  await ensurePackages(runtime, view, source, stopRequested);

  // Always mount, even with nothing to mount, so the work directory is
  // cleared - the editor does the same.
  try {
    await runtime.mountWorkspaceFiles(await collectSiblingFiles(opts.file));
  } catch (err) {
    view.note(`Could not load files next to this script (${errText(err)}).`);
  }

  const onEvent = (event: ExecutionEvent) => {
    if (event.kind === "error") {
      const finding = findingForErrorEvent(event, source, fileName, level);
      if (finding) {
        view.runtimeFinding(finding);
        return;
      }
    }
    view.handle(event);
  };

  if (stopRequested()) {
    view.problem(STOPPED_BEFORE_START);
    return EXIT.programError;
  }

  // Ctrl+C during the tests ends the run there. Carrying on into the
  // program meant a test that looped was followed by the program - and a
  // second Ctrl+C, which gives up and kills pll rather than stopping it.
  const stopped = opts.runTests
    ? await maybeRunTests(runtime, view, source, fileName, level, onEvent, stopRequested)
    : null;
  if (stopped !== null || stopRequested()) {
    // Otherwise pressed while the file was checked for tests, and there
    // were none to run.
    view.problem(stopped ?? "Stopped before the program started.");
    await writeBack(runtime, view, opts.file);
    return EXIT.programError;
  }

  await runtime.runFile({ code: source, fileName, sessionKey: opts.file, level }, onEvent);
  await writeBack(runtime, view, opts.file);

  if (view.sawError) return EXIT.programError;
  if (view.testFailures > 0) return EXIT.testsFailed;
  return EXIT.ok;
}

/** True when findings stopped the run. */
async function staticChecks(
  runtime: PythonRuntime,
  view: CliView,
  source: string,
  fileName: string,
  level: Level,
  stopRequested: () => boolean,
): Promise<boolean> {
  let raw;
  try {
    raw = await runtime.staticAnalyze({ code: source, fileName, level });
  } catch (err) {
    // A broken analyzer must not stop the program from running. One that
    // Ctrl+C interrupted is not broken, and the caller says it stopped.
    if (!stopRequested()) {
      view.note(`Static analysis failed (${errText(err)}); running anyway.`);
    }
    return false;
  }
  const findings = enrichStaticFindings(raw, level, fileName);
  if (findings.length === 0) {
    return false;
  }
  view.findings(findings);
  // A warning is about code that still works - a method named but not
  // called, a test nothing runs - so it is shown and the file goes ahead.
  const errors = findings.filter((finding) => finding.severity === "error");
  if (errors.length === 0) {
    return false;
  }
  view.problem(`Static analysis found ${errors.length} problem(s). File not run.`);
  return true;
}

async function ensurePackages(
  runtime: PythonRuntime,
  view: CliView,
  source: string,
  stopRequested: () => boolean,
): Promise<void> {
  if (!needsPackages(source)) {
    return;
  }
  try {
    await runtime.ensurePackages(source);
  } catch (err) {
    const message = errText(err);
    // A SyntaxError here just means the file does not parse; the run itself
    // reports that properly. Nor is a load that Ctrl+C interrupted a failure.
    if (!/syntaxerror|invalid syntax/i.test(message) && !stopRequested()) {
      view.note(`Could not load libraries (${message}). Continuing.`);
    }
  }
}

/**
 * Run the file's tests, if it has any. Returns what to say if Ctrl+C
 * stopped the run during this phase, and null to go on to the program.
 */
async function maybeRunTests(
  runtime: PythonRuntime,
  view: CliView,
  source: string,
  fileName: string,
  level: Level,
  onEvent: (event: ExecutionEvent) => void,
  stopRequested: () => boolean,
): Promise<string | null> {
  try {
    if (!(await runtime.hasTests(source))) {
      return null;
    }
    await runtime.ensurePytest();
  } catch (err) {
    if (!stopRequested()) {
      view.note(`Could not check for tests (${errText(err)}); skipping them.`);
    }
    return null;
  }
  // Pressed while pytest loaded: nothing of the student's has run yet.
  if (stopRequested()) {
    return "Stopped before the tests started. The tests and the program were not run.";
  }
  // An error at the top level stops the test phase *while it loads the file
  // to find the `test_` functions*, and then stops the run as well - so it
  // was reported twice. The run is the one that matters: it is the
  // student's program, not PLL looking for tests. A pytest that would not
  // load is already handled above, so the only `error` reachable here is
  // the file failing, and the run is about to report it properly.
  await runtime.runTests(
    { code: source, fileName, sessionKey: fileName, level },
    (event) => {
      if (event.kind !== "error") {
        onEvent(event);
      }
    },
  );
  if (view.testsStopped) {
    return "Stopped during the tests. The rest of the tests and the program were not run.";
  }
  // Pressed as the last test finished, so it arrived after them all.
  if (stopRequested()) {
    return "Stopped after the tests. The program was not run.";
  }
  return null;
}

async function writeBack(
  runtime: PythonRuntime,
  view: CliView,
  file: string,
): Promise<void> {
  try {
    const changed = await runtime.collectWorkspaceFiles();
    if (changed.length === 0) {
      return;
    }
    const written = await writeBackSiblingFiles(file, changed);
    if (written.length > 0) {
      view.note(`Saved ${written.join(", ")} next to ${path.basename(file)}.`);
    }
  } catch (err) {
    view.note(`Could not save files next to this script (${errText(err)}).`);
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export { DEFAULT_LEVEL };
