import { levelHeaderFinding } from "./analyzers/levelHeaderFinding";
import { explainTestReport, findingForErrorEvent } from "./analyzers/runtimeFinding";
import { enrichStaticFindings } from "./analyzers/static/registry";
import type { AnalysisFinding } from "./analyzers/types";
import { runExamplarStep, type ExamplarEntry } from "./examplarPhase";
import type { BundleStore } from "./examplarSource";
import { levelHasStaticChecks, type Level } from "./level";
import { needsPackages } from "./packages";
import type { ExecutionEvent, PythonRuntime } from "./types";
import type { WorkspaceFile } from "./workspaceFilePolicy";
import { errorText } from "./errorText";

/**
 * The steps of a run, written once for every host.
 *
 * A file run is: the `#level` line, the level's static checks, libraries,
 * the files next to the program, the Examplar check, the file's own tests,
 * the program, and writing back the files it changed. The editor and the
 * command line used to each write this out, and every change had to be made
 * twice - which is how they came to word the same failure differently, and
 * to disagree about whether a top-level error in a file with tests was
 * reported once or twice. A host now says only how to show things.
 *
 * Stop (Ctrl+C) is checked between the steps. A Stop lands in whichever
 * step is running, but what was asked for is that nothing more runs; and one
 * pressed while something loads reaches no running Python at all, so the
 * next check is the only thing that will notice it.
 */
export interface RunHost {
  /** Findings from the `#level` line or the static checks; replaces any shown before. */
  staticFindings(findings: AnalysisFinding[]): void;
  /** A runtime error, already explained. */
  runtimeFinding(finding: AnalysisFinding): void;
  /** Every other event: output, images, tables, reactors, and test reports (explained). */
  event(event: ExecutionEvent): void;
  /**
   * Something PLL says about the run itself. A `problem` is about the run
   * not doing what was asked (stopped, not run); a `note` is a side remark.
   */
  say(text: string, kind: "note" | "problem"): void;
  /** What the run is doing now, for a host that shows it. */
  status(text: string): void;
  /** Whether Stop was pressed during this run. */
  stopRequested(): boolean;
  /** The files next to the program, to mount where it can open them. */
  siblingFiles(): Promise<WorkspaceFile[]>;
  /** Write back the files the program changed; returns the names written. */
  writeBack(files: WorkspaceFile[]): Promise<string[]>;
  /** One card of the Examplar check's verdict. */
  examplarCard(entry: ExamplarEntry): void;
  /** Wraps running the program itself (the editor connects `input()` here). */
  aroundProgram?(run: () => Promise<void>): Promise<void>;
}

export interface FilePlan {
  code: string;
  fileName: string;
  sessionKey: string;
  level: Level;
  /** Run the file's `test_*` functions before it. */
  runTests: boolean;
  /** Where fetched Examplar bundles are cached, for a file with `#examplar`. */
  bundles: BundleStore;
}

export interface InputPlan {
  code: string;
  sessionKey: string;
  level: Level;
}

/** How a run ended: checks refused it, Stop ended it, or it ran. */
export type RunOutcome = "blocked" | "stopped" | "ran";

const STOPPED_BEFORE_START = "Stopped before the program started. Nothing was run.";
const STOPPED_BEFORE_INPUT = "Stopped. Your input was not run.";
const STOPPED_BEFORE_TESTS = "Stopped before the tests started. The tests and the program were not run.";
const STOPPED_DURING_TESTS = "Stopped during the tests. The rest of the tests and the program were not run.";
const STOPPED_AFTER_TESTS = "Stopped after the tests. The program was not run.";
const STOPPED_BEFORE_PROGRAM = "Stopped before the program started.";
const STOPPED_CHECKING_TESTS =
  "Stopped while checking your tests. Your own tests and the program were not run.";

/** Run a whole file. */
export async function runFilePlan(
  runtime: PythonRuntime,
  host: RunHost,
  plan: FilePlan,
): Promise<RunOutcome> {
  const { code, fileName, sessionKey, level } = plan;
  // Checked at every level: a broken `#level` line means the file asked
  // for checks and got none, so the level it fell back to is the symptom.
  const header = levelHeaderFinding(code, fileName, level);
  if (header !== null) {
    host.staticFindings([header]);
    return "blocked";
  }
  const checked = await staticChecks(runtime, host, code, fileName, level, null);
  if (checked !== "ran") {
    return checked;
  }
  return withFiles(runtime, host, code, fileName, STOPPED_BEFORE_START, async () => {
    const onEvent = programEvents(host, code, fileName, level);
    let ownCodeIsComplete = true;
    const complete = await runExamplarStep(runtime, plan.bundles, host, code);
    if (complete !== null) {
      ownCodeIsComplete = complete;
      // The check ran with the files unmounted; put them back before
      // anything of the student's runs.
      await mount(runtime, host);
      if (stopped(host, STOPPED_CHECKING_TESTS)) {
        return "stopped";
      }
    }
    if (plan.runTests && ownCodeIsComplete && (await hasTestsToRun(runtime, host, code))) {
      if (stopped(host, STOPPED_BEFORE_TESTS)) {
        return "stopped";
      }
      host.status("Running tests...");
      let testsStopped = false;
      await runtime.runTests({ code, fileName, sessionKey, level }, (event) => {
        // An error here is the file failing to load while the tests were
        // looked for. The program is about to raise it again, and that is
        // the report that matters: it is the student's program, not PLL
        // looking for tests.
        if (event.kind === "error") return;
        if (event.kind === "testReport" && event.stopped) testsStopped = true;
        onEvent(event);
      });
      // A Stop pressed as the last test finished arrives after them all.
      if (stopped(host, testsStopped ? STOPPED_DURING_TESTS : STOPPED_AFTER_TESTS)) {
        return "stopped";
      }
    }
    // Pressed while the file was checked for tests, and there were none.
    if (stopped(host, STOPPED_BEFORE_PROGRAM)) {
      return "stopped";
    }
    host.status("Running...");
    const program = () => runtime.runFile({ code, fileName, sessionKey, level }, onEvent);
    await (host.aroundProgram ? host.aroundProgram(program) : program());
    return "ran";
  });
}

/** Run what was typed at the prompt. */
export async function runInputPlan(
  runtime: PythonRuntime,
  host: RunHost,
  plan: InputPlan,
): Promise<RunOutcome> {
  const { code, sessionKey, level } = plan;
  const fileName = "<repl>";
  const checked = await staticChecks(runtime, host, code, fileName, level, sessionKey);
  if (checked !== "ran") {
    return checked;
  }
  return withFiles(runtime, host, code, fileName, STOPPED_BEFORE_INPUT, async () => {
    await runtime.replEval({ code, sessionKey, level }, programEvents(host, code, fileName, level));
    return "ran";
  });
}

/**
 * The level's static checks. Warnings are shown and the run goes on; an
 * error stops it. A checker that fails does not - unless it failed because
 * Stop interrupted it, which is the Stop, not a broken checker.
 *
 * `sessionKey` is for prompt input, which is checked against the names the
 * session already has; a file is checked on its own.
 */
async function staticChecks(
  runtime: PythonRuntime,
  host: RunHost,
  code: string,
  fileName: string,
  level: Level,
  sessionKey: string | null,
): Promise<RunOutcome> {
  if (!levelHasStaticChecks(level)) {
    return "ran";
  }
  const input = sessionKey !== null;
  host.status("Checking...");
  let findings: AnalysisFinding[];
  try {
    const raw = await runtime.staticAnalyze({
      code,
      fileName,
      level,
      ...(input ? { sessionKey } : {}),
    });
    findings = enrichStaticFindings(raw, level, fileName);
  } catch (err) {
    if (stopped(host, input ? STOPPED_BEFORE_INPUT : STOPPED_BEFORE_START)) {
      return "stopped";
    }
    host.say(`Static analysis failed (${errorText(err)}). Running anyway.`, "note");
    return "ran";
  }
  // Called with none too, so a host can clear what the last run found.
  host.staticFindings(findings);
  const errors = findings.filter((finding) => finding.severity === "error").length;
  if (errors === 0) {
    return "ran";
  }
  host.say(
    `Static analysis found ${errors} problem${errors === 1 ? "" : "s"}. ` +
      (input ? "Your input was not run." : "The file was not run."),
    "problem",
  );
  return "blocked";
}

/**
 * Libraries and the files next to the program, then `run`, then the files
 * it changed written back. A Stop pressed while they load ends it before
 * `run` starts; an error `run` throws because of a Stop is reported as the
 * Stop. Any other error is the host's to report.
 */
async function withFiles(
  runtime: PythonRuntime,
  host: RunHost,
  code: string,
  fileName: string,
  stoppedBeforeStart: string,
  run: () => Promise<RunOutcome>,
): Promise<RunOutcome> {
  let mounted = false;
  try {
    await loadPackages(runtime, host, code);
    mounted = await mount(runtime, host);
    if (stopped(host, stoppedBeforeStart)) {
      return "stopped";
    }
    return await run();
  } catch (err) {
    if (stopped(host, "Stopped.")) {
      return "stopped";
    }
    throw err;
  } finally {
    if (mounted) {
      await writeBack(runtime, host, fileName);
    }
  }
}

async function loadPackages(runtime: PythonRuntime, host: RunHost, code: string): Promise<void> {
  if (!needsPackages(code)) {
    return;
  }
  host.status("Loading libraries...");
  try {
    await runtime.ensurePackages(code);
  } catch (err) {
    const message = errorText(err);
    // A SyntaxError here just means the file does not parse; the run itself
    // reports that properly. Nor is a load that Stop interrupted a failure.
    if (!/syntaxerror|invalid syntax/i.test(message) && !host.stopRequested()) {
      host.say(`Could not load libraries (${message}). Continuing; imports may fail.`, "note");
    }
  }
}

/**
 * Mount the files next to the program. Always, even with none to mount,
 * so a previous program's files do not leak into this run.
 */
async function mount(runtime: PythonRuntime, host: RunHost): Promise<boolean> {
  host.status("Loading files...");
  try {
    await runtime.mountWorkspaceFiles(await host.siblingFiles());
    return true;
  } catch (err) {
    host.say(`Could not load files next to this script (${errorText(err)}). open() may fail.`, "note");
    return false;
  }
}

async function writeBack(runtime: PythonRuntime, host: RunHost, fileName: string): Promise<void> {
  try {
    const changed = await runtime.collectWorkspaceFiles();
    if (changed.length === 0) {
      return;
    }
    const written = await host.writeBack(changed);
    if (written.length > 0) {
      host.say(`Saved ${written.join(", ")} next to ${fileName}.`, "note");
    }
  } catch (err) {
    host.say(`Could not save files next to this script (${errorText(err)}).`, "note");
  }
}

/**
 * True if the file has `test_*` functions *and* pytest loaded. Neither
 * failing stops the run: the file just runs without its tests.
 */
async function hasTestsToRun(runtime: PythonRuntime, host: RunHost, code: string): Promise<boolean> {
  try {
    if (!(await runtime.hasTests(code))) {
      return false;
    }
  } catch (err) {
    if (!host.stopRequested()) {
      host.say(`Could not check for tests (${errorText(err)}). Skipping them.`, "note");
    }
    return false;
  }
  host.status("Loading pytest...");
  try {
    await runtime.ensurePytest();
    return true;
  } catch (err) {
    if (!host.stopRequested()) {
      host.say(`Could not load pytest (${errorText(err)}). Skipping tests.`, "note");
    }
    return false;
  }
}

/** The events of running the student's code, with every error explained. */
function programEvents(
  host: RunHost,
  code: string,
  fileName: string,
  level: Level,
): (event: ExecutionEvent) => void {
  return (event) => {
    if (event.kind === "error") {
      host.runtimeFinding(findingForErrorEvent(event, code, fileName, level));
    } else if (event.kind === "testReport") {
      host.event(explainTestReport(event, code, fileName, level));
    } else {
      host.event(event);
    }
  };
}

/** Whether Stop was pressed, saying `text` if it was. */
function stopped(host: RunHost, text: string): boolean {
  if (!host.stopRequested()) {
    return false;
  }
  host.say(text, "problem");
  return true;
}

