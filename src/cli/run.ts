import * as fs from "node:fs/promises";
import * as path from "node:path";
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
  /** The program raised. */
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
}

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

  if (levelHasStaticChecks(level)) {
    const blocked = await staticChecks(runtime, view, source, fileName, level);
    if (blocked) {
      return EXIT.blocked;
    }
  }

  await ensurePackages(runtime, view, source);

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

  if (opts.runTests) {
    await maybeRunTests(runtime, view, source, fileName, level, onEvent);
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
): Promise<boolean> {
  let raw;
  try {
    raw = await runtime.staticAnalyze({ code: source, fileName, level });
  } catch (err) {
    // A broken analyzer must not stop the program from running.
    view.note(`Static analysis failed (${errText(err)}); running anyway.`);
    return false;
  }
  const findings = enrichStaticFindings(raw, level, fileName);
  if (findings.length === 0) {
    return false;
  }
  view.findings(findings);
  view.problem(`Static analysis found ${findings.length} problem(s). File not run.`);
  return true;
}

async function ensurePackages(
  runtime: PythonRuntime,
  view: CliView,
  source: string,
): Promise<void> {
  if (!needsPackages(source)) {
    return;
  }
  try {
    await runtime.ensurePackages(source);
  } catch (err) {
    const message = errText(err);
    // A SyntaxError here just means the file does not parse; the run itself
    // reports that properly.
    if (!/syntaxerror|invalid syntax/i.test(message)) {
      view.note(`Could not load libraries (${message}). Continuing.`);
    }
  }
}

async function maybeRunTests(
  runtime: PythonRuntime,
  view: CliView,
  source: string,
  fileName: string,
  level: Level,
  onEvent: (event: ExecutionEvent) => void,
): Promise<void> {
  try {
    if (!(await runtime.hasTests(source))) {
      return;
    }
    await runtime.ensurePytest();
  } catch (err) {
    view.note(`Could not check for tests (${errText(err)}); skipping them.`);
    return;
  }
  await runtime.runTests({ code: source, fileName, sessionKey: fileName, level }, onEvent);
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
