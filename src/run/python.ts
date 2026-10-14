import { deliverDisplay, WorkerConnection, type LiveOutput } from "../pyodide/runtime";
import type {
  ExamplarBuildResult,
  ExamplarOutcome,
  ExecutionEventHandler,
  ReactorStep,
  ReplCheckResult,
  ReplEvalRequest,
  RunFileRequest,
  RunResult,
  StaticAnalyzeRequest,
} from "./types";
import { DEFAULT_LEVEL } from "../core/level";
import type { LeftOut, WorkspaceChanges, WorkspaceFile } from "../core/files";
import type { SiblingSource } from "./packages";
import type { AnalysisFinding } from "./finding";

/**
 * Python, as the host uses it: one method per entry point in
 * `src/python`, saying what it takes and what it gives back. Each is a
 * `call` over the worker connection, by the Python function's name.
 */
export class Python extends WorkerConnection {
  /** Run a file: its output, errors and test report arrive through `onEvent`, then `done`. */
  async runFile(request: RunFileRequest, onEvent: ExecutionEventHandler): Promise<void> {
    const { code, fileName, sessionKey, level = DEFAULT_LEVEL, withTests = false } = request;
    const live = { onEvent, fileName };
    const result = await this.call<RunResult>("_pll_run_file", [code, fileName, sessionKey, level, withTests], live);
    deliverRunResult(result, onEvent, fileName);
  }

  /** Evaluate a prompt line against its file's session. */
  async replEval(request: ReplEvalRequest, onEvent: ExecutionEventHandler): Promise<void> {
    const { code, sessionKey, level = DEFAULT_LEVEL } = request;
    const result = await this.call<RunResult>("_pll_repl_eval", [code, sessionKey, level]);
    deliverRunResult(result, onEvent, "<repl>");
  }

  /**
   * Whether `code` is a complete prompt input (`codeop.compile_command`).
   * `whole` judges several lines submitted at once as one input (`exec`),
   * not as a shell line.
   */
  checkReplComplete(code: string, whole = false): Promise<ReplCheckResult> {
    return this.call<ReplCheckResult>("_pll_repl_check", [code, whole]);
  }

  /** True if `code` contains pytest-style `test_*` functions or `Test*` classes. */
  hasTests(code: string): Promise<boolean> {
    return this.call<boolean>("_pll_has_tests", [code]);
  }

  /**
   * Load any Pyodide packages the code imports (pandas, numpy, ...) - it or
   * the student's `.py` files beside it - wherever the import is. A no-op
   * when nothing imported maps to a known package; needs network the first
   * time it loads one.
   */
  async ensurePackages(code: string, siblings: SiblingSource[] = []): Promise<void> {
    const found = await this.call<{ modules: string[]; network: boolean }>("_pll_package_imports", [
      code,
      JSON.stringify(siblings),
    ]);
    await this.request("load", found);
  }

  /** Load pytest; needs network the first time. */
  async ensurePytest(): Promise<void> {
    await this.request("load", { modules: ["pytest"], network: false });
  }

  /**
   * The language level's static checks of a file, each finding worded.
   * None for a level without checks, or a file that does not parse - its
   * run says the SyntaxError.
   */
  staticAnalyze(request: StaticAnalyzeRequest): Promise<AnalysisFinding[]> {
    const { code, level, fileName, sessionKey = null } = request;
    return this.call<AnalysisFinding[]>("_pll_static_findings", [code, level, fileName, sessionKey]);
  }

  /**
   * Copy the files under the program's folder into Pyodide's work directory
   * so `open("data/cars.csv")` / `pd.read_csv("cars.csv")` see them.
   * Replaces any files from a previous mount. `leftOut` are the files a
   * limit kept back, so reading one says why it is not there.
   */
  async mountWorkspaceFiles(files: WorkspaceFile[], leftOut: LeftOut[] = []): Promise<void> {
    await this.request("mount", { files, leftOut });
  }

  /** What Python made, changed and deleted in the work directory since the last mount. */
  collectWorkspaceFiles(): Promise<WorkspaceChanges> {
    return this.request("collect", {});
  }

  /**
   * Compile Examplar wheats and chaffs into a bundle. `sources` is the JSON
   * of `{wheats: {id: source}, chaffs: {id: source}}`. Authoring only; the
   * bytecode is produced by *this* interpreter so its magic number matches
   * by construction.
   */
  examplarBuild(sources: string): Promise<ExamplarBuildResult> {
    return this.call<ExamplarBuildResult>("_pll_examplar_build", [sources]);
  }

  /**
   * Run a student's tests against every implementation in a bundle.
   * `fileName` is the student's file, whose own errors are told from the
   * implementation's.
   */
  examplarRun(testSource: string, bundle: string, fileName: string): Promise<ExamplarOutcome> {
    return this.call<ExamplarOutcome>("_pll_examplar_run", [testSource, bundle, fileName]);
  }

  /**
   * Apply one event to a running reactor and get the frame it produced.
   * `event` is the JSON of `{kind, ...}`; see `Reactor.react`. What its
   * handlers print or show arrives through `output`, as a run's does.
   */
  reactorStep(reactorId: string, event: string, output?: LiveOutput): Promise<ReactorStep> {
    return this.call<ReactorStep>("_pll_reactor_step", [reactorId, event], output);
  }

  /** Show an earlier or later recorded frame, applying no event. */
  reactorSeek(reactorId: string, index: number): Promise<ReactorStep> {
    return this.call<ReactorStep>("_pll_reactor_seek", [reactorId, index]);
  }

  /** Forget a reactor, so its recorded states can be collected. */
  async reactorDispose(reactorId: string): Promise<void> {
    await this.call("_pll_reactor_dispose", [reactorId]);
  }

  /** Forget a session and the names its runs defined. */
  async endSession(sessionKey: string): Promise<void> {
    // A Python that was never started has no sessions to forget, and one
    // started now would only be started to do nothing.
    if (!this.started) return;
    await this.call("_pll_end_session", [sessionKey]);
  }
}

/** What the host asks of Python: `Python`'s public methods, which a test can fake. */
export type PythonRuntime = Pick<Python, keyof Python>;

/**
 * A run's result as the events it is delivered as, in order: what it showed
 * - the canonical, interleaved timeline of every stdout and stderr write and
 * every image and table, so `print("a")`, a table, then `print("b")` arrive
 * in that order; then the prompt line's value, the error it raised, its
 * tests' report, and `done`.
 */
export function deliverRunResult(result: RunResult, onEvent: ExecutionEventHandler, fileName: string): void {
  for (const display of result.displays) {
    deliverDisplay(display, onEvent, fileName);
  }
  if (result.resultRepr !== null) {
    onEvent({ kind: "result", repr: result.resultRepr });
  }
  if (result.error !== null) {
    onEvent({ kind: "error", error: result.error, fileName });
  }
  if (result.tests !== null) {
    onEvent({ kind: "testReport", fileName, ...result.tests });
  }
  onEvent({
    kind: "done",
    ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
    ...(result.stopped ? { stopped: true } : {}),
  });
}
