import { levelHeaderFinding } from "./analyzers/levelHeaderFinding";
import { explainTestReport, findingForErrorEvent } from "./analyzers/runtimeFinding";
import { enrichStaticFindings } from "./analyzers/static/registry";
import type { AnalysisFinding } from "./analyzers/types";
import { runExamplarStep, type ExamplarEntry } from "./examplarPhase";
import type { BundleStore } from "./examplarSource";
import { levelHasStaticChecks, parseLevel, type Level } from "./level";
import { needsPackages, type SiblingSource } from "./packages";
import type { ExecutionEvent, PythonRuntime } from "./types";
import {
  leftOutNotes,
  type Selection,
  type WorkspaceChanges,
  type WriteBackResult,
} from "./workspaceFilePolicy";
import { errorText } from "./errorText";
import { PythonLostError, StoppedError } from "./runtimeErrors";

/**
 * The steps of a run, the same for every host. A file run is: the `#level`
 * line, the level's static checks, libraries, the Examplar check, the files
 * next to the program, the program - followed by its own tests - and
 * writing back the files it changed. A host says only how to show things.
 *
 * Stop (Ctrl+C) is checked between the steps. A Stop lands in whichever
 * step is running, but what was asked for is that nothing more runs; and one
 * pressed while something loads reaches no running Python at all, so the
 * next check is the only thing that will notice it.
 */
export interface RunHost {
  /** The file's level, from its `#level` line. Said first, and only for a file run. */
  level(level: Level): void;
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
  /** The files under the program's folder, to mount where it can open them, and those the limits kept back. */
  siblingFiles(): Promise<Selection>;
  /** Save what the program changed, given what it was given (`siblingFiles`'s `loaded`). */
  writeBack(changes: WorkspaceChanges, loaded: Selection["loaded"]): Promise<WriteBackResult>;
  /** One card of the Examplar check's verdict. */
  examplarCard(entry: ExamplarEntry): void;
  /** Wraps running the program itself (the editor connects `input()` here). */
  aroundProgram?(run: () => Promise<void>): Promise<void>;
}

export interface FilePlan {
  code: string;
  fileName: string;
  sessionKey: string;
  /** Run the file's `test_*` functions after it. */
  runTests: boolean;
  /**
   * Run them even when the Examplar check says the file does not yet define
   * what it is checked for. The panel leaves them out - each would only say
   * a function is missing, under the verdict - but an exit status must not
   * depend on whether the bundle could be fetched.
   */
  testsOfIncompleteFile?: boolean;
  /** Where fetched Examplar bundles are cached, for a file with `#examplar`. */
  bundles: BundleStore;
}

export interface InputPlan {
  code: string;
  sessionKey: string;
  /** The level of the file's last run, which a prompt line is checked at. */
  level: Level;
}

/** How a run ended, and what the student's code did in it. */
export interface RunSummary {
  /** Checks refused it, Stop ended it, or it ran. */
  outcome: "blocked" | "stopped" | "ran";
  /** The program, or the input, raised. */
  raised: boolean;
  /** Tests that failed or raised. */
  testFailures: number;
  /** The status the program ended itself with (`sys.exit(3)`), or null. */
  exitCode: number | null;
}

type Outcome = RunSummary["outcome"];

/** What a Stop ended, said where the run notices it. */
const STOPPED = {
  beforeStart: "Stopped before the program started. Nothing was run.",
  checking: "Stopped while checking your tests. Your own tests and the program were not run.",
  afterChecking: "Stopped before the program started.",
  input: "Stopped. Your input was not run.",
  program: "Stopped. The tests were not run.",
  tests: "Stopped during the tests. The rest of the tests were not run.",
  thrown: "Stopped.",
} as const;

/** Run a whole file. */
export async function runFilePlan(
  runtime: PythonRuntime,
  host: RunHost,
  plan: FilePlan,
): Promise<RunSummary> {
  const { code, fileName, sessionKey } = plan;
  const level = parseLevel(code);
  const tally = new Tally();
  // Checked at every level: a broken `#level` line means the file asked
  // for checks and got none, so the level it fell back to is the symptom -
  // and not one to show as the file's.
  const header = levelHeaderFinding(code, fileName, level);
  if (header !== null) {
    host.staticFindings([header]);
    host.say("The file was not run.", "problem");
    return tally.summary("blocked");
  }
  host.level(level);
  const checked = await staticChecks(runtime, host, code, fileName, level, null);
  if (checked !== "passed") {
    return tally.summary(checked);
  }
  const beforeStart = STOPPED.beforeStart;
  const outcome = await withFiles(runtime, host, fileName, beforeStart, async (files, starting) => {
    await loadPackages(runtime, host, code, await files.sources());
    if (stopped(host, STOPPED.beforeStart)) {
      return "stopped";
    }
    // Before the files are mounted: the known implementations run without
    // access to the student's files.
    const complete = await runExamplarStep(runtime, plan.bundles, host, code, fileName);
    if (complete !== null && stopped(host, STOPPED.checking)) {
      return "stopped";
    }
    const beforeProgram = complete === null ? STOPPED.beforeStart : STOPPED.afterChecking;
    await files.mount();
    // With an Examplar check, the file's own tests run only once the file
    // defines everything the check provides - against missing functions
    // every test would report a NameError under a perfectly good verdict -
    // unless the host wants them regardless (`testsOfIncompleteFile`).
    const withTests =
      plan.runTests &&
      (complete !== false || plan.testsOfIncompleteFile === true) &&
      (await testsToRun(runtime, host, code));
    if (stopped(host, beforeProgram)) {
      return "stopped";
    }
    host.status("Running...");
    starting();
    const onEvent = tally.counting(programEvents(host, code, fileName, level));
    const program = () =>
      runtime.runFile({ code, fileName, sessionKey, level, withTests }, onEvent);
    await (host.aroundProgram ? host.aroundProgram(program) : program());
    if (withTests) {
      sayWhyTestsStopped(host, tally);
    }
    // Stopped if a Stop reached the program, even one it caught - which
    // still ends the run, before its tests. One that arrives as the last
    // test finishes stops nothing.
    const stopEnded = tally.testsStopped || tally.stopReached || (tally.raised && host.stopRequested());
    return stopEnded ? "stopped" : "ran";
  });
  return tally.summary(outcome);
}

/** Run what was typed at the prompt. */
export async function runInputPlan(
  runtime: PythonRuntime,
  host: RunHost,
  plan: InputPlan,
): Promise<RunSummary> {
  const { code, sessionKey, level } = plan;
  const fileName = "<repl>";
  const tally = new Tally();
  const checked = await staticChecks(runtime, host, code, fileName, level, sessionKey);
  if (checked !== "passed") {
    return tally.summary(checked);
  }
  const outcome = await withFiles(runtime, host, fileName, STOPPED.input, async (files, starting) => {
    await loadPackages(runtime, host, code, await files.sources());
    await files.mount();
    if (stopped(host, STOPPED.input)) {
      return "stopped";
    }
    starting();
    const onEvent = tally.counting(programEvents(host, code, fileName, level));
    await runtime.replEval({ code, sessionKey, level }, onEvent);
    return "ran";
  });
  return tally.summary(outcome);
}

/** What the student's code did, counted from its events as they pass. */
class Tally {
  raised = false;
  testFailures = 0;
  exitCode: number | null = null;
  testsRan = false;
  testsStopped = false;
  stopReached = false;

  counting(onEvent: (event: ExecutionEvent) => void): (event: ExecutionEvent) => void {
    return (event) => {
      if (event.kind === "error") {
        this.raised = true;
      } else if (event.kind === "testReport") {
        this.testsRan = true;
        this.testsStopped = event.stopped === true;
        this.testFailures += event.failed + event.errors;
      } else if (event.kind === "done") {
        if (event.exitCode !== undefined) this.exitCode = event.exitCode;
        if (event.stopped) this.stopReached = true;
      }
      onEvent(event);
    };
  }

  summary(outcome: Outcome): RunSummary {
    return {
      outcome,
      raised: this.raised,
      testFailures: this.testFailures,
      exitCode: this.exitCode,
    };
  }
}

/**
 * Tests run only once the program has finished, so a program that did not
 * finish leaves them unrun - which is said, and why, rather than left to be
 * noticed as a missing report.
 */
function sayWhyTestsStopped(host: RunHost, tally: Tally): void {
  if (tally.testsRan) {
    if (tally.testsStopped) host.say(STOPPED.tests, "problem");
    return;
  }
  if (host.stopRequested()) {
    host.say(STOPPED.program, "problem");
  } else if (tally.exitCode !== null) {
    host.say("The tests were not run: the program ended itself first, with `sys.exit()`.", "problem");
  } else if (tally.raised) {
    host.say("The tests were not run, because of the error above.", "problem");
  }
}

/**
 * The level's static checks. Warnings are shown and the run goes on; an
 * error stops it. A checker that fails does not - unless what ended it was
 * a Stop, which is said as the Stop, not as a broken checker.
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
): Promise<"passed" | "blocked" | "stopped"> {
  if (!levelHasStaticChecks(level)) {
    return "passed";
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
    if (err instanceof StoppedError) {
      host.say(input ? STOPPED.input : STOPPED.beforeStart, "problem");
      return "stopped";
    }
    host.say(`Static analysis failed (${errorText(err)}). Running anyway.`, "note");
    return "passed";
  }
  // Called with none too, so a host can clear what the last run found.
  host.staticFindings(findings);
  const errors = findings.filter((finding) => finding.severity === "error").length;
  if (errors === 0) {
    return "passed";
  }
  host.say(
    `Static analysis found ${errors} problem${errors === 1 ? "" : "s"}. ` +
      (input ? "Your input was not run." : "The file was not run."),
    "problem",
  );
  return "blocked";
}

/** The files next to the program, as a run uses them. */
interface ProgramFiles {
  /** The student's `.py` files among them, whose imports need packages too. */
  sources(): Promise<SiblingSource[]>;
  /** Give them all to Python. */
  mount(): Promise<void>;
}

/**
 * `run`, given the files next to the program and a way to say the program
 * is starting, and then the files it changed written back - if they were
 * mounted, and Python is still there to ask. The files are chosen once,
 * when first asked for. An error `run` throws because of a Stop is
 * reported as the Stop - `beforeStart` if the program had not started; any
 * other error is the host's to report.
 */
async function withFiles(
  runtime: PythonRuntime,
  host: RunHost,
  fileName: string,
  beforeStart: string,
  run: (files: ProgramFiles, starting: () => void) => Promise<Outcome>,
): Promise<Outcome> {
  let mounted: Selection | null = null;
  let started = false;
  let lost = false;
  let selecting: Promise<Selection> | null = null;
  const select = () => (selecting ??= host.siblingFiles());
  const files: ProgramFiles = {
    async sources() {
      try {
        return pythonSources(await select());
      } catch (err) {
        if (err instanceof StoppedError) throw err;
        // Said when they are mounted.
        return [];
      }
    },
    async mount() {
      mounted = await mount(runtime, host, select);
    },
  };
  try {
    return await run(files, () => {
      started = true;
    });
  } catch (err) {
    lost = err instanceof PythonLostError;
    if (err instanceof StoppedError) {
      host.say(started ? STOPPED.thrown : beforeStart, "problem");
      return "stopped";
    }
    throw err;
  } finally {
    if (mounted !== null && !lost) {
      await writeBack(runtime, host, fileName, mounted);
    }
  }
}

/** The student's `.py` files among those beside the program, as text. */
function pythonSources(selection: Selection): SiblingSource[] {
  const decoder = new TextDecoder();
  return selection.files
    .filter((file) => file.name.endsWith(".py"))
    .map((file) => ({
      name: file.name,
      text: typeof file.contents === "string" ? file.contents : decoder.decode(file.contents),
    }));
}

async function loadPackages(
  runtime: PythonRuntime,
  host: RunHost,
  code: string,
  siblings: SiblingSource[],
): Promise<void> {
  if (!needsPackages(code, siblings)) {
    return;
  }
  host.status("Loading libraries...");
  try {
    await runtime.ensurePackages(code, siblings);
  } catch (err) {
    // A load that Stop interrupted is the Stop, which the next check says.
    if (!(err instanceof StoppedError)) {
      host.say(`Could not load libraries (${errorText(err)}). Continuing; imports may fail.`, "note");
    }
  }
}

/**
 * Mount the files next to the program. Always, even with none to mount,
 * so a previous program's files do not leak into this run.
 */
async function mount(
  runtime: PythonRuntime,
  host: RunHost,
  select: () => Promise<Selection>,
): Promise<Selection | null> {
  host.status("Loading files...");
  try {
    const selection = await select();
    await runtime.mountWorkspaceFiles(selection.files, selection.leftOut);
    // A problem, not a note: a program that opens one fails, and this is why.
    for (const note of leftOutNotes(selection.leftOut, "loaded")) {
      host.say(note, "problem");
    }
    return selection;
  } catch (err) {
    if (err instanceof StoppedError) {
      throw err;
    }
    host.say(`Could not load files next to this script (${errorText(err)}). open() may fail.`, "note");
    return null;
  }
}

async function writeBack(
  runtime: PythonRuntime,
  host: RunHost,
  fileName: string,
  mounted: Selection,
): Promise<void> {
  try {
    const changes = await runtime.collectWorkspaceFiles();
    if (changes.files.length === 0 && changes.deleted.length === 0) {
      return;
    }
    const { written, deleted, leftOut } = await host.writeBack(changes, mounted.loaded);
    if (written.length > 0) {
      host.say(`Saved ${written.join(", ")} next to ${fileName}.`, "note");
    }
    if (deleted.length > 0) {
      host.say(`Deleted ${deleted.join(", ")} next to ${fileName}.`, "note");
    }
    // A problem: what the program wrote is not where it wrote it.
    for (const note of leftOutNotes(leftOut, "saved")) {
      host.say(note, "problem");
    }
  } catch (err) {
    host.say(`Could not save files next to this script (${errorText(err)}).`, "problem");
  }
}

/**
 * True if the file has `test_*` functions *and* pytest loaded. Neither
 * failing stops the run: the file just runs without its tests.
 */
async function testsToRun(runtime: PythonRuntime, host: RunHost, code: string): Promise<boolean> {
  try {
    if (!(await runtime.hasTests(code))) {
      return false;
    }
  } catch (err) {
    if (!(err instanceof StoppedError)) {
      host.say(`Could not check for tests (${errorText(err)}). Skipping them.`, "note");
    }
    return false;
  }
  host.status("Loading pytest...");
  try {
    await runtime.ensurePytest();
    return true;
  } catch (err) {
    if (!(err instanceof StoppedError)) {
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
