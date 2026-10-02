import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DEFAULT_LEVEL, parseLevel } from "../common/level";
import { runFilePlan, type RunHost } from "../common/runPlan";
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
   * running Python, and the next phase clears it as it starts - so without
   * this it was simply lost, and the program ran anyway.
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

  const level = parseLevel(source);
  view.note(`${fileName} [${level}]`);

  const host: RunHost = {
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
  const outcome = await runFilePlan(runtime, host, {
    code: source,
    fileName,
    sessionKey: opts.file,
    level,
    runTests: opts.runTests,
    bundles: createFileStore(),
  });

  if (outcome === "blocked") return EXIT.blocked;
  if (outcome === "stopped" || view.sawError) return EXIT.programError;
  if (view.testFailures > 0) return EXIT.testsFailed;
  return EXIT.ok;
}

export { DEFAULT_LEVEL };
