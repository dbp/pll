import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runFilePlan, type RunHost, type RunSummary } from "../common/runPlan";
import type { PythonRuntime } from "../common/types";
import { createFileStore } from "./bundleStore";
import { collectSiblingFiles, writeBackSiblingFiles } from "./files";
import type { CliView } from "./view";
import { errorText } from "../common/errorText";

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
   * running Python, and the next phase clears it as it starts, so this is
   * the only place it is seen.
   */
  stopRequested?: () => boolean;
}

/**
 * Run one file, the way the editor does: `runFilePlan` holds the steps, and
 * this says how a terminal shows them. The program's own output is the only
 * thing on stdout; everything PLL says about the run goes to stderr.
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
    view.problem(`Cannot read ${opts.file}: ${errorText(err)}`);
    return EXIT.usage;
  }

  const host: RunHost = {
    level: (level) => view.note(`${fileName} [${level}]`),
    staticFindings: (findings) => view.findings(findings),
    runtimeFinding: (finding) => view.runtimeFinding(finding),
    event: (event) => view.handle(event),
    say: (text, kind) => (kind === "problem" ? view.problem(text) : view.note(text)),
    status: () => undefined,
    stopRequested: opts.stopRequested ?? (() => false),
    siblingFiles: () => collectSiblingFiles(opts.file),
    writeBack: (files) => writeBackSiblingFiles(opts.file, files),
    examplarCard: (card) => view.examplarCard(card),
  };
  const summary = await runFilePlan(runtime, host, {
    code: source,
    fileName,
    sessionKey: opts.file,
    runTests: opts.runTests,
    bundles: createFileStore(),
  });
  return exitCodeOf(summary);
}

/**
 * The exit code for how a run went. The program's own status is passed on
 * as `python` would exit with it; one other than 0 outranks a failed test,
 * which the report has already listed.
 */
export function exitCodeOf(summary: RunSummary): number {
  if (summary.outcome === "blocked") return EXIT.blocked;
  if (summary.outcome === "stopped" || summary.raised) return EXIT.programError;
  if (summary.exitCode !== null && processStatus(summary.exitCode) !== 0) {
    return processStatus(summary.exitCode);
  }
  if (summary.testFailures > 0) return EXIT.testsFailed;
  return EXIT.ok;
}

/**
 * A status as the shell sees it: the low byte, which is what an exit status
 * is on POSIX. `sys.exit(256)` exits 0 under CPython too; one too large to
 * be a status at all is a failure.
 */
function processStatus(code: number): number {
  if (!Number.isSafeInteger(code)) return EXIT.programError;
  return ((code % 256) + 256) % 256;
}
